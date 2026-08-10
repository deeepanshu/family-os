import Foundation

/// One deep run module for all HealthKit work (plan §6.1): authorization,
/// server-authoritative range selection, HealthKit reads, enqueueing, draining,
/// completion, and progress reporting all live behind this seam.
///
/// Run kinds (plan §3.2):
/// - `initialImport`: first 90-day fill; never deletes.
/// - `sync`: incremental (server returns last success minus 24h); never deletes.
/// - `repairImport`: explicit 90-day repair; only kind that may delete, via
///   server-side missing-key reconciliation at completion.
enum HealthKitRunKind: String, Sendable, Codable {
    case initialImport = "initial_import"
    case sync = "sync"
    case repairImport = "repair_import"
}

struct HealthKitRunRequest: Sendable {
    let metric: HealthKitSyncMetric
    let kind: HealthKitRunKind
}

struct HealthKitRunResult: Sendable {
    let metric: HealthKitSyncMetric
    let kind: HealthKitRunKind
    let fetchedCount: Int
    let appliedCount: Int
    let deletedCount: Int
    let rangeStart: Date
    let rangeEnd: Date
}

/// In-row progress stages (plan §5.4).
enum HealthKitRunStage: String, Sendable {
    case requestingAccess
    case preparing
    case reading
    case uploading
    case finishing

    var displayText: String {
        switch self {
        case .requestingAccess:
            return "Requesting Apple Health access…"
        case .preparing:
            return "Preparing…"
        case .reading:
            return "Reading Apple Health…"
        case .uploading:
            return "Uploading…"
        case .finishing:
            return "Finishing…"
        }
    }
}

protocol HealthKitRunning: Sendable {
    func run(_ request: HealthKitRunRequest) async throws -> HealthKitRunResult
}

enum HealthKitRunError: LocalizedError {
    /// Another foreground/background run holds the process-wide gate.
    case runInProgress
    case metricNotImplemented(HealthKitSyncMetric)
    case metricDisabled(HealthKitSyncMetric)
    case initialImportRequired(HealthKitSyncMetric)
    case initialImportAlreadyComplete(HealthKitSyncMetric)
    case unexpectedDeleteAuthority(HealthKitSyncMetric)

    var errorDescription: String? {
        switch self {
        case .runInProgress:
            return "Another HealthKit sync is still finishing. Wait a moment and try again."
        case .metricNotImplemented(let metric):
            return "\(metric.displayName) is not supported by this app version."
        case .metricDisabled(let metric):
            return "\(metric.displayName) is disabled. Enable it and save first."
        case .initialImportRequired(let metric):
            return "\(metric.displayName) needs Import history first."
        case .initialImportAlreadyComplete(let metric):
            return "\(metric.displayName) has already completed Import history. Use Sync instead."
        case .unexpectedDeleteAuthority(let metric):
            return "Server granted unexpected delete permission for \(metric.displayName)."
        }
    }
}

/// Process-wide run gate (plan §6.2): only one foreground/background run may
/// execute in the app process at once. Both foreground commands and background
/// entry points cross it.
actor HealthKitRunGate {
    static let shared = HealthKitRunGate()

    private var isRunning = false

    var runInProgress: Bool { isRunning }

    /// Attempts an exclusive run.
    /// - Parameter waitSeconds: How long to wait for another holder to finish.
    ///   Foreground uses a short wait so observer/BG work can drain; background
    ///   uses `0` and soft-skips when busy.
    /// - Throws: `HealthKitRunError.runInProgress` if still busy after waiting.
    func withExclusiveRun<T: Sendable>(
        waitSeconds: TimeInterval = 0,
        _ work: @Sendable () async throws -> T
    ) async throws -> T {
        let deadline = Date().addingTimeInterval(max(0, waitSeconds))
        while isRunning {
            if Date() >= deadline {
                throw HealthKitRunError.runInProgress
            }
            // Suspend so the holder can leave this actor and release the flag.
            try await Task.sleep(nanoseconds: 100_000_000)
        }
        isRunning = true
        defer { isRunning = false }
        return try await work()
    }
}

