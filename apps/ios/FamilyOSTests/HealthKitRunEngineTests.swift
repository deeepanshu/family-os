import HealthKit
import UIKit
import XCTest
@testable import FamilyOS

final class HealthKitRunEngineTests: XCTestCase {
    func testActivityInitialImportUsesExtendedFetchBudget() {
        XCTAssertEqual(
            HealthKitRunEngine.fetchTimeout(for: .activity, kind: .initialImport),
            300
        )
        XCTAssertEqual(
            HealthKitRunEngine.fetchTimeout(for: .activity, kind: .sync),
            HealthKitRunEngine.fetchTimeoutSeconds
        )
        XCTAssertEqual(
            HealthKitRunEngine.fetchTimeout(for: .sleep, kind: .initialImport),
            HealthKitRunEngine.fetchTimeoutSeconds
        )
    }

    func testActivityInitialImportUsesBoundedUploadBudget() {
        XCTAssertEqual(
            HealthKitRunEngine.drainTimeout(for: .activity, kind: .initialImport),
            1_800
        )
        XCTAssertEqual(
            HealthKitRunEngine.uploadBatchSize(for: .activity, kind: .initialImport),
            20
        )
        XCTAssertEqual(
            HealthKitRunEngine.drainTimeout(for: .activity, kind: .sync),
            HealthKitRunEngine.drainTimeoutSeconds
        )
        XCTAssertEqual(
            HealthKitRunEngine.uploadBatchSize(for: .activity, kind: .sync),
            HealthKitRunEngine.uploadBatchSize
        )
        XCTAssertEqual(
            HealthKitRunEngine.drainTimeout(for: .sleep, kind: .initialImport),
            HealthKitRunEngine.drainTimeoutSeconds
        )
        XCTAssertEqual(
            HealthKitRunEngine.uploadBatchSize(for: .sleep, kind: .initialImport),
            HealthKitRunEngine.uploadBatchSize
        )
    }

    func testForegroundDrainUsesConservativeBatchSizeWhenActivityIsPending() {
        XCTAssertEqual(HealthKitBackgroundSync.foregroundDrainBatchSize(hasPendingActivity: true), 20)
        XCTAssertEqual(
            HealthKitBackgroundSync.foregroundDrainBatchSize(hasPendingActivity: false),
            HealthKitRunEngine.uploadBatchSize
        )
    }

    func testActivityInitialImportRunsTheAdapterAndCompletes() async throws {
        let recorder = RunRecorder()
        let engine = try makeEngine(
            enabled: [.activity],
            needsImport: [.activity],
            descriptor: descriptor(metric: .activity, kind: .initialImport),
            fetch: { metric, _, _ in
                XCTAssertEqual(metric, .activity)
                return .init(fetchedCount: 2, presentNaturalKeys: [])
            },
            recorder: recorder
        )

        let result = try await engine.run(.init(metric: .activity, kind: .initialImport))

        XCTAssertEqual(result.metric, .activity)
        XCTAssertEqual(result.fetchedCount, 2)
        XCTAssertEqual(recorder.authorizationCalls, [.activity])
        XCTAssertEqual(recorder.beginCalls, [.activity])
        XCTAssertEqual(recorder.fetchCalls, 1)
        XCTAssertEqual(recorder.completeCalls.map(\.metric), [.activity])
    }

    func testSyncIsRejectedBeforeAuthorizationWhenHistoryImportIsRequired() async throws {
        let recorder = RunRecorder()
        let engine = try makeEngine(
            enabled: [.sleep],
            needsImport: [.sleep],
            recorder: recorder
        )

        do {
            _ = try await engine.run(.init(metric: .sleep, kind: .sync))
            XCTFail("Expected sync to require Import history")
        } catch let error as HealthKitRunError {
            guard case .initialImportRequired(.sleep) = error else {
                return XCTFail("Unexpected error: \(error)")
            }
        }
        XCTAssertEqual(recorder.authorizationCalls, [])
        XCTAssertEqual(recorder.beginCalls, [])
    }

