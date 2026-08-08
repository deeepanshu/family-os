import Foundation
import HealthKit

/// Shared multi-group foreground (and BG reimport) pipeline:
/// start-import → fetch+enqueue → drain → ready (when pending==0).
///
/// Not MainActor — safe for ViewModel Tasks and background handlers.
enum HealthKitSyncCoordinator {
    /// Stable processing order: vitals first, then sleep.
    static let groupOrder: [HealthKitSyncMetric] = [.vitals, .sleep, .workouts]

    /// Soft timeouts so Sync cannot hang forever on HK query or upload.
    static let fetchTimeoutSeconds: TimeInterval = 90
    static let drainTimeoutSeconds: TimeInterval = 180

    struct GroupSyncSummary: Sendable {
        let group: HealthKitSyncMetric
        let sampleCount: Int
        let applied: Int
    }

    struct GroupSyncFailure: Sendable {
        let group: HealthKitSyncMetric
        let error: HealthAPIError
    }

    struct SyncOutcome: Sendable {
        let groups: [GroupSyncSummary]
        let failures: [GroupSyncFailure]
        var totalSamples: Int { groups.reduce(0) { $0 + $1.sampleCount } }
        var totalApplied: Int { groups.reduce(0) { $0 + $1.applied } }
        var succeededGroups: [HealthKitSyncMetric] { groups.map(\.group) }
    }

    /// User-visible pipeline stages (toasts / status line).
    enum ProgressStage: Sendable {
        case authenticating
        case startingImport(HealthKitSyncMetric)
        case fetching(HealthKitSyncMetric)
        case uploading(HealthKitSyncMetric, sampleCount: Int)
        case markingReady(HealthKitSyncMetric)
        case groupReady(HealthKitSyncMetric, sampleCount: Int, applied: Int)
        case groupFailed(HealthKitSyncMetric, message: String)

        var toastMessage: String {
            switch self {
            case .authenticating:
                return "Requesting Health access…"
            case .startingImport(let group):
                return "\(group.displayName): starting import…"
            case .fetching(let group):
                return "\(group.displayName): reading Apple Health…"
            case .uploading(let group, let sampleCount):
                return "\(group.displayName): uploading \(sampleCount) sample(s)…"
            case .markingReady(let group):
                return "\(group.displayName): finishing…"
            case .groupReady(let group, let sampleCount, let applied):
                return "\(group.displayName): ready (\(sampleCount) samples, \(applied) ops)"
            case .groupFailed(let group, let message):
                return "\(group.displayName) failed: \(message)"
            }
        }
    }

    /// API hooks injected by the caller (FG ViewModel or BG helper).
    struct Dependencies: Sendable {
        let startImport: @Sendable (_ group: String) async throws -> Void
        let markReady: @Sendable (_ group: String) async throws -> Void
        let postBatch: @Sendable (HealthKitOpsBatchRequest) async throws -> HealthKitOpsBatchResult
        let ensureAuth: @Sendable (Set<HealthKitSyncMetric>) async throws -> Void
        let healthTimezone: String
        /// When true, BP empty still errors; sleep empty is always OK.
        let allowEmptySleep: Bool
        let onProgress: (@Sendable (ProgressStage) async -> Void)?

        init(
            startImport: @escaping @Sendable (_ group: String) async throws -> Void,
            markReady: @escaping @Sendable (_ group: String) async throws -> Void,
            postBatch: @escaping @Sendable (HealthKitOpsBatchRequest) async throws -> HealthKitOpsBatchResult,
            ensureAuth: @escaping @Sendable (Set<HealthKitSyncMetric>) async throws -> Void,
            healthTimezone: String,
            allowEmptySleep: Bool = true,
            onProgress: (@Sendable (ProgressStage) async -> Void)? = nil
        ) {
            self.startImport = startImport
            self.markReady = markReady
            self.postBatch = postBatch
            self.ensureAuth = ensureAuth
            self.healthTimezone = healthTimezone
            self.allowEmptySleep = allowEmptySleep
            self.onProgress = onProgress
        }
    }

    static func orderedGroups(from enabled: Set<HealthKitSyncMetric>) -> [HealthKitSyncMetric] {
        groupOrder.filter { enabled.contains($0) }
    }

