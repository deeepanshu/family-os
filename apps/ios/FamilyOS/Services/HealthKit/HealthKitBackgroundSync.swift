import BackgroundTasks
import Foundation
import HealthKit
import UIKit
import UserNotifications

/// Background HealthKit pipeline (nonisolated — never MainActor-owned).
///
/// Background execution is routine `Sync` only (plan §6.7): incremental range,
/// never deletes, never starts a history import, never shows authorization UI,
/// and serializes through the same process-wide run gate as foreground work.
///
/// Fail soft: never crash; log stages via CrashReporting only.
enum HealthKitBackgroundSync {
    static let taskIdentifier = "com.deepanshujain.familyos.healthkit-sync"
    static let refreshTaskIdentifier = "com.deepanshujain.familyos.healthkit-refresh"
    static let observerWallTimeoutSeconds: TimeInterval = 25

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

    private final class WorkBox: @unchecked Sendable {
        private let lock = NSLock()
        private var task: Task<Void, Never>?

        func replace(_ task: Task<Void, Never>) {
            lock.lock()
            self.task = task
            lock.unlock()
        }

        func cancel() {
            lock.lock()
            let running = task
            task = nil
            lock.unlock()
            running?.cancel()
        }
    }

    private static let processingWork = WorkBox()
    private static let refreshWork = WorkBox()

    /// Scene-phase mirror so observers never read `UIApplication` (MainActor).
    private final class SceneState: @unchecked Sendable {
        private let lock = NSLock()
        private var isActive = false

        func setActive(_ active: Bool) {
            lock.lock()
            isActive = active
            lock.unlock()
        }

        var active: Bool {
            lock.lock()
            defer { lock.unlock() }
            return isActive
        }
    }

    private static let sceneState = SceneState()

    static func setSceneActive(_ active: Bool) {
        sceneState.setActive(active)
    }

    static func sceneIsActive() -> Bool {
        sceneState.active
    }