    func testRepairUsesServerRangeAndSendsCompleteNaturalKeyManifest() async throws {
        let recorder = RunRecorder()
        let start = "2026-05-01T00:00:00.000Z"
        let end = "2026-07-30T00:00:00.000Z"
        let engine = try makeEngine(
            enabled: [.sleep],
            needsImport: [],
            descriptor: descriptor(metric: .sleep, kind: .repairImport, start: start, end: end, allowDeletes: true),
            fetch: { _, from, through in
                recorder.fetchedRange = (from, through)
                return .init(fetchedCount: 2, presentNaturalKeys: ["sleep_day:2026-06-01", "sleep_day:2026-06-02"])
            },
            recorder: recorder
        )

        let result = try await engine.run(.init(metric: .sleep, kind: .repairImport))

        XCTAssertEqual(result.rangeStart, try XCTUnwrap(HealthKitRunEngine.parseISODate(start)))
        XCTAssertEqual(result.rangeEnd, try XCTUnwrap(HealthKitRunEngine.parseISODate(end)))
        XCTAssertEqual(recorder.completeCalls.count, 1)
        XCTAssertEqual(recorder.completeCalls[0].kind, .repairImport)
        XCTAssertEqual(recorder.completeCalls[0].manifest, ["sleep_day:2026-06-01", "sleep_day:2026-06-02"])
        XCTAssertEqual(recorder.fetchedRange?.0, result.rangeStart)
        XCTAssertEqual(recorder.fetchedRange?.1, result.rangeEnd)
    }

    func testEmptyBloodPressureInitialImportCompletesWithoutDeletes() async throws {
        let recorder = RunRecorder()
        let engine = try makeEngine(
            enabled: [.vitals],
            needsImport: [.vitals],
            descriptor: descriptor(metric: .vitals, kind: .initialImport),
            recorder: recorder
        )

        let result = try await engine.run(.init(metric: .vitals, kind: .initialImport))

        XCTAssertEqual(result.fetchedCount, 0)
        XCTAssertEqual(result.appliedCount, 0)
        XCTAssertEqual(recorder.completeCalls.count, 1)
        XCTAssertEqual(recorder.completeCalls[0].kind, .initialImport)
        XCTAssertNil(recorder.completeCalls[0].manifest)
    }

    func testEmptyBloodPressureSyncLeavesOtherMetricUploadsQueued() async throws {
        let recorder = RunRecorder()
        let (engine, store) = try makeEngineAndStore(
            enabled: [.vitals],
            needsImport: [],
            descriptor: descriptor(metric: .vitals, kind: .sync),
            recorder: recorder,
            postBatch: { request in
                recorder.uploadedGroups.append(contentsOf: request.ops.map(\.group))
                return .init(
                    results: request.ops.map {
                        .init(opId: $0.opId, result: "applied", errorCode: nil, errorMessage: nil)
                    }
                )
            }
        )
        // Drain marks claimed ops for backoff and never posts when configuration
        // is missing, so the unscoped pre-fix path would still pass without this.
        try store.saveConfiguration(
            userId: "user",
            personId: "person",
            installationId: "install",
            healthTimezone: "UTC",
            timezoneVersion: 1,
            enabledGroups: ["vitals", "activity", "sleep"]
        )
        try store.enqueue(ops: [
            .init(
                opId: UUID().uuidString.lowercased(),
                naturalKey: "blood_pressure:cccccccc-cccc-4ccc-8ccc-cccccccccccc",
                groupKey: "vitals",
                scopeKey: "blood_pressure",
                op: "upsert",
                payloadJSON: nil
            ),
            .init(
                opId: UUID().uuidString.lowercased(),
                naturalKey: "steps_hour:2026-08-15T00:00:00.000Z",
                groupKey: "activity",
                scopeKey: "steps",
                op: "upsert",
                payloadJSON: nil
            ),
            .init(
                opId: UUID().uuidString.lowercased(),
                naturalKey: "sleep_day:2026-08-15",
                groupKey: "sleep",
                scopeKey: "sleep",
                op: "upsert",
                payloadJSON: nil
            )
        ])

        let result = try await engine.run(.init(metric: .vitals, kind: .sync))

        XCTAssertEqual(result.fetchedCount, 0)
        XCTAssertEqual(result.appliedCount, 1)
        XCTAssertEqual(recorder.uploadedGroups, ["vitals"])
        XCTAssertEqual(try store.pendingCount(group: "vitals"), 0)
        XCTAssertEqual(try store.pendingCount(group: "activity"), 1)
        XCTAssertEqual(try store.pendingCount(group: "sleep"), 1)
    }