    /// Run import+drain+ready for each group in `groups` (already filtered to implemented ∩ enabled).
    ///
    /// - **One** HealthKit auth for the whole set (never per-group sheets).
    /// - Auth runs **before** start-import so a hung sheet cannot leave status=`syncing`.
    /// - Groups are isolated: one failure does not skip the rest. Throws only when **every**
    ///   requested group fails (or the list is empty).
    static func run(
        groups: [HealthKitSyncMetric],
        syncStore: HealthKitSyncStore,
        deps: Dependencies
    ) async throws -> SyncOutcome {
        // Auth once for all groups before any start-import.
        do {
            await report(deps, .authenticating)
            try await deps.ensureAuth(Set(groups))
            CrashReporting.healthKit(
                .authRequested,
                extra: ["groups": groups.map(\.rawValue).joined(separator: ",")]
            )
        } catch {
            CrashReporting.healthKitNonFatal(
                .fetchFailed,
                stage: .authRequested,
                message: "healthkit_auth_sync_failed",
                underlying: error
            )
            throw mapAuthError(error)
        }

        var summaries: [GroupSyncSummary] = []
        var failures: [GroupSyncFailure] = []

        for group in groups {
            do {
                let summary = try await runOneGroup(group: group, syncStore: syncStore, deps: deps)
                summaries.append(summary)
            } catch {
                let api = mapAuthError(error)
                failures.append(GroupSyncFailure(group: group, error: api))
                await report(deps, .groupFailed(group, message: api.localizedDescription))
                CrashReporting.healthKitNonFatal(
                    .syncFailed,
                    stage: .syncFailed,
                    message: "group_sync_failed_continue",
                    group: group.rawValue,
                    metric: scopeMetric(for: group),
                    underlying: error
                )
            }
        }

        if summaries.isEmpty, let first = failures.first {
            throw first.error
        }

        return SyncOutcome(groups: summaries, failures: failures)
    }

    private static func runOneGroup(
        group: HealthKitSyncMetric,
        syncStore: HealthKitSyncStore,
        deps: Dependencies
    ) async throws -> GroupSyncSummary {
        let groupKey = group.rawValue
        CrashReporting.healthKit(.importStarted, group: groupKey, metric: scopeMetric(for: group))

        // Auth already completed for the batch. start-import only after that.
        await report(deps, .startingImport(group))
        try await deps.startImport(groupKey)
        try syncStore.setGroupStatus(groupKey, status: "syncing")

        await report(deps, .fetching(group))
        let sampleCount: Int
        do {
            sampleCount = try await withTimeout(seconds: fetchTimeoutSeconds, label: "\(groupKey)_fetch") {
                try await fetchAndEnqueue(group: group, syncStore: syncStore, healthTimezone: deps.healthTimezone)
            }
        } catch let error as HealthAPIError {
            throw error
        } catch {
            CrashReporting.healthKitNonFatal(
                .fetchFailed,
                stage: .samplesFetched,
                message: "\(groupKey)_fetch_failed",
                group: groupKey,
                metric: scopeMetric(for: group),
                underlying: error
            )
            throw mapAuthError(error)
        }

        CrashReporting.healthKit(
            .samplesFetched,
            group: groupKey,
            metric: scopeMetric(for: group),
            count: sampleCount
        )

        if group == .vitals, sampleCount == 0 {
            CrashReporting.healthKitNonFatal(
                .fetchFailed,
                stage: .samplesFetched,
                message: "bp_samples_empty",
                group: "vitals",
                metric: "blood_pressure"
            )
            throw HealthAPIError.badStatus(
                404,
                "No blood pressure readings found in Apple Health for the last 90 days. If you have readings, open Settings → Health → Data Access → this app and turn on Blood Pressure Systolic and Diastolic, then Sync again.",
                code: "bp_samples_empty"
            )
        }
        // Sleep: empty is OK — still proceed to ready after drain.

        CrashReporting.healthKit(
            .samplesEnqueued,
            group: groupKey,
            metric: scopeMetric(for: group),
            count: sampleCount
        )

        await report(deps, .uploading(group, sampleCount: sampleCount))
        let worker = HealthKitSyncWorker(store: syncStore, postBatch: deps.postBatch)
        CrashReporting.healthKit(.drainStarted, group: groupKey, count: try syncStore.pendingCount(group: groupKey))

        let applied: Int
        do {
            applied = try await withTimeout(seconds: drainTimeoutSeconds, label: "\(groupKey)_drain") {
                try await worker.drain()
            }
        } catch {
            CrashReporting.healthKitNonFatal(
                .batchFailed,
                stage: .drainFinished,
                message: "ops_batch_drain_failed",
                group: groupKey,
                metric: scopeMetric(for: group),
                underlying: error
            )
            throw error
        }

        let remaining = try syncStore.pendingCount(group: groupKey)
        CrashReporting.healthKit(
            .drainFinished,
            group: groupKey,
            count: applied,
            extra: ["pending_remaining": String(remaining)]
        )
        guard remaining == 0 else {
            CrashReporting.healthKitNonFatal(
                .queueIncomplete,
                stage: .drainFinished,
                message: "pending_ops_remain_after_drain",
                group: groupKey,
                metric: scopeMetric(for: group)
            )
            throw HealthAPIError.badStatus(
                409,
                "HealthKit \(group.displayName) queue still has \(remaining) pending ops after drain.",
                code: "sync_incomplete"
            )
        }

        await report(deps, .markingReady(group))
        try await deps.markReady(groupKey)
        try syncStore.setGroupStatus(groupKey, status: "ready")
        CrashReporting.healthKit(.groupReady, group: groupKey, metric: scopeMetric(for: group))
        await report(deps, .groupReady(group, sampleCount: sampleCount, applied: applied))

        return GroupSyncSummary(group: group, sampleCount: sampleCount, applied: applied)
    }

