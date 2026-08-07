import Foundation
import HealthKit

/// Shared multi-group foreground (and BG reimport) pipeline:
/// start-import → auth → fetch+enqueue → drain → ready (when pending==0).
///
/// Not MainActor — safe for ViewModel Tasks and background handlers.
enum HealthKitSyncCoordinator {
    /// Stable processing order: vitals first, then sleep.
    static let groupOrder: [HealthKitSyncMetric] = [.vitals, .sleep, .workouts]

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

    /// API hooks injected by the caller (FG ViewModel or BG helper).
    struct Dependencies: Sendable {
        let startImport: @Sendable (_ group: String) async throws -> Void
        let markReady: @Sendable (_ group: String) async throws -> Void
        let postBatch: @Sendable (HealthKitOpsBatchRequest) async throws -> HealthKitOpsBatchResult
        let ensureAuth: @Sendable (Set<HealthKitSyncMetric>) async throws -> Void
        let healthTimezone: String
        /// When true, BP empty still errors; sleep empty is always OK.
        let allowEmptySleep: Bool

        init(
            startImport: @escaping @Sendable (_ group: String) async throws -> Void,
            markReady: @escaping @Sendable (_ group: String) async throws -> Void,
            postBatch: @escaping @Sendable (HealthKitOpsBatchRequest) async throws -> HealthKitOpsBatchResult,
            ensureAuth: @escaping @Sendable (Set<HealthKitSyncMetric>) async throws -> Void,
            healthTimezone: String,
            allowEmptySleep: Bool = true
        ) {
            self.startImport = startImport
            self.markReady = markReady
            self.postBatch = postBatch
            self.ensureAuth = ensureAuth
            self.healthTimezone = healthTimezone
            self.allowEmptySleep = allowEmptySleep
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
        try await deps.startImport(groupKey)
        try syncStore.setGroupStatus(groupKey, status: "syncing")

        let sampleCount: Int
        do {
            sampleCount = try await fetchAndEnqueue(group: group, syncStore: syncStore, healthTimezone: deps.healthTimezone)
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

        let worker = HealthKitSyncWorker(store: syncStore, postBatch: deps.postBatch)
        CrashReporting.healthKit(.drainStarted, group: groupKey, count: try syncStore.pendingCount(group: groupKey))

        let applied: Int
        do {
            applied = try await worker.drain()
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

        try await deps.markReady(groupKey)
        try syncStore.setGroupStatus(groupKey, status: "ready")
        CrashReporting.healthKit(.groupReady, group: groupKey, metric: scopeMetric(for: group))

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

    /// Maps HealthKit auth/query failures to user-facing API errors (metric-agnostic).
    static func mapAuthError(_ error: Error) -> HealthAPIError {
        if let api = error as? HealthAPIError {
            return api
        }
        let ns = error as NSError
        let isHealthKit = ns.domain == HKError.errorDomain || ns.domain == "com.apple.healthkit"
        let notDetermined =
            isHealthKit && ns.code == HKError.Code.errorAuthorizationNotDetermined.rawValue
        let denied = isHealthKit && ns.code == HKError.Code.errorAuthorizationDenied.rawValue

        if notDetermined {
            return .badStatus(
                403,
                "Health permission is not set yet. When the Health sheet appears, turn ON the types Kinstead requests. If no sheet appears: Settings → Health → Data Access & Devices → Kinstead → enable the types you want to sync, then Sync again.",
                code: "healthkit_auth_not_determined"
            )
        }
        if denied {
            return .badStatus(
                403,
                "Health access was denied. Open Settings → Health → Data Access & Devices → Kinstead and enable the metrics you want to sync, then Sync again.",
                code: "healthkit_auth_denied"
            )
        }
        return .badStatus(
            403,
            "Health access failed: \(ns.localizedDescription). Open Settings → Health → Data Access & Devices → Kinstead, enable the needed types, then Sync again.",
            code: "healthkit_auth_failed"
        )
    }
}
