import XCTest
@testable import FamilyOS

final class HealthKitRunEngineTests: XCTestCase {
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
            enabled: [.vitals, .sleep, .workouts],
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
            enabledSnapshot: [.vitals, .sleep, .workouts],
            engine: engine
        )

        XCTAssertEqual(outcome.skipped, [.sleep])
        XCTAssertEqual(outcome.failures.map(\.metric), [.vitals])
        XCTAssertEqual(outcome.synced.map(\.metric), [.workouts])
        XCTAssertEqual(recorder.beginCalls, [.vitals, .workouts])
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
            enabled: [.vitals, .sleep, .workouts],
            needingInitialImport: [HealthKitSyncMetric.sleep.rawValue]
        )

        XCTAssertEqual(eligibility.eligible, [.vitals, .workouts])
        XCTAssertEqual(eligibility.skipped, [.sleep])
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
            postBatch: { _ in .init(results: []) },
            ensureAuth: { metric in recorder.authorizationCalls.append(metric) },
            fetchAndEnqueue: { metric, from, through in
                recorder.fetchCalls += 1
                return try await fetch(metric, from, through)
            },
            isEnabled: { enabled.contains($0) },
            needsInitialImport: { needsImport.contains($0) }
        )
        return HealthKitRunEngine(syncStore: store, deps: deps)
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
    var fetchedRange: (Date, Date)?
    var fetchCalls = 0
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
