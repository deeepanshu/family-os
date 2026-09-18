import Foundation
import HealthKit

/// The store operations a bridged HealthKit query needs, so query teardown is
/// observable in tests without a real `HKHealthStore`.
protocol HealthKitQueryRunning: Sendable {
    func execute(_ query: HKQuery)
    func stop(_ query: HKQuery)
}

extension HKHealthStore: HealthKitQueryRunning {}

/// Bridges a callback-based HealthKit query into structured concurrency, and
/// makes it genuinely cancellable.
///
/// A continuation resumes only from its callback, so `Task.cancel()` alone can
/// never complete one. Cancelling here does both halves: it stops the query at
/// the store *and* resumes the awaiting caller, which is what lets a deadline
/// abandon an in-flight HealthKit read.
final class HealthKitQueryState<T: Sendable>: @unchecked Sendable {
    private let lock = NSLock()
    private var isFinished = false
    private var store: HealthKitQueryRunning?
    private var query: HKQuery?
    private var continuation: CheckedContinuation<T, Error>?

    /// Hands the query to the store. If cancellation already arrived, the query
    /// is stopped immediately instead of being executed.
    func installAndExecute(
        _ query: HKQuery,
        store: HealthKitQueryRunning,
        continuation: CheckedContinuation<T, Error>
    ) {
        lock.lock()
        guard !isFinished else {
            lock.unlock()
            store.stop(query)
            continuation.resume(throwing: CancellationError())
            return
        }
        self.store = store
        self.query = query
        self.continuation = continuation
        lock.unlock()
        store.execute(query)
    }

    /// Delivers the query result. Ignored once the state has resolved.
    func finish(_ result: Result<T, Error>) {
        lock.lock()
        guard !isFinished else {
            lock.unlock()
            return
        }
        isFinished = true
        let continuation = self.continuation
        self.continuation = nil
        self.store = nil
        self.query = nil
        lock.unlock()
        continuation?.resume(with: result)
    }

    /// Stops the query and resumes the caller with `CancellationError`.
    func cancel() {
        lock.lock()
        guard !isFinished else {
            lock.unlock()
            return
        }
        isFinished = true
        let store = self.store
        let query = self.query
        let continuation = self.continuation
        self.store = nil
        self.query = nil
        self.continuation = nil
        lock.unlock()

        if let query {
            store?.stop(query)
        }
        continuation?.resume(throwing: CancellationError())
    }
}
