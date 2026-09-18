import HealthKit
import XCTest
@testable import FamilyOS

/// A HealthKit read bridged through a checked continuation resumes only from its
/// callback, so `Task.cancel()` cannot complete it. These tests pin the behaviour
/// that makes such a read genuinely cancellable: a cancel stops the query at the
/// store *and* resumes the awaiting caller.
///
/// Waits are bounded by expectations so a missing resume reports a clear failure
/// instead of hanging the suite.
final class HealthKitQueryStateTests: XCTestCase {
    func testCancelStopsTheQueryAndResumesTheCaller() async throws {
        let store = FakeQueryStore()
        let state = HealthKitQueryState<Int>()
        let query = makeQuery()

        let resumed = expectation(description: "query resumed")
        let box = ResultBox()

        let task = Task {
            do {
                let value = try await withTaskCancellationHandler {
                    try await withCheckedThrowingContinuation { continuation in
                        state.installAndExecute(query, store: store, continuation: continuation)
                    }
                } onCancel: {
                    state.cancel()
                }
                box.set(.success(value))
            } catch {
                box.set(.failure(error))
            }
            resumed.fulfill()
        }

        await store.waitUntilExecuted(query)
        task.cancel()

        await fulfillment(of: [resumed], timeout: 2)

        guard case .failure(let error) = box.value else {
            return XCTFail("Expected the cancelled query to resume with an error")
        }
        XCTAssertTrue(error is CancellationError, "Expected CancellationError, got \(error)")
        XCTAssertEqual(store.stoppedQueries.count, 1, "Cancelling must stop the query at the store")
    }

    /// A late HealthKit callback after cancellation must not double-resume.
    func testFinishAfterCancelIsIgnored() async throws {
        let store = FakeQueryStore()
        let state = HealthKitQueryState<Int>()
        let query = makeQuery()

        let resumed = expectation(description: "query resumed")
        let box = ResultBox()

        let task = Task {
            do {
                let value = try await withCheckedThrowingContinuation { continuation in
                    state.installAndExecute(query, store: store, continuation: continuation)
                }
                box.set(.success(value))
            } catch {
                box.set(.failure(error))
            }
            resumed.fulfill()
        }

        await store.waitUntilExecuted(query)
        state.cancel()
        state.finish(.success(7))

        await fulfillment(of: [resumed], timeout: 2)

        guard case .failure = box.value else {
            return XCTFail("Cancel must win over a later finish")
        }
        _ = await task.value
    }

    /// The store returns results normally when nothing cancels.
    func testFinishDeliversTheValue() async throws {
        let store = FakeQueryStore()
        let state = HealthKitQueryState<Int>()
        let query = makeQuery()

        let resumed = expectation(description: "query resumed")
        let box = ResultBox()

        Task {
            do {
                let value = try await withCheckedThrowingContinuation { continuation in
                    state.installAndExecute(query, store: store, continuation: continuation)
                }
                box.set(.success(value))
            } catch {
                box.set(.failure(error))
            }
            resumed.fulfill()
        }

        await store.waitUntilExecuted(query)
        state.finish(.success(7))

        await fulfillment(of: [resumed], timeout: 2)

        XCTAssertEqual(try box.value?.get(), 7)
    }

    private func makeQuery() -> HKObserverQuery {
        HKObserverQuery(sampleType: HKObjectType.workoutType(), predicate: nil) { _, _, _ in }
    }
}

private final class ResultBox: @unchecked Sendable {
    private let lock = NSLock()
    private var stored: Result<Int, Error>?

    var value: Result<Int, Error>? {
        lock.lock()
        defer { lock.unlock() }
        return stored
    }

    func set(_ result: Result<Int, Error>) {
        lock.lock()
        stored = result
        lock.unlock()
    }
}

/// Records `stop(_:)` so query teardown is observable at the seam.
private final class FakeQueryStore: HealthKitQueryRunning, @unchecked Sendable {
    private let lock = NSLock()
    private var executed: [HKQuery] = []
    private var stopped: [HKQuery] = []

    var stoppedQueries: [HKQuery] {
        lock.lock()
        defer { lock.unlock() }
        return stopped
    }

    func execute(_ query: HKQuery) {
        lock.lock()
        executed.append(query)
        lock.unlock()
    }

    func stop(_ query: HKQuery) {
        lock.lock()
        stopped.append(query)
        lock.unlock()
    }

    /// Polls until the query has been handed to the store, so cancellation is
    /// applied to an already-installed query rather than a race.
    func waitUntilExecuted(_ query: HKQuery) async {
        for _ in 0..<400 {
            if hasExecuted(query) { return }
            try? await Task.sleep(nanoseconds: 5_000_000)
        }
    }

    private func hasExecuted(_ query: HKQuery) -> Bool {
        lock.lock()
        defer { lock.unlock() }
        return executed.contains { $0 === query }
    }
}