    func testEmptyBloodPressureRepairFailsBeforeCompletion() async throws {
        let recorder = RunRecorder()
        let engine = try makeEngine(
            enabled: [.vitals],
            needsImport: [],
            descriptor: descriptor(metric: .vitals, kind: .repairImport, allowDeletes: true),
            recorder: recorder
        )

        do {
            _ = try await engine.run(.init(metric: .vitals, kind: .repairImport))
            XCTFail("Expected empty blood-pressure repair to fail closed")
        } catch let error as HealthAPIError {
            XCTAssertEqual(error.errorCode, "bp_samples_empty")
        }
        XCTAssertEqual(recorder.completeCalls.count, 0)
    }

    func testEmptyBloodPressureSyncCompletes() async throws {
        let recorder = RunRecorder()
        let engine = try makeEngine(
            enabled: [.vitals],
            needsImport: [],
            descriptor: descriptor(metric: .vitals, kind: .sync),
            recorder: recorder
        )

        let result = try await engine.run(.init(metric: .vitals, kind: .sync))

        XCTAssertEqual(result.fetchedCount, 0)
        XCTAssertEqual(recorder.completeCalls.count, 1)
        XCTAssertEqual(recorder.completeCalls[0].kind, .sync)
        XCTAssertNil(recorder.completeCalls[0].manifest)
    }

    func testUnexpectedDeleteAuthorityForSyncStopsBeforeFetch() async throws {
        let recorder = RunRecorder()
        let engine = try makeEngine(
            enabled: [.workouts],
            needsImport: [],
            descriptor: descriptor(metric: .workouts, kind: .sync, allowDeletes: true),
            recorder: recorder
        )

        do {
            _ = try await engine.run(.init(metric: .workouts, kind: .sync))
            XCTFail("Expected unexpected delete authority to fail")
        } catch let error as HealthKitRunError {
            guard case .unexpectedDeleteAuthority(.workouts) = error else {
                return XCTFail("Unexpected error: \(error)")
            }
        }
        XCTAssertEqual(recorder.fetchCalls, 0)
        XCTAssertEqual(recorder.completeCalls.count, 0)
    }

    func testSyncAllUsesFixedOrderSkipsImportsAndContinuesAfterFailure() async throws {
        let recorder = RunRecorder()
        let engine = try makeEngine(
            enabled: [.vitals, .sleep, .workouts, .activity],
            needsImport: [.sleep],
            fetch: { metric, _, _ in
                if metric == .vitals {
                    throw HealthAPIError.badStatus(500, "BP failed", code: "bp_failed")
                }
                return .init(fetchedCount: 1, presentNaturalKeys: [])
            },
            recorder: recorder
        )

        let outcome = await HealthKitSyncAllRunner.runAll(
            enabledSnapshot: [.vitals, .sleep, .workouts, .activity],
            engine: engine
        )

        XCTAssertEqual(outcome.skipped, [.sleep])
        XCTAssertEqual(outcome.failures.map(\.metric), [.vitals])
        XCTAssertEqual(outcome.synced.map(\.metric), [.workouts, .activity])
        XCTAssertEqual(recorder.beginCalls, [.vitals, .workouts, .activity])
    }