    static func currentApplicationState() -> UIApplication.State {
        sceneState.active ? .active : .background
    }

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
        BGTaskScheduler.shared.register(forTaskWithIdentifier: refreshTaskIdentifier, using: nil) { task in
            guard let refresh = task as? BGAppRefreshTask else {
                CrashReporting.log("healthkit_bg_unexpected_refresh_type")
                task.setTaskCompleted(success: false)
                return
            }
            handleRefreshTask(refresh)
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

    nonisolated static func scheduleAppRefresh() {
        let request = BGAppRefreshTaskRequest(identifier: refreshTaskIdentifier)
        request.earliestBeginDate = Date(timeIntervalSinceNow: 15 * 60)
        do {
            try BGTaskScheduler.shared.submit(request)
            CrashReporting.log("healthkit_bg_refresh_scheduled")
        } catch {
            CrashReporting.log("healthkit_bg_refresh_schedule_failed \(error.localizedDescription)")
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
            scheduleAppRefresh()
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
            if let resting = HKObjectType.quantityType(forIdentifier: .restingHeartRate) {
                types.append(resting)
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
                let appState = currentApplicationState()
                var enabled: Set<HealthKitSyncMetric> = []
                var needing: Set<String> = []
                if let store = try? HealthKitSyncStore.shared, let config = try? store.configuration() {
                    enabled = decodeEnabledGroups(config.enabledGroupsJSON)
                    needing = (try? store.groupsNeedingInitialImport()) ?? []
                }
                let action = observerWakeAction(
                    sampleType: type,
                    applicationState: appState,
                    enabled: enabled,
                    needingInitialImport: needing
                )
                CrashReporting.log("healthkit_observer_action \(describe(action)) type=\(type.identifier)")
                // Acknowledge delivery before any engine work so Apple is not held.
                completionHandler()
                handleObserverAction(action)
            }
            healthStore.execute(query)
            built.append(query)
        }
        observerState.replaceAll(with: built, stoppingOn: healthStore)
    }

    // MARK: - Observer policy

    enum ObserverWakeAction: Equatable {
        case ignore
        case scheduleOnly
        case runMetricThenSchedule(HealthKitSyncMetric)
    }

    /// Pure policy seam: one changed sample type maps to at most one incremental
    /// metric, and never starts work while the user is in the foreground.
    static func observerWakeAction(
        sampleType: HKSampleType,
        applicationState: UIApplication.State,
        enabled: Set<HealthKitSyncMetric>,
        needingInitialImport: Set<String>
    ) -> ObserverWakeAction {
        guard let metric = metric(for: sampleType), backgroundMetrics.contains(metric) else {
            return .ignore
        }
        guard enabled.contains(metric) else {
            return .scheduleOnly
        }
        if needingInitialImport.contains(metric.rawValue) {
            return .scheduleOnly
        }
        if applicationState == .active {
            return .scheduleOnly
        }
        return .runMetricThenSchedule(metric)
    }

    static func metric(for sampleType: HKSampleType) -> HealthKitSyncMetric? {
        if let sleep = HKObjectType.categoryType(forIdentifier: .sleepAnalysis), sampleType == sleep {
            return .sleep
        }
        if let sys = HKObjectType.quantityType(forIdentifier: .bloodPressureSystolic), sampleType == sys {
            return .vitals
        }
        if let dia = HKObjectType.quantityType(forIdentifier: .bloodPressureDiastolic), sampleType == dia {
            return .vitals
        }
        if let hr = HKObjectType.quantityType(forIdentifier: .heartRate), sampleType == hr {
            return .vitals
        }
        if let resting = HKObjectType.quantityType(forIdentifier: .restingHeartRate), sampleType == resting {
            return .vitals
        }
        if sampleType == HKObjectType.workoutType() {
            return .workouts
        }
        return nil
    }

    private static func describe(_ action: ObserverWakeAction) -> String {
        switch action {
        case .ignore:
            return "ignore"
        case .scheduleOnly:
            return "schedule_only"
        case .runMetricThenSchedule(let metric):
            return "run:\(metric.rawValue)"
        }
    }

    private static func handleObserverAction(_ action: ObserverWakeAction) {
        switch action {
        case .ignore:
            return
        case .scheduleOnly:
            scheduleBackgroundSync()
            scheduleAppRefresh()
        case .runMetricThenSchedule(let metric):
            scheduleBackgroundSync()
            scheduleAppRefresh()
            Task {
                await runBoundedSync(
                    reason: "observer",
                    metrics: [metric],
                    wallTimeoutSeconds: observerWallTimeoutSeconds
                )
            }
        }
    }

    // MARK: - BG task + foreground drain

    /// Holds Apple BG task objects for cross-isolation completion (they are not Sendable).
    private final class BGProcessingHandle: @unchecked Sendable {
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

    private final class BGRefreshHandle: @unchecked Sendable {
        let task: BGAppRefreshTask
        private let lock = NSLock()
        private var didComplete = false

        init(_ task: BGAppRefreshTask) {
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
        scheduleBackgroundSync()
        scheduleAppRefresh()
        let handle = BGProcessingHandle(task)
        task.expirationHandler = {
            processingWork.cancel()
            handle.complete(success: false)
            CrashReporting.log("healthkit_bg_task_expired")
        }
        let work = Task {
            await runBoundedSync(reason: "bg_task")
            handle.complete(success: true)
            CrashReporting.log("healthkit_bg_task_completed")
        }
        processingWork.replace(work)
    }

    private static func handleRefreshTask(_ task: BGAppRefreshTask) {
        scheduleAppRefresh()
        let handle = BGRefreshHandle(task)
        task.expirationHandler = {
            refreshWork.cancel()
            handle.complete(success: false)
            CrashReporting.log("healthkit_bg_refresh_expired")
        }
        let work = Task {
            await runBoundedSync(reason: "bg_refresh")
            handle.complete(success: true)
            CrashReporting.log("healthkit_bg_refresh_completed")
        }
        refreshWork.replace(work)
    }

    /// Lightweight path for leftover outbox (including activity) after incremental sync.
    static func foregroundDrainBatchSize(hasPendingActivity: Bool) -> Int {
        hasPendingActivity
            ? HealthKitRunEngine.activityInitialImportUploadBatchSize
            : HealthKitRunEngine.uploadBatchSize
    }

    static func drainIfConfigured() async {
        do {
            let store = try HealthKitSyncStore.shared
            guard try store.configuration() != nil else {
                CrashReporting.log("healthkit_fg_drain_skip_no_config")
                return
            }
            guard let token = await HealthSessionRefresher.freshAccessToken(), !token.isEmpty else {
                CrashReporting.log("healthkit_fg_drain_skip_no_token")
                return
            }
            let baseURL = loadBaseURL()
            let client = HealthAPIClient()
            let hasPendingActivity = try store.pendingCount(group: "activity") > 0
            let worker = HealthKitSyncWorker(
                store: store,
                postBatch: { batch in
                    try await HealthSessionRefresher.withFreshHealthToken { accessToken in
                        try await client.postHealthKitOpsBatch(
                            baseURL: baseURL,
                            accessToken: accessToken,
                            body: batch
                        )
                    }
                },
                batchSize: foregroundDrainBatchSize(hasPendingActivity: hasPendingActivity)
            )
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
    static func runBoundedSync(
        reason: String,
        metrics: Set<HealthKitSyncMetric>? = nil,
        wallTimeoutSeconds: TimeInterval? = nil
    ) async {
        CrashReporting.healthKit(.syncStarted, extra: ["reason": reason, "mode": "background"])
        do {
            let store = try HealthKitSyncStore.shared
            guard let config = try store.configuration() else {
                CrashReporting.log("healthkit_bg_sync_skip_no_config")
                return
            }
            guard await HealthSessionRefresher.freshAccessToken() != nil else {
                CrashReporting.log("healthkit_bg_sync_skip_no_token")
                return
            }

            let enabled = decodeEnabledGroups(config.enabledGroupsJSON)
                .intersection(HealthKitSyncMetric.productMetrics)
            let requested = metrics ?? enabled
            let scoped = enabled.intersection(requested)
            guard !scoped.isEmpty else {
                CrashReporting.log("healthkit_bg_sync_skip_no_groups")
                return
            }

            // Skip metrics whose initial import is incomplete — background work
            // never turns into a hidden history import (plan §6.7).
            let needingImport = try store.groupsNeedingInitialImport()
            let eligibility = incrementalEligibility(
                enabled: scoped,
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

            do {
                try await HealthKitDatabaseAccess.assertAccessible()
            } catch {
                CrashReporting.log("healthkit_bg_sync_skip_database_inaccessible reason=\(reason)")
                scheduleBackgroundSync()
                scheduleAppRefresh()
                return
            }

            let baseURL = loadBaseURL()
            let client = HealthAPIClient()
            let personId = config.personId
            let installationId = config.installationId
            let timezoneVersion = config.timezoneVersion
            let healthTimezone = config.healthTimezone

            let deps = HealthKitRunDependencies(
                beginRun: { metric, kind in
                    try await HealthSessionRefresher.withFreshHealthToken { accessToken in
                        try await client.beginHealthKitRun(
                            baseURL: baseURL,
                            accessToken: accessToken,
                            group: metric.rawValue,
                            installationId: installationId,
                            personId: personId,
                            timezoneVersion: timezoneVersion,
                            kind: kind.rawValue
                        )
                    }
                },
                completeRun: { metric, kind, descriptor, presentNaturalKeys in
                    try await HealthSessionRefresher.withFreshHealthToken { accessToken in
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
                    }
                },
                postBatch: { batch in
                    try await HealthSessionRefresher.withFreshHealthToken { accessToken in
                        try await client.postHealthKitOpsBatch(
                            baseURL: baseURL,
                            accessToken: accessToken,
                            body: batch
                        )
                    }
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
                needsInitialImport: { needingImport.contains($0.rawValue) },
                failRun: { metric, kind, errorCode in
                    _ = try await HealthSessionRefresher.withFreshHealthToken { accessToken in
                        try await client.failHealthKitRun(
                            baseURL: baseURL,
                            accessToken: accessToken,
                            group: metric.rawValue,
                            installationId: installationId,
                            personId: personId,
                            timezoneVersion: timezoneVersion,
                            kind: kind.rawValue,
                            errorCode: errorCode
                        )
                    }
                }
            )
            let engine = HealthKitRunEngine(syncStore: store, deps: deps)

            do {
                let waitSeconds = exclusiveWaitSeconds(for: reason)
                try await HealthKitRunGate.shared.withExclusiveRun(waitSeconds: waitSeconds, reason: reason) {
                    let work: @Sendable () async throws -> Void = {
                        let loopStarted = Date()
                        for metric in eligible {
                            if Task.isCancelled {
                                CrashReporting.log(
                                    "healthkit_bg_sync_cancelled reason=\(reason) group=\(metric.rawValue)"
                                )
                                break
                            }
                            let elapsed = Date().timeIntervalSince(loopStarted)
                            if !canStartMetric(elapsed: elapsed, wallTimeoutSeconds: wallTimeoutSeconds) {
                                CrashReporting.log(
                                    "healthkit_bg_sync_skip_no_budget reason=\(reason) group=\(metric.rawValue) elapsed=\(Int(elapsed))"
                                )
                                break
                            }
                            let metricStarted = Date()
                            CrashReporting.log("healthkit_bg_metric_start reason=\(reason) group=\(metric.rawValue)")
                            do {
                                let result = try await engine.run(HealthKitRunRequest(metric: metric, kind: .sync))
                                CrashReporting.log(
                                    "healthkit_bg_metric_complete reason=\(reason) group=\(metric.rawValue) applied=\(result.appliedCount) ms=\(Int(Date().timeIntervalSince(metricStarted) * 1000))"
                                )
                                HealthKitBackgroundSyncAlert.notifyIfNeeded(
                                    metric: metric,
                                    appliedCount: result.appliedCount,
                                    reason: reason
                                )
                            } catch {
                                CrashReporting.log(
                                    "healthkit_bg_metric_failed reason=\(reason) group=\(metric.rawValue) ms=\(Int(Date().timeIntervalSince(metricStarted) * 1000))"
                                )
                                if isLockedHealthKitError(error) {
                                    CrashReporting.log(
                                        "healthkit_bg_sync_skip_database_inaccessible reason=\(reason) group=\(metric.rawValue)"
                                    )
                                    break
                                }
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
                    if let wallTimeoutSeconds {
                        try await HealthKitRunEngine.withTimeout(
                            seconds: wallTimeoutSeconds,
                            label: "\(reason)_wall",
                            operation: work
                        )
                    } else {
                        try await work()
                    }
                }
            } catch HealthKitRunError.runInProgress {
                CrashReporting.log("healthkit_bg_sync_skip_run_in_progress")
                return
            } catch {
                CrashReporting.log("healthkit_observer_sync_timeout \(error.localizedDescription)")
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
    static func isLockedHealthKitError(_ error: Error) -> Bool {
        if HealthKitDatabaseAccess.isInaccessible(error) { return true }
        if case .databaseInaccessible = error as? HealthKitRunError { return true }
        if let api = error as? HealthAPIError, api.errorCode == "healthkit_locked" { return true }
        return false
    }

    static func exclusiveWaitSeconds(for reason: String) -> TimeInterval {
        reason == "become_active" ? 45 : 0
    }

    static func canStartMetric(
        elapsed: TimeInterval,
        wallTimeoutSeconds: TimeInterval?,
        minimumBudgetSeconds: TimeInterval = 5
    ) -> Bool {
        guard let wall = wallTimeoutSeconds else { return true }
        return elapsed + minimumBudgetSeconds <= wall
    }

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

    private static func loadBaseURL() -> String {
        if let saved = UserDefaults.standard.string(forKey: DefaultsKey.baseURL)?
            .trimmingCharacters(in: .whitespacesAndNewlines),
           !saved.isEmpty {
            return saved
        }
        return AppEnvironment.current.apiBaseURL
    }
}

enum HealthKitBackgroundSyncAlert {
    static func shouldNotify(
        reason: String,
        appliedCount: Int,
        alertsEnabled: Bool,
        applicationState: UIApplication.State
    ) -> Bool {
        guard alertsEnabled else { return false }
        guard appliedCount > 0 else { return false }
        guard applicationState != .active else { return false }
        switch reason {
        case "observer", "bg_task", "bg_refresh":
            return true
        default:
            return false
        }
    }

    static func notifyIfNeeded(metric: HealthKitSyncMetric, appliedCount: Int, reason: String) {
        let state = HealthKitBackgroundSync.currentApplicationState()
        let enabled = UserDefaults.standard.bool(forKey: DefaultsKey.healthkitBackgroundSyncAlerts)
        guard shouldNotify(
            reason: reason,
            appliedCount: appliedCount,
            alertsEnabled: enabled,
            applicationState: state
        ) else {
            CrashReporting.log("healthkit_bg_alert_skipped reason=\(reason) applied=\(appliedCount)")
            return
        }

        let content = UNMutableNotificationContent()
        content.title = "\(metric.displayName) synced"
        content.body = appliedCount == 1 ? "1 reading uploaded" : "\(appliedCount) readings uploaded"
        content.sound = .default
        let request = UNNotificationRequest(
            identifier: "healthkit-bg-sync.\(metric.rawValue)",
            content: content,
            trigger: nil
        )
        UNUserNotificationCenter.current().add(request) { error in
            if let error {
                CrashReporting.log("healthkit_bg_alert_failed \(error.localizedDescription)")
            } else {
                CrashReporting.log("healthkit_bg_alert_posted metric=\(metric.rawValue) applied=\(appliedCount)")
            }
        }
    }
}
