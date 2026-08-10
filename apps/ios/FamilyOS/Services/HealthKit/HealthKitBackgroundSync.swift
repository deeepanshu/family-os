import BackgroundTasks
import Foundation
import HealthKit

/// Background HealthKit pipeline (nonisolated — never MainActor-owned).
///
/// Background execution is routine `Sync` only (plan §6.7): incremental range,
/// never deletes, never starts a history import, never shows authorization UI,
/// and serializes through the same process-wide run gate as foreground work.
///
/// Fail soft: never crash; log stages via CrashReporting only.
enum HealthKitBackgroundSync {
    static let taskIdentifier = "com.deepanshujain.familyos.healthkit-sync"

    /// Steps ships foreground-only first. Do not let adding a foreground metric
    /// widen the existing bounded background sync path.
    private static let backgroundMetrics: Set<HealthKitSyncMetric> = [.vitals, .sleep, .workouts]

    private static let healthStore = HKHealthStore()

    /// Mutable observer bookkeeping — `@unchecked Sendable` + lock (never touch from MainActor isolation).
    private final class ObserverState: @unchecked Sendable {
        private let lock = NSLock()
        private var queries: [HKObserverQuery] = []

        func replaceAll(with newQueries: [HKObserverQuery], stoppingOn store: HKHealthStore) {
            lock.lock()
            let old = queries
            queries = newQueries
            lock.unlock()
            for query in old {
                store.stop(query)
            }
        }
    }

    private static let observerState = ObserverState()

    // MARK: - Launch

    /// Call from `application(_:didFinishLaunchingWithOptions:)` — must be nonisolated.
    nonisolated static func registerBackgroundTask() {
        BGTaskScheduler.shared.register(forTaskWithIdentifier: taskIdentifier, using: nil) { task in
            guard let processing = task as? BGProcessingTask else {
                CrashReporting.log("healthkit_bg_unexpected_task_type")
                task.setTaskCompleted(success: false)
                return
            }
            handleProcessingTask(processing)
        }
        CrashReporting.log("healthkit_bg_task_registered")
    }

    nonisolated static func scheduleBackgroundSync() {
        let request = BGProcessingTaskRequest(identifier: taskIdentifier)
        request.requiresNetworkConnectivity = true
        request.requiresExternalPower = false
        do {
            try BGTaskScheduler.shared.submit(request)
            CrashReporting.log("healthkit_bg_task_scheduled")
        } catch {
            CrashReporting.log("healthkit_bg_task_schedule_failed \(error.localizedDescription)")
        }
    }

    // MARK: - Delivery + observer reconciliation

    /// Reconcile HealthKit background delivery and observer queries with the
    /// canonical enabled set (plan §6.7): disabled metrics lose their observers
    /// and background delivery; enabled metrics keep or gain them.
    static func reconcileDeliveryAndObservers(for metrics: Set<HealthKitSyncMetric>) async {
        guard HKHealthStore.isHealthDataAvailable() else { return }
        #if DEBUG
        if ProcessInfo.processInfo.arguments.contains("-FamilyOSLocalSmoke") {
            CrashReporting.log("healthkit_bg_delivery_skipped_local_smoke")
            return
        }
        #endif

        let enabled = metrics.intersection(backgroundMetrics)
        let wantedTypes = Set(backgroundTypes(for: enabled))
        let allTypes = Set(backgroundTypes(for: backgroundMetrics))
        let unwantedTypes = allTypes.subtracting(wantedTypes)

        // Stop observing / delivering types no longer enabled.
        for type in unwantedTypes {
            await withCheckedContinuation { (cont: CheckedContinuation<Void, Never>) in
                healthStore.disableBackgroundDelivery(for: type) { _, _ in
                    cont.resume()
                }
            }
            CrashReporting.log("healthkit_bg_delivery_disabled type=\(type.identifier)")
        }

        for type in wantedTypes {
            do {
                try await withCheckedThrowingContinuation { (cont: CheckedContinuation<Void, Error>) in
                    healthStore.enableBackgroundDelivery(for: type, frequency: .immediate) { success, error in
                        if let error {
                            cont.resume(throwing: error)
                        } else if success {
                            cont.resume()
                        } else {
                            cont.resume(
                                throwing: NSError(
                                    domain: "HealthKitBackgroundSync",
                                    code: 1,
                                    userInfo: [NSLocalizedDescriptionKey: "enableBackgroundDelivery failed"]
                                )
                            )
                        }
                    }
                }
                CrashReporting.log("healthkit_bg_delivery_enabled type=\(type.identifier)")
            } catch {
                CrashReporting.healthKitNonFatal(
                    .fetchFailed,
                    stage: .syncFailed,
                    message: "bg_delivery_enable_failed",
                    underlying: error
                )
            }
        }

        startObservers(for: Array(wantedTypes))
        if !wantedTypes.isEmpty {
            scheduleBackgroundSync()
        }
    }