    func testRunGateRejectsConcurrentRun() async throws {
        let gate = HealthKitRunGate()
        let started = expectation(description: "first run started")
        let blocker = GateBlocker()

        let first = Task {
            try await gate.withExclusiveRun {
                started.fulfill()
                await blocker.wait()
                return 1
            }
        }
        await fulfillment(of: [started], timeout: 1)

        do {
            _ = try await gate.withExclusiveRun { 2 }
            XCTFail("Expected second run to be rejected")
        } catch let error as HealthKitRunError {
            guard case .runInProgress = error else {
                return XCTFail("Unexpected error: \(error)")
            }
        }

        await blocker.release()
        _ = try await first.value
    }

    func testBackgroundEligibilitySkipsMetricsNeedingInitialImport() {
        let eligibility = HealthKitBackgroundSync.incrementalEligibility(
            enabled: [.activity, .vitals, .sleep, .workouts],
            needingInitialImport: [HealthKitSyncMetric.sleep.rawValue]
        )

        XCTAssertEqual(eligibility.eligible, [.vitals, .workouts])
        XCTAssertEqual(eligibility.skipped, [.sleep, .activity])
    }

    func testObserverWakeRunsSingleImportedMetricWhenBackgrounded() {
        guard let workout = Optional(HKObjectType.workoutType()) else {
            return XCTFail("Missing workout type")
        }
        let action = HealthKitBackgroundSync.observerWakeAction(
            sampleType: workout,
            applicationState: .background,
            enabled: [.workouts, .sleep],
            needingInitialImport: []
        )
        XCTAssertEqual(action, .runMetricThenSchedule(.workouts))
    }

    func testObserverWakeSchedulesOnlyWhenAppIsActive() {
        let action = HealthKitBackgroundSync.observerWakeAction(
            sampleType: HKObjectType.workoutType(),
            applicationState: .active,
            enabled: [.workouts],
            needingInitialImport: []
        )
        XCTAssertEqual(action, .scheduleOnly)
    }

    func testObserverWakeSchedulesOnlyWhenImportIsStillRequired() {
        let action = HealthKitBackgroundSync.observerWakeAction(
            sampleType: HKObjectType.workoutType(),
            applicationState: .background,
            enabled: [.workouts],
            needingInitialImport: [HealthKitSyncMetric.workouts.rawValue]
        )
        XCTAssertEqual(action, .scheduleOnly)
    }

    func testObserverWakeRunsVitalsForHeartRate() {
        guard let hr = HKQuantityType.quantityType(forIdentifier: .heartRate) else {
            return XCTFail("Missing heart rate type")
        }
        let action = HealthKitBackgroundSync.observerWakeAction(
            sampleType: hr,
            applicationState: .background,
            enabled: [.vitals],
            needingInitialImport: []
        )
        XCTAssertEqual(action, .runMetricThenSchedule(.vitals))
    }

    func testBackgroundAlertPolicyIsCompletionOnly() {
        XCTAssertTrue(
            HealthKitBackgroundSyncAlert.shouldNotify(
                reason: "observer",
                appliedCount: 2,
                alertsEnabled: true,
                applicationState: .background
            )
        )
        XCTAssertFalse(
            HealthKitBackgroundSyncAlert.shouldNotify(
                reason: "observer",
                appliedCount: 0,
                alertsEnabled: true,
                applicationState: .background
            )
        )
        XCTAssertFalse(
            HealthKitBackgroundSyncAlert.shouldNotify(
                reason: "become_active",
                appliedCount: 3,
                alertsEnabled: true,
                applicationState: .active
            )
        )
        XCTAssertFalse(
            HealthKitBackgroundSyncAlert.shouldNotify(
                reason: "bg_task",
                appliedCount: 1,
                alertsEnabled: false,
                applicationState: .background
            )
        )
        XCTAssertTrue(
            HealthKitBackgroundSyncAlert.shouldNotify(
                reason: "bg_refresh",
                appliedCount: 1,
                alertsEnabled: true,
                applicationState: .inactive
            )
        )
    }