/// What a metric adapter fetched and enqueued for one run.
struct HealthKitMetricFetchResult: Sendable {
    let fetchedCount: Int
    /// Complete present natural keys for the exact range (repair manifests).
    let presentNaturalKeys: [String]
}

/// API + adapter hooks injected by the caller (foreground ViewModel or BG helper).
struct HealthKitRunDependencies: Sendable {
    /// POST runs/begin → server-authoritative descriptor (range + allowDeletes).
    let beginRun: @Sendable (_ metric: HealthKitSyncMetric, _ kind: HealthKitRunKind) async throws -> HealthKitRunDescriptorWire
    /// POST runs/complete. `presentNaturalKeys` is non-nil only for repair.
    let completeRun: @Sendable (
        _ metric: HealthKitSyncMetric,
        _ kind: HealthKitRunKind,
        _ descriptor: HealthKitRunDescriptorWire,
        _ presentNaturalKeys: [String]?
    ) async throws -> HealthKitRunCompleteResultWire
    let postBatch: @Sendable (HealthKitOpsBatchRequest) async throws -> HealthKitOpsBatchResult
    /// Authorization for exactly the requested metric (enabled-only, plan §2.5).
    let ensureAuth: @Sendable (_ metric: HealthKitSyncMetric) async throws -> Void
    /// Adapter read + enqueue over the server-supplied range.
    let fetchAndEnqueue: @Sendable (_ metric: HealthKitSyncMetric, _ from: Date, _ through: Date) async throws -> HealthKitMetricFetchResult
    /// Canonical saved enabled-set snapshot captured at command start (plan §6.4).
    let isEnabled: @Sendable (HealthKitSyncMetric) -> Bool
    /// Server-reported initial-history completion snapshot.
    let needsInitialImport: @Sendable (HealthKitSyncMetric) -> Bool
    let onProgress: (@Sendable (_ metric: HealthKitSyncMetric, _ stage: HealthKitRunStage) async -> Void)?

    init(
        beginRun: @escaping @Sendable (HealthKitSyncMetric, HealthKitRunKind) async throws -> HealthKitRunDescriptorWire,
        completeRun: @escaping @Sendable (HealthKitSyncMetric, HealthKitRunKind, HealthKitRunDescriptorWire, [String]?) async throws -> HealthKitRunCompleteResultWire,
        postBatch: @escaping @Sendable (HealthKitOpsBatchRequest) async throws -> HealthKitOpsBatchResult,
        ensureAuth: @escaping @Sendable (HealthKitSyncMetric) async throws -> Void,
        fetchAndEnqueue: @escaping @Sendable (HealthKitSyncMetric, Date, Date) async throws -> HealthKitMetricFetchResult,
        isEnabled: @escaping @Sendable (HealthKitSyncMetric) -> Bool,
        needsInitialImport: @escaping @Sendable (HealthKitSyncMetric) -> Bool,
        onProgress: (@Sendable (HealthKitSyncMetric, HealthKitRunStage) async -> Void)? = nil
    ) {
        self.beginRun = beginRun
        self.completeRun = completeRun
        self.postBatch = postBatch
        self.ensureAuth = ensureAuth
        self.fetchAndEnqueue = fetchAndEnqueue
        self.isEnabled = isEnabled
        self.needsInitialImport = needsInitialImport
        self.onProgress = onProgress
    }
}

struct HealthKitRunEngine: HealthKitRunning {
    /// Soft timeouts so a run cannot hang forever on a HK query or upload.
    static let fetchTimeoutSeconds: TimeInterval = 90
    static let activityInitialImportFetchTimeoutSeconds: TimeInterval = 300
    static let drainTimeoutSeconds: TimeInterval = 180

    static func fetchTimeout(for metric: HealthKitSyncMetric, kind: HealthKitRunKind) -> TimeInterval {
        if metric == .activity, kind == .initialImport {
            return activityInitialImportFetchTimeoutSeconds
        }
        return fetchTimeoutSeconds
    }

    let syncStore: HealthKitSyncStore
    let deps: HealthKitRunDependencies