    /// Back-compat shim for older call sites: reconcile enables the given set.
    static func enableDeliveryAndObservers(for metrics: Set<HealthKitSyncMetric>) async {
        await reconcileDeliveryAndObservers(for: metrics)
    }

    /// Launch-time reconciliation from the locally saved configuration — stops
    /// observers/delivery for metrics disabled while the app was not running.
    static func reconcileFromLocalStore() async {
        do {
            let store = try HealthKitSyncStore.shared
            guard let config = try store.configuration() else { return }
            let enabled = decodeEnabledGroups(config.enabledGroupsJSON)
            await reconcileDeliveryAndObservers(for: enabled)
        } catch {
            CrashReporting.healthKitNonFatal(
                .storeOpenFailed,
                stage: .storeOpenFailed,
                message: "bg_reconcile_launch_failed",
                underlying: error
            )
        }
    }

    private static func backgroundTypes(for metrics: Set<HealthKitSyncMetric>) -> [HKSampleType] {
        var types: [HKSampleType] = []
        if metrics.contains(.sleep),
           let sleep = HKObjectType.categoryType(forIdentifier: .sleepAnalysis) {
            types.append(sleep)
        }
        if metrics.contains(.vitals) {
            if let sys = HKObjectType.quantityType(forIdentifier: .bloodPressureSystolic) {
                types.append(sys)
            }
            if let dia = HKObjectType.quantityType(forIdentifier: .bloodPressureDiastolic) {
                types.append(dia)
            }
            if let hr = HKObjectType.quantityType(forIdentifier: .heartRate) {
                types.append(hr)
            }
        }
        if metrics.contains(.workouts) {
            types.append(HKObjectType.workoutType())
        }
        return types
    }

    private static func startObservers(for types: [HKSampleType]) {
        var built: [HKObserverQuery] = []
        for type in types {
            let query = HKObserverQuery(sampleType: type, predicate: nil) { _, completionHandler, error in
                if let error {
                    CrashReporting.log(
                        "healthkit_observer_error type=\(type.identifier) \(error.localizedDescription)"
                    )
                    completionHandler()
                    return
                }
                CrashReporting.log("healthkit_observer_fired type=\(type.identifier)")
                // Acknowledge delivery promptly. Do NOT start a full multi-metric
                // runBoundedSync here: that holds the process-wide run gate and
                // races user Import/Sync (SQLITE + "run already in progress",
                // and leaves server status stuck on `syncing` / Interrupted).
                // Background work is scheduled for a later BG processing wake.
                completionHandler()
                scheduleBackgroundSync()
            }
            healthStore.execute(query)
            built.append(query)
        }
        observerState.replaceAll(with: built, stoppingOn: healthStore)
    }

    // MARK: - BG task + foreground drain

    /// Holds BGProcessingTask for cross-isolation completion (Apple's type is not Sendable).
    private final class BGTaskHandle: @unchecked Sendable {
        let task: BGProcessingTask
        private let lock = NSLock()
        private var didComplete = false

        init(_ task: BGProcessingTask) {
            self.task = task
        }