    func testLockedHealthKitErrorIsDetectedWithoutBegin() async throws {
        let locked = NSError(
            domain: HKError.errorDomain,
            code: HKError.Code.errorDatabaseInaccessible.rawValue,
            userInfo: nil
        )
        XCTAssertTrue(HealthKitDatabaseAccess.isInaccessible(locked))
        XCTAssertTrue(HealthKitBackgroundSync.isLockedHealthKitError(locked))
        XCTAssertTrue(HealthKitBackgroundSync.isLockedHealthKitError(HealthKitRunError.databaseInaccessible))
        XCTAssertTrue(
            HealthKitBackgroundSync.isLockedHealthKitError(
                HealthAPIError.badStatus(423, "locked", code: "healthkit_locked")
            )
        )
        XCTAssertFalse(
            HealthKitDatabaseAccess.isInaccessible(
                NSError(domain: HKError.errorDomain, code: HKError.Code.errorAuthorizationNotDetermined.rawValue)
            )
        )

        let recorder = RunRecorder()
        let path = FileManager.default.temporaryDirectory
            .appendingPathComponent("healthkit-run-engine-\(UUID().uuidString).sqlite")
        addTeardownBlock { try? FileManager.default.removeItem(at: path) }
        let store = try HealthKitSyncStore(path: path.path)
        let runDescriptor = descriptor(metric: .sleep, kind: .sync)
        let deps = HealthKitRunDependencies(
            beginRun: { metric, kind in
                recorder.beginCalls.append(metric)
                return runDescriptor
            },
            completeRun: { metric, kind, _, _ in
                recorder.completeCalls.append((metric, kind, nil))
                return HealthKitRunCompleteResultWire(
                    group: metric.rawValue,
                    kind: kind.rawValue,
                    status: "ready",
                    deletedCount: 0,
                    lastSuccessfulAt: nil,
                    coverageStartAt: nil,
                    coverageEndAt: nil,
                    needsInitialImport: false
                )
            },
            postBatch: { _ in .init(results: []) },
            ensureAuth: { _ in },
            fetchAndEnqueue: { _, _, _ in .init(fetchedCount: 0, presentNaturalKeys: []) },
            isEnabled: { $0 == .sleep },
            needsInitialImport: { _ in false },
            assertDatabaseAccessible: { throw HealthKitRunError.databaseInaccessible }
        )
        let engine = HealthKitRunEngine(syncStore: store, deps: deps)
        do {
            _ = try await engine.run(.init(metric: .sleep, kind: .sync))
            XCTFail("Expected locked HealthKit to skip begin")
        } catch let error as HealthKitRunError {
            guard case .databaseInaccessible = error else {
                return XCTFail("Unexpected error: \(error)")
            }
        }
        XCTAssertEqual(recorder.beginCalls, [])
        XCTAssertTrue(recorder.failCalls.isEmpty)
    }

    func testBecomeActiveWaitsOnTheRunGate() {
        XCTAssertEqual(HealthKitBackgroundSync.exclusiveWaitSeconds(for: "become_active"), 45)
        XCTAssertEqual(HealthKitBackgroundSync.exclusiveWaitSeconds(for: "observer"), 0)
        XCTAssertEqual(HealthKitBackgroundSync.exclusiveWaitSeconds(for: "bg_task"), 0)
    }

    func testObserverBudgetSkipsWhenTheWallClockIsAlmostGone() {
        XCTAssertTrue(HealthKitBackgroundSync.canStartMetric(elapsed: 0, wallTimeoutSeconds: 25))
        XCTAssertTrue(HealthKitBackgroundSync.canStartMetric(elapsed: 19, wallTimeoutSeconds: 25))
        XCTAssertFalse(HealthKitBackgroundSync.canStartMetric(elapsed: 21, wallTimeoutSeconds: 25))
        XCTAssertTrue(HealthKitBackgroundSync.canStartMetric(elapsed: 100, wallTimeoutSeconds: nil))
    }