    func run(_ request: HealthKitRunRequest) async throws -> HealthKitRunResult {
        let metric = request.metric
        let kind = request.kind
        let groupKey = metric.rawValue

        // Run policy invariants, enforced before HealthKit authorization (plan §6.2).
        guard HealthKitSyncMetric.productMetrics.contains(metric) else {
            throw HealthKitRunError.metricNotImplemented(metric)
        }
        guard deps.isEnabled(metric) else {
            throw HealthKitRunError.metricDisabled(metric)
        }
        let needsImport = deps.needsInitialImport(metric)
        switch kind {
        case .initialImport:
            guard needsImport else { throw HealthKitRunError.initialImportAlreadyComplete(metric) }
        case .sync, .repairImport:
            guard !needsImport else { throw HealthKitRunError.initialImportRequired(metric) }
        }

        CrashReporting.healthKit(
            .importStarted,
            group: groupKey,
            metric: metric.scopeMetricKey,
            extra: ["run_kind": kind.rawValue]
        )

        // 1. Authorization for exactly this metric (never a broader set).
        await report(metric, .requestingAccess)
        do {
            try await deps.ensureAuth(metric)
            CrashReporting.healthKit(.authRequested, group: groupKey, metric: metric.scopeMetricKey)
        } catch {
            CrashReporting.healthKitNonFatal(
                .fetchFailed,
                stage: .authRequested,
                message: "healthkit_auth_run_failed",
                group: groupKey,
                metric: metric.scopeMetricKey,
                underlying: error
            )
            throw Self.mapError(error)
        }

        // 2. Begin: the server derives the authoritative range + delete permission.
        await report(metric, .preparing)
        let descriptor: HealthKitRunDescriptorWire
        do {
            descriptor = try await deps.beginRun(metric, kind)
        } catch {
            throw Self.mapError(error)
        }
        // Only repair may ever receive delete authority (plan §6.2).
        if descriptor.allowDeletes, kind != .repairImport {
            CrashReporting.healthKitNonFatal(
                .syncFailed,
                stage: .syncFailed,
                message: "unexpected_allow_deletes",
                group: groupKey,
                metric: metric.scopeMetricKey
            )
            throw HealthKitRunError.unexpectedDeleteAuthority(metric)
        }
        guard let rangeStart = Self.parseISODate(descriptor.rangeStartAt),
              let rangeEnd = Self.parseISODate(descriptor.rangeEndAt) else {
            throw HealthAPIError.badStatus(500, "Server returned an invalid run range.", code: "sync_failed")
        }
        try syncStore.setGroupStatus(groupKey, status: "syncing")

        // 3. Read Apple Health over the server range and enqueue idempotent upserts.
        await report(metric, .reading)
        let fetchResult: HealthKitMetricFetchResult
        do {
            fetchResult = try await Self.withTimeout(seconds: Self.fetchTimeout(for: metric, kind: kind), label: "\(groupKey)_fetch") {
                try await deps.fetchAndEnqueue(metric, rangeStart, rangeEnd)
            }
        } catch {
            CrashReporting.healthKitNonFatal(
                .fetchFailed,
                stage: .samplesFetched,
                message: "\(groupKey)_fetch_failed",
                group: groupKey,
                metric: metric.scopeMetricKey,
                underlying: error
            )
            throw Self.mapError(error)
        }
        CrashReporting.healthKit(
            .samplesFetched,
            group: groupKey,
            metric: metric.scopeMetricKey,
            count: fetchResult.fetchedCount,
            extra: ["run_kind": kind.rawValue]
        )

        // An empty BP initial import is a valid non-deleting warehouse state.
        // Repair is different: an empty manifest would delete stored BP rows, so
        // keep it fail-closed because HealthKit makes denied reads look empty.
        if metric == .vitals, kind == .repairImport, fetchResult.fetchedCount == 0 {
            CrashReporting.healthKitNonFatal(
                .fetchFailed,
                stage: .samplesFetched,
                message: "bp_samples_empty",
                group: "vitals",
                metric: "blood_pressure"
            )
            throw HealthAPIError.badStatus(
                404,
                "No blood pressure readings found in Apple Health for this period. If you have readings, open Settings → Health → Data Access → this app and turn on Blood Pressure Systolic and Diastolic, then try again.",
                code: "bp_samples_empty"
            )
        }
        // Sync and initial import may complete with zero records. Sleep and
        // workouts also allow empty successful reads for every run kind.

        // 4. Drain the pending queue; readiness requires an empty queue.
        await report(metric, .uploading)
        let worker = HealthKitSyncWorker(store: syncStore, postBatch: deps.postBatch)
        CrashReporting.healthKit(.drainStarted, group: groupKey, count: try syncStore.pendingCount(group: groupKey))
        let applied: Int
        do {
            applied = try await Self.withTimeout(seconds: Self.drainTimeoutSeconds, label: "\(groupKey)_drain") {
                try await worker.drain()
            }
        } catch {
            CrashReporting.healthKitNonFatal(
                .batchFailed,
                stage: .drainFinished,
                message: "ops_batch_drain_failed",
                group: groupKey,
                metric: metric.scopeMetricKey,
                underlying: error
            )
            throw Self.mapError(error)
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
                metric: metric.scopeMetricKey
            )
            throw HealthAPIError.badStatus(
                409,
                "HealthKit \(metric.displayName) queue still has \(remaining) pending ops after upload.",
                code: "sync_incomplete"
            )
        }