        func complete(success: Bool) {
            lock.lock()
            defer { lock.unlock() }
            guard !didComplete else { return }
            didComplete = true
            task.setTaskCompleted(success: success)
        }
    }

    private static func handleProcessingTask(_ task: BGProcessingTask) {
        scheduleBackgroundSync() // chain next opportunity
        let handle = BGTaskHandle(task)
        task.expirationHandler = {
            handle.complete(success: false)
            CrashReporting.log("healthkit_bg_task_expired")
        }
        Task {
            await runBoundedSync(reason: "bg_task")
            handle.complete(success: true)
            CrashReporting.log("healthkit_bg_task_completed")
        }
    }

    /// Lightweight path for app become-active: drain pending ops if config exists (no import).
    static func drainIfConfigured() async {
        do {
            let store = try HealthKitSyncStore.shared
            guard try store.configuration() != nil else {
                CrashReporting.log("healthkit_fg_drain_skip_no_config")
                return
            }
            guard let token = try? loadAccessToken(), !token.isEmpty else {
                CrashReporting.log("healthkit_fg_drain_skip_no_token")
                return
            }
            let baseURL = loadBaseURL()
            let client = HealthAPIClient()
            let worker = HealthKitSyncWorker(store: store) { batch in
                try await client.postHealthKitOpsBatch(
                    baseURL: baseURL,
                    accessToken: token,
                    body: batch
                )
            }
            let applied = try await worker.drain()
            CrashReporting.healthKit(
                .drainFinished,
                extra: ["reason": "become_active", "applied": String(applied)]
            )
        } catch {
            CrashReporting.healthKitNonFatal(
                .batchFailed,
                stage: .drainBatch,
                message: "fg_drain_failed",
                underlying: error
            )
        }
    }