    func testCaptionTreatsStaleServerSyncingAsInterrupted() {
        let state = metricState(status: .syncing, needsImport: false)
        let text = HealthKitMetricCaption.text(
            metric: .vitals,
            enabled: true,
            activeRun: nil,
            localRunInProgress: false,
            sessionError: nil,
            state: state
        )
        XCTAssertEqual(text, "Interrupted - try Sync or Import history again.")
        XCTAssertEqual(
            HealthKitMetricCaption.tone(
                metric: .vitals,
                enabled: true,
                activeRun: nil,
                localRunInProgress: false,
                sessionError: nil,
                state: state
            ),
            .warning
        )
    }

    func testCaptionDoesNotCallALiveLocalRunInterrupted() {
        let state = metricState(status: .syncing, needsImport: false)
        let active = HealthKitActiveRun(metric: .vitals, kind: .sync, stage: .uploading)
        XCTAssertEqual(
            HealthKitMetricCaption.text(
                metric: .vitals,
                enabled: true,
                activeRun: active,
                localRunInProgress: true,
                sessionError: nil,
                state: state
            ),
            HealthKitRunStage.uploading.displayText
        )
        XCTAssertEqual(
            HealthKitMetricCaption.text(
                metric: .sleep,
                enabled: true,
                activeRun: active,
                localRunInProgress: true,
                sessionError: nil,
                state: state
            ),
            "Waiting…"
        )
    }

    func testFetchFailureAfterBeginAbandonsTheServerAttempt() async throws {
        let recorder = RunRecorder()
        let engine = try makeEngine(
            enabled: [.sleep],
            needsImport: [],
            fetch: { _, _, _ in
                throw HealthAPIError.badStatus(408, "timed out", code: "sync_timeout")
            },
            recorder: recorder
        )

        do {
            _ = try await engine.run(.init(metric: .sleep, kind: .sync))
            XCTFail("Expected fetch failure")
        } catch let error as HealthAPIError {
            XCTAssertEqual(error.errorCode, "sync_timeout")
        }
        XCTAssertEqual(recorder.beginCalls, [.sleep])
        XCTAssertEqual(recorder.completeCalls.count, 0)
        XCTAssertEqual(recorder.failCalls.map(\.metric), [.sleep])
        XCTAssertEqual(recorder.failCalls.map(\.code), ["sync_timeout"])
    }

    func testUnauthorizedMatcher() {
        XCTAssertTrue(HealthSessionRefresher.isUnauthorized(.badStatus(401, "expired", code: "unauthorized")))
        XCTAssertFalse(HealthSessionRefresher.isUnauthorized(.badStatus(500, "boom", code: "sync_failed")))
        XCTAssertFalse(HealthSessionRefresher.isUnauthorized(.missingToken))
    }

    private func makeEngine(
        enabled: Set<HealthKitSyncMetric>,
        needsImport: Set<HealthKitSyncMetric>,
        descriptor: HealthKitRunDescriptorWire? = nil,
        fetch: @escaping @Sendable (HealthKitSyncMetric, Date, Date) async throws -> HealthKitMetricFetchResult = { _, _, _ in
            .init(fetchedCount: 0, presentNaturalKeys: [])
        },
        recorder: RunRecorder
    ) throws -> HealthKitRunEngine {
        try makeEngineAndStore(
            enabled: enabled,
            needsImport: needsImport,
            descriptor: descriptor,
            fetch: fetch,
            recorder: recorder
        ).engine
    }