    private static func fetchAndEnqueue(
        group: HealthKitSyncMetric,
        syncStore: HealthKitSyncStore,
        healthTimezone: String
    ) async throws -> Int {
        switch group {
        case .vitals:
            let samples = try await HealthKitBloodPressureSync.fetchBloodPressure()
            try HealthKitBloodPressureSync.enqueueSamples(samples, into: syncStore)
            return samples.count
        case .sleep:
            let samples = try await HealthKitSleepDaySync.fetchSleepDays(healthTimezone: healthTimezone)
            try HealthKitSleepDaySync.enqueueSamples(samples, into: syncStore)
            return samples.count
        case .workouts:
            let samples = try await HealthKitWorkoutSync.fetchWorkouts()
            // Empty workout history is OK (same as sleep).
            try HealthKitWorkoutSync.enqueueSamples(samples, into: syncStore)
            return samples.count
        default:
            return 0
        }
    }

    private static func scopeMetric(for group: HealthKitSyncMetric) -> String {
        switch group {
        case .vitals: return "blood_pressure"
        case .sleep: return "sleep"
        case .workouts: return "workout"
        default: return group.rawValue
        }
    }

    private static func report(_ deps: Dependencies, _ stage: ProgressStage) async {
        if let onProgress = deps.onProgress {
            await onProgress(stage)
        }
    }

    private static func withTimeout<T: Sendable>(
        seconds: TimeInterval,
        label: String,
        operation: @escaping @Sendable () async throws -> T
    ) async throws -> T {
        try await withThrowingTaskGroup(of: T.self) { group in
            group.addTask {
                try await operation()
            }
            group.addTask {
                try await Task.sleep(nanoseconds: UInt64(seconds * 1_000_000_000))
                throw HealthAPIError.badStatus(
                    408,
                    "HealthKit step timed out after \(Int(seconds))s (\(label)). Try Sync again.",
                    code: "sync_timeout"
                )
            }
            guard let result = try await group.next() else {
                throw HealthAPIError.badStatus(500, "HealthKit step ended without a result (\(label)).", code: "sync_timeout")
            }
            group.cancelAll()
            return result
        }
    }

    private static func mapAuthError(_ error: Error) -> HealthAPIError {
        if let api = error as? HealthAPIError {
            return api
        }
        return HealthAPIError.badStatus(
            500,
            error.localizedDescription,
            code: (error as NSError).domain == CrashReporting.healthKitErrorDomain
                ? "healthkit_error"
                : "sync_failed"
        )
    }
}