    /// Incremental routine sync for each saved enabled group whose initial
    /// import is complete. Never imports history, never deletes, never shows
    /// authorization UI, and serializes through the shared run gate.
    static func runBoundedSync(reason: String) async {
        CrashReporting.healthKit(.syncStarted, extra: ["reason": reason, "mode": "background"])
        do {
            let store = try HealthKitSyncStore.shared
            guard let config = try store.configuration() else {
                CrashReporting.log("healthkit_bg_sync_skip_no_config")
                return
            }
            guard let token = try? loadAccessToken(), !token.isEmpty else {
                CrashReporting.log("healthkit_bg_sync_skip_no_token")
                return
            }

            let enabled = decodeEnabledGroups(config.enabledGroupsJSON)
                .intersection(HealthKitSyncMetric.productMetrics)
            guard !enabled.isEmpty else {
                CrashReporting.log("healthkit_bg_sync_skip_no_groups")
                return
            }

            // Skip metrics whose initial import is incomplete — background work
            // never turns into a hidden history import (plan §6.7).
            let needingImport = try store.groupsNeedingInitialImport()
            let eligibility = incrementalEligibility(
                enabled: enabled,
                needingInitialImport: needingImport
            )
            let eligible = eligibility.eligible
            let skipped = eligibility.skipped
            if !skipped.isEmpty {
                CrashReporting.log(
                    "healthkit_bg_sync_skip_needs_import groups=\(skipped.map(\.rawValue).joined(separator: ","))"
                )
            }
            guard !eligible.isEmpty else {
                CrashReporting.log("healthkit_bg_sync_skip_all_need_import")
                return
            }

            let baseURL = loadBaseURL()
            let client = HealthAPIClient()
            let accessToken = token
            let personId = config.personId
            let installationId = config.installationId
            let timezoneVersion = config.timezoneVersion
            let healthTimezone = config.healthTimezone

            let deps = HealthKitRunDependencies(
                beginRun: { metric, kind in
                    try await client.beginHealthKitRun(
                        baseURL: baseURL,
                        accessToken: accessToken,
                        group: metric.rawValue,
                        installationId: installationId,
                        personId: personId,
                        timezoneVersion: timezoneVersion,
                        kind: kind.rawValue
                    )
                },
                completeRun: { metric, kind, descriptor, presentNaturalKeys in
                    try await client.completeHealthKitRun(
                        baseURL: baseURL,
                        accessToken: accessToken,
                        group: metric.rawValue,
                        installationId: installationId,
                        personId: personId,
                        timezoneVersion: timezoneVersion,
                        kind: kind.rawValue,
                        rangeStartAt: descriptor.rangeStartAt,
                        rangeEndAt: descriptor.rangeEndAt,
                        presentNaturalKeys: presentNaturalKeys
                    )
                },
                postBatch: { batch in
                    try await client.postHealthKitOpsBatch(
                        baseURL: baseURL,
                        accessToken: accessToken,
                        body: batch
                    )
                },
                // A background wake must never request authorization: HealthKit
                // may present its system permission UI. A user-triggered command
                // performs that request; a background query simply succeeds with
                // whatever read access is already granted.
                ensureAuth: { _ in },
                fetchAndEnqueue: HealthKitRunEngine.makeFetchAndEnqueue(
                    syncStore: store,
                    healthTimezone: healthTimezone
                ),
                isEnabled: { eligible.contains($0) },
                needsInitialImport: { needingImport.contains($0.rawValue) }
            )
            let engine = HealthKitRunEngine(syncStore: store, deps: deps)

            do {
                // Never wait: if the user holds the gate, skip quietly.
                try await HealthKitRunGate.shared.withExclusiveRun(waitSeconds: 0) {
                    for metric in eligible {
                        do {
                            _ = try await engine.run(HealthKitRunRequest(metric: metric, kind: .sync))
                        } catch {
                            // One metric's failure never stops later eligible metrics.
                            CrashReporting.healthKitNonFatal(
                                .syncFailed,
                                stage: .syncFailed,
                                message: "bg_metric_sync_failed_continue",
                                group: metric.rawValue,
                                metric: metric.scopeMetricKey,
                                underlying: error
                            )
                        }
                    }
                }
            } catch HealthKitRunError.runInProgress {
                CrashReporting.log("healthkit_bg_sync_skip_run_in_progress")
                return
            }
            CrashReporting.healthKit(.syncCompleted, extra: ["reason": reason, "mode": "background"])
        } catch {
            CrashReporting.healthKitNonFatal(
                .syncFailed,
                stage: .syncFailed,
                message: "bg_bounded_sync_failed",
                underlying: error
            )
        }
    }

    // MARK: - Auth / config helpers (Keychain + defaults — no MainActor)

    private static func decodeEnabledGroups(_ json: String) -> Set<HealthKitSyncMetric> {
        guard let data = json.data(using: .utf8),
              let decoded = try? JSONDecoder().decode([String].self, from: data) else {
            return []
        }
        return Set(decoded.compactMap { HealthKitSyncMetric(rawValue: $0) })
    }

    /// Pure policy seam for background tests: only already-imported metrics may
    /// run incrementally, in the same fixed product order as foreground Sync all.
    static func incrementalEligibility(
        enabled: Set<HealthKitSyncMetric>,
        needingInitialImport: Set<String>
    ) -> (eligible: [HealthKitSyncMetric], skipped: [HealthKitSyncMetric]) {
        let eligible = HealthKitSyncAllRunner.metricOrder.filter {
            backgroundMetrics.contains($0) && enabled.contains($0) && !needingInitialImport.contains($0.rawValue)
        }
        let skipped = HealthKitSyncAllRunner.metricOrder.filter {
            enabled.contains($0) && (!backgroundMetrics.contains($0) || needingInitialImport.contains($0.rawValue))
        }
        return (eligible, skipped)
    }

    private static func loadAccessToken() throws -> String? {
        try KeychainStore().string(for: DefaultsKey.accessToken)
    }

    private static func loadBaseURL() -> String {
        if let saved = UserDefaults.standard.string(forKey: DefaultsKey.baseURL)?
            .trimmingCharacters(in: .whitespacesAndNewlines),
           !saved.isEmpty {
            return saved
        }
        return AppEnvironment.current.apiBaseURL
    }
}