    private func makeEngineAndStore(
        enabled: Set<HealthKitSyncMetric>,
        needsImport: Set<HealthKitSyncMetric>,
        descriptor: HealthKitRunDescriptorWire? = nil,
        fetch: @escaping @Sendable (HealthKitSyncMetric, Date, Date) async throws -> HealthKitMetricFetchResult = { _, _, _ in
            .init(fetchedCount: 0, presentNaturalKeys: [])
        },
        recorder: RunRecorder,
        postBatch: @escaping @Sendable (HealthKitOpsBatchRequest) async throws -> HealthKitOpsBatchResult = { _ in .init(results: []) }
    ) throws -> (engine: HealthKitRunEngine, store: HealthKitSyncStore) {
        let path = FileManager.default.temporaryDirectory
            .appendingPathComponent("healthkit-run-engine-\(UUID().uuidString).sqlite")
        addTeardownBlock { try? FileManager.default.removeItem(at: path) }
        let store = try HealthKitSyncStore(path: path.path)
        let runDescriptor = descriptor ?? self.descriptor(metric: .workouts, kind: .sync)
        let deps = HealthKitRunDependencies(
            beginRun: { metric, kind in
                recorder.beginCalls.append(metric)
                return runDescriptor
            },
            completeRun: { metric, kind, _, manifest in
                recorder.completeCalls.append((metric, kind, manifest))
                return HealthKitRunCompleteResultWire(
                    group: metric.rawValue,
                    kind: kind.rawValue,
                    status: "ready",
                    deletedCount: manifest?.count ?? 0,
                    lastSuccessfulAt: nil,
                    coverageStartAt: nil,
                    coverageEndAt: nil,
                    needsInitialImport: false
                )
            },
            postBatch: postBatch,
            ensureAuth: { metric in recorder.authorizationCalls.append(metric) },
            fetchAndEnqueue: { metric, from, through in
                recorder.fetchCalls += 1
                return try await fetch(metric, from, through)
            },
            isEnabled: { enabled.contains($0) },
            needsInitialImport: { needsImport.contains($0) },
            failRun: { metric, kind, code in
                recorder.failCalls.append((metric, kind, code))
            },
            assertDatabaseAccessible: {}
        )
        return (HealthKitRunEngine(syncStore: store, deps: deps), store)
    }

    private func metricState(
        status: HealthKitMetricSyncStatus,
        needsImport: Bool
    ) -> HealthKitMetricState {
        HealthKitMetricState(
            group: .vitals,
            enabled: true,
            status: status,
            lastSuccessfulAt: "2026-08-01T00:00:00.000Z",
            lastAttemptAt: "2026-08-20T00:00:00.000Z",
            lastErrorCode: nil,
            coverageStartAt: nil,
            coverageEndAt: nil,
            needsInitialImport: needsImport,
            historyImportCompletedAt: needsImport ? nil : "2026-08-01T00:00:00.000Z"
        )
    }

    private func descriptor(
        metric: HealthKitSyncMetric,
        kind: HealthKitRunKind,
        start: String = "2026-07-01T00:00:00.000Z",
        end: String = "2026-07-02T00:00:00.000Z",
        allowDeletes: Bool = false
    ) -> HealthKitRunDescriptorWire {
        .init(group: metric.rawValue, kind: kind.rawValue, rangeStartAt: start, rangeEndAt: end, allowDeletes: allowDeletes)
    }
}

private final class RunRecorder: @unchecked Sendable {
    var authorizationCalls: [HealthKitSyncMetric] = []
    var beginCalls: [HealthKitSyncMetric] = []
    var completeCalls: [(metric: HealthKitSyncMetric, kind: HealthKitRunKind, manifest: [String]?)] = []
    var uploadedGroups: [String] = []
    var fetchedRange: (Date, Date)?
    var fetchCalls = 0
    var failCalls: [(metric: HealthKitSyncMetric, kind: HealthKitRunKind, code: String)] = []
}

private actor GateBlocker {
    private var continuation: CheckedContinuation<Void, Never>?
    private var wasReleased = false

    func wait() async {
        guard !wasReleased else { return }
        await withCheckedContinuation { continuation = $0 }
    }

    func release() {
        wasReleased = true
        continuation?.resume()
        continuation = nil
    }
}