        // 5. Complete. Repair supplies the complete present-key manifest; nothing
        //    deletes unless this request is made (deletion safety barrier).
        await report(metric, .finishing)
        let completion: HealthKitRunCompleteResultWire
        do {
            completion = try await deps.completeRun(
                metric,
                kind,
                descriptor,
                kind == .repairImport ? fetchResult.presentNaturalKeys : nil
            )
        } catch {
            throw Self.mapError(error)
        }

        try syncStore.recordLocalRunSuccess(group: groupKey, at: Date())
        CrashReporting.healthKit(
            .groupReady,
            group: groupKey,
            metric: metric.scopeMetricKey,
            extra: ["run_kind": kind.rawValue, "deleted": String(completion.deletedCount)]
        )

        return HealthKitRunResult(
            metric: metric,
            kind: kind,
            fetchedCount: fetchResult.fetchedCount,
            appliedCount: applied,
            deletedCount: completion.deletedCount,
            rangeStart: rangeStart,
            rangeEnd: rangeEnd
        )
    }

    /// Production fetch dispatch: explicit range in, samples enqueued, natural
    /// keys out (repair manifests need the complete set for the exact range).
    static func makeFetchAndEnqueue(
        syncStore: HealthKitSyncStore,
        healthTimezone: String
    ) -> @Sendable (HealthKitSyncMetric, Date, Date) async throws -> HealthKitMetricFetchResult {
        { metric, from, through in
            switch metric {
            case .activity:
                let samples = try await HealthKitStepsSync.fetchStepHours(from: from, through: through)
                try HealthKitStepsSync.enqueueSamples(samples, into: syncStore)
                return HealthKitMetricFetchResult(
                    fetchedCount: samples.count,
                    presentNaturalKeys: samples.map { HealthKitStepsSync.naturalKey(for: $0) }
                )
            case .vitals:
                let samples = try await HealthKitBloodPressureSync.fetchBloodPressure(from: from, through: through)
                try HealthKitBloodPressureSync.enqueueSamples(samples, into: syncStore)
                return HealthKitMetricFetchResult(
                    fetchedCount: samples.count,
                    presentNaturalKeys: samples.map { HealthKitBloodPressureSync.naturalKey(for: $0) }
                )
            case .sleep:
                let samples = try await HealthKitSleepDaySync.fetchSleepDays(
                    from: from,
                    through: through,
                    healthTimezone: healthTimezone
                )
                try HealthKitSleepDaySync.enqueueSamples(samples, into: syncStore)
                return HealthKitMetricFetchResult(
                    fetchedCount: samples.count,
                    presentNaturalKeys: samples.map { HealthKitSleepDaySync.naturalKey(for: $0) }
                )
            case .workouts:
                let samples = try await HealthKitWorkoutSync.fetchWorkouts(from: from, through: through)
                try HealthKitWorkoutSync.enqueueSamples(samples, into: syncStore)
                return HealthKitMetricFetchResult(
                    fetchedCount: samples.count,
                    presentNaturalKeys: samples.map { HealthKitWorkoutSync.naturalKey(for: $0) }
                )
            default:
                throw HealthKitRunError.metricNotImplemented(metric)
            }
        }
    }

    private func report(_ metric: HealthKitSyncMetric, _ stage: HealthKitRunStage) async {
        if let onProgress = deps.onProgress {
            await onProgress(metric, stage)
        }
    }

    static func parseISODate(_ value: String) -> Date? {
        let withFractional = ISO8601DateFormatter()
        withFractional.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        if let date = withFractional.date(from: value) {
            return date
        }
        return ISO8601DateFormatter().date(from: value)
    }

    static func withTimeout<T: Sendable>(
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
                    "HealthKit step timed out after \(Int(seconds))s (\(label)). Try again.",
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

    static func mapError(_ error: Error) -> HealthAPIError {
        if let api = error as? HealthAPIError {
            return api
        }
        if let runError = error as? HealthKitRunError {
            return HealthAPIError.badStatus(409, runError.errorDescription, code: "sync_failed")
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

// MARK: - Sync all enabled (plan §4.4)

struct HealthKitSyncAllOutcome: Sendable {
    struct Failure: Sendable {
        let metric: HealthKitSyncMetric
        let error: HealthAPIError
    }

    /// Completed runs in execution order.
    let synced: [HealthKitRunResult]
    /// Metrics that failed; later metrics still ran.
    let failures: [Failure]
    /// Enabled metrics skipped because they still need Import history.
    let skipped: [HealthKitSyncMetric]
}

enum HealthKitSyncAllRunner {
    /// Fixed order: Vitals -> Sleep -> Workouts -> Activity.
    static let metricOrder: [HealthKitSyncMetric] = [.vitals, .sleep, .workouts, .activity]

    /// Runs routine sync for the immutable enabled snapshot taken at command
    /// start. Enabled metrics whose initial import is incomplete are skipped —
    /// never turned into a hidden full import. One failure never stops later
    /// eligible metrics.
    static func runAll(
        enabledSnapshot: Set<HealthKitSyncMetric>,
        engine: HealthKitRunEngine,
        onMetricStarted: (@Sendable (HealthKitSyncMetric) async -> Void)? = nil,
        onMetricFinished: (@Sendable (HealthKitSyncMetric, String?) async -> Void)? = nil
    ) async -> HealthKitSyncAllOutcome {
        var synced: [HealthKitRunResult] = []
        var failures: [HealthKitSyncAllOutcome.Failure] = []
        var skipped: [HealthKitSyncMetric] = []

        for metric in metricOrder where enabledSnapshot.contains(metric) {
            if engine.deps.needsInitialImport(metric) {
                skipped.append(metric)
                continue
            }
            if let onMetricStarted {
                await onMetricStarted(metric)
            }
            do {
                let result = try await engine.run(HealthKitRunRequest(metric: metric, kind: .sync))
                synced.append(result)
                if let onMetricFinished {
                    await onMetricFinished(metric, nil)
                }
            } catch {
                let api = HealthKitRunEngine.mapError(error)
                failures.append(.init(metric: metric, error: api))
                if let onMetricFinished {
                    await onMetricFinished(metric, api.errorDescription)
                }
                CrashReporting.healthKitNonFatal(
                    .syncFailed,
                    stage: .syncFailed,
                    message: "sync_all_metric_failed_continue",
                    group: metric.rawValue,
                    metric: metric.scopeMetricKey,
                    underlying: error
                )
            }
        }

        return HealthKitSyncAllOutcome(synced: synced, failures: failures, skipped: skipped)
    }
}

extension HealthKitSyncMetric {
    /// Registry scope key for telemetry (never sample values).
    var scopeMetricKey: String {
        switch self {
        case .activity: return "steps"
        case .vitals: return "blood_pressure"
        case .sleep: return "sleep"
        case .workouts: return "workout"
        default: return rawValue
        }
    }
}
