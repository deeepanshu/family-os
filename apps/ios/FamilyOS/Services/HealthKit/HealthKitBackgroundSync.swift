import BackgroundTasks
import Foundation
import HealthKit

/// Background HealthKit pipeline (nonisolated — never MainActor-owned).
///
/// - Registers BGTask at launch
/// - Enables HK background delivery + observer queries after FG sync
/// - BG / become-active: bounded reimport + drain when config + token exist
///
/// Fail soft: never crash; log stages via CrashReporting only.
enum HealthKitBackgroundSync {
    static let taskIdentifier = "com.deepanshujain.familyos.healthkit-sync"

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

    // MARK: - Delivery + observers (after successful FG sync)

    /// Enable background delivery and observer queries for implemented metrics that are enabled.
    static func enableDeliveryAndObservers(for metrics: Set<HealthKitSyncMetric>) async {
        guard HKHealthStore.isHealthDataAvailable() else { return }
        #if DEBUG
        if ProcessInfo.processInfo.arguments.contains("-FamilyOSLocalSmoke") {
            CrashReporting.log("healthkit_bg_delivery_skipped_local_smoke")
            return
        }
        #endif

        let types = backgroundTypes(for: metrics)
        guard !types.isEmpty else { return }

        for type in types {
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

        startObservers(for: types)
        scheduleBackgroundSync()
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
                completionHandler()
                scheduleBackgroundSync()
                // Best-effort limited reimport while app may be briefly awake.
                Task {
                    await runBoundedSync(reason: "observer")
                }
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

    /// Lightweight path for app become-active: drain pending ops if config exists (no full reimport).
    static func drainIfConfigured() async {
        do {
            let store = try HealthKitSyncStore()
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

    /// Bounded reimport (90d) + drain for each enabled implemented group. Soft-fail.
    static func runBoundedSync(reason: String) async {
        CrashReporting.healthKit(.syncStarted, extra: ["reason": reason, "mode": "background"])
        do {
            let store = try HealthKitSyncStore()
            guard let config = try store.configuration() else {
                CrashReporting.log("healthkit_bg_sync_skip_no_config")
                return
            }
            guard let token = try? loadAccessToken(), !token.isEmpty else {
                CrashReporting.log("healthkit_bg_sync_skip_no_token")
                return
            }

            let enabledRaw: [String]
            if let data = config.enabledGroupsJSON.data(using: .utf8),
               let decoded = try? JSONDecoder().decode([String].self, from: data) {
                enabledRaw = decoded
            } else {
                enabledRaw = []
            }
            let enabled = Set(enabledRaw.compactMap { HealthKitSyncMetric(rawValue: $0) })
            // Local set avoids touching MainActor ViewModel types from BG entry.
            let implemented: Set<HealthKitSyncMetric> = [.vitals, .sleep, .workouts]
            let groups = HealthKitSyncCoordinator.orderedGroups(
                from: enabled.intersection(implemented)
            )
            guard !groups.isEmpty else {
                CrashReporting.log("healthkit_bg_sync_skip_no_groups")
                return
            }

            let baseURL = loadBaseURL()
            let client = HealthAPIClient()
            let accessToken = token
            let personId = config.personId
            let installationId = config.installationId
            let timezoneVersion = config.timezoneVersion
            let healthTimezone = config.healthTimezone

            // Soft auth only — never present UI sheets from BG.
            let healthKitClient = HealthKitClient()
            await healthKitClient.requestAuthorizationSoft(for: Set(groups))

            let deps = HealthKitSyncCoordinator.Dependencies(
                startImport: { group in
                    _ = try await client.startHealthKitImport(
                        baseURL: baseURL,
                        accessToken: accessToken,
                        group: group,
                        installationId: installationId,
                        personId: personId,
                        timezoneVersion: timezoneVersion
                    )
                },
                markReady: { group in
                    _ = try await client.markHealthKitGroupReady(
                        baseURL: baseURL,
                        accessToken: accessToken,
                        group: group,
                        installationId: installationId,
                        personId: personId,
                        timezoneVersion: timezoneVersion
                    )
                },
                postBatch: { batch in
                    try await client.postHealthKitOpsBatch(
                        baseURL: baseURL,
                        accessToken: accessToken,
                        body: batch
                    )
                },
                ensureAuth: { metrics in
                    // BG: do not hard-fail auth; soft request already ran.
                    await healthKitClient.requestAuthorizationSoft(for: metrics)
                },
                healthTimezone: healthTimezone,
                allowEmptySleep: true
            )

            // Per-group isolation: one failure must not block the other.
            for group in groups {
                do {
                    _ = try await HealthKitSyncCoordinator.run(
                        groups: [group],
                        syncStore: store,
                        deps: deps
                    )
                } catch {
                    CrashReporting.healthKitNonFatal(
                        .syncFailed,
                        stage: .syncFailed,
                        message: "bg_group_sync_failed",
                        group: group.rawValue,
                        underlying: error
                    )
                }
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
