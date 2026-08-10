import Foundation
import HealthKit

/// Steps read over an explicit server-supplied range and are stored as complete
/// UTC hour buckets. The adapter uploads aggregates only; raw HealthKit samples
/// never leave the device.
enum HealthKitStepsSync {
    private final class StatisticsQueryState: @unchecked Sendable {
        private let lock = NSLock()
        private var isFinished = false
        private var store: HKHealthStore?
        private var query: HKStatisticsCollectionQuery?
        private var continuation: CheckedContinuation<[HKStatistics], Error>?

        func installAndExecute(
            _ query: HKStatisticsCollectionQuery,
            store: HKHealthStore,
            continuation: CheckedContinuation<[HKStatistics], Error>
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
            store.execute(query)
            lock.unlock()
        }

        func finish(_ result: Result<[HKStatistics], Error>) {
            lock.lock()
            guard !isFinished else {
                lock.unlock()
                return
            }
            isFinished = true
            store = nil
            query = nil
            let continuation = continuation
            self.continuation = nil
            lock.unlock()
            continuation?.resume(with: result)
        }

        func cancel() {
            lock.lock()
            guard !isFinished else {
                lock.unlock()
                return
            }
            isFinished = true
            let store = store
            self.store = nil
            let query = query
            self.query = nil
            let continuation = continuation
            self.continuation = nil
            lock.unlock()
            if let query {
                store?.stop(query)
            }
            continuation?.resume(throwing: CancellationError())
        }
    }

    struct QueryWindow: Sendable {
        let start: Date
        let end: Date
    }

    struct HourlyAggregate: Sendable {
        let hourStart: Date
        let count: Double
    }

    struct StepHourSample: Sendable {
        let hourStartUtc: String
        let count: Int
    }

    static func naturalKey(for sample: StepHourSample) -> String {
        "steps_hour:\(sample.hourStartUtc)"
    }

    static func queryWindows(from start: Date, through end: Date) -> [QueryWindow] {
        guard start < end else { return [] }

        let windowDuration: TimeInterval = 7 * 24 * 60 * 60
        var windows: [QueryWindow] = []
        var windowStart = start
        while windowStart < end {
            let windowEnd = min(windowStart.addingTimeInterval(windowDuration), end)
            windows.append(QueryWindow(start: windowStart, end: windowEnd))
            windowStart = windowEnd
        }
        return windows
    }

    static func fetchHourlyAggregates(
        from start: Date,
        through end: Date,
        fetchWindow: (QueryWindow) async throws -> [HourlyAggregate]
    ) async throws -> [HourlyAggregate] {
        var aggregates: [HourlyAggregate] = []
        for window in queryWindows(from: start, through: end) {
            try Task.checkCancellation()
            let windowAggregates = try await fetchWindow(window)
            try Task.checkCancellation()
            aggregates.append(contentsOf: windowAggregates)
        }
        return aggregates
    }

    static func makeStepHourSamples(from aggregates: [HourlyAggregate]) throws -> [StepHourSample] {
        let iso = makeISOFormatter()
        var samples: [StepHourSample] = []
        samples.reserveCapacity(aggregates.count)

        for aggregate in aggregates {
            guard aggregate.count.isFinite, aggregate.count >= 0 else {
                CrashReporting.log("healthkit_steps_invalid_hour_skipped")
                continue
            }
            guard aggregate.count > 0 else { continue }

            let count = Int(aggregate.count.rounded())
            guard count > 0, count <= 200_000 else {
                CrashReporting.log("healthkit_steps_invalid_hour_skipped")
                continue
            }
            samples.append(StepHourSample(hourStartUtc: iso.string(from: aggregate.hourStart), count: count))
        }

        return samples.sorted { $0.hourStartUtc < $1.hourStartUtc }
    }

    static func fetchStepHours(
        from start: Date,
        through end: Date,
        store: HKHealthStore = HKHealthStore()
    ) async throws -> [StepHourSample] {
        #if DEBUG
        if ProcessInfo.processInfo.arguments.contains("-FamilyOSLocalSmoke") {
            CrashReporting.log("healthkit_steps_fetch_skipped_for_local_smoke")
            return []
        }
        #endif

        guard let stepType = HKObjectType.quantityType(forIdentifier: .stepCount) else {
            return []
        }

        let queryStart = utcHourStart(atOrBefore: start)
        let aggregates = try await fetchHourlyAggregates(from: queryStart, through: end) { window in
            let predicate = HKQuery.predicateForSamples(
                withStart: window.start,
                end: window.end,
                options: .strictStartDate
            )
            let statistics = try await queryHourlyStatistics(
                store: store,
                stepType: stepType,
                predicate: predicate,
                anchorDate: utcEpoch(),
                from: window.start,
                through: window.end
            )
            return statistics.compactMap { statistic in
                guard statistic.startDate < window.end,
                      let quantity = statistic.sumQuantity() else { return nil }
                return HourlyAggregate(
                    hourStart: statistic.startDate,
                    count: quantity.doubleValue(for: .count())
                )
            }
        }

        let samples = try makeStepHourSamples(from: aggregates)
        try Task.checkCancellation()

        CrashReporting.log("healthkit_steps_hour_count=\(samples.count)")
        return samples
    }

    static func enqueueSamples(_ samples: [StepHourSample], into syncStore: HealthKitSyncStore) throws {
        let encoder = JSONEncoder()
        var ops: [PendingOpRecord] = []
        ops.reserveCapacity(samples.count)
        for sample in samples {
            let payload = HealthKitOpPayloadWire.stepsHour(
                hourStartUtc: sample.hourStartUtc,
                count: sample.count
            )
            let payloadData = try encoder.encode(payload)
            ops.append(
                PendingOpRecord(
                    opId: UUID().uuidString.lowercased(),
                    naturalKey: naturalKey(for: sample),
                    groupKey: "activity",
                    scopeKey: "steps",
                    op: "upsert",
                    payloadJSON: String(data: payloadData, encoding: .utf8)
                )
            )
        }
        try syncStore.enqueue(ops: ops)
    }

    private static func queryHourlyStatistics(
        store: HKHealthStore,
        stepType: HKQuantityType,
        predicate: NSPredicate,
        anchorDate: Date,
        from: Date,
        through: Date
    ) async throws -> [HKStatistics] {
        let state = StatisticsQueryState()
        return try await withTaskCancellationHandler {
            try await withCheckedThrowingContinuation { continuation in
                let query = HKStatisticsCollectionQuery(
                    quantityType: stepType,
                    quantitySamplePredicate: predicate,
                    options: .cumulativeSum,
                    anchorDate: anchorDate,
                    intervalComponents: DateComponents(hour: 1)
                )
                query.initialResultsHandler = { _, collection, error in
                    if let error {
                        state.finish(.failure(error))
                        return
                    }
                    var results: [HKStatistics] = []
                    collection?.enumerateStatistics(from: from, to: through) { statistic, _ in
                        results.append(statistic)
                    }
                    state.finish(.success(results))
                }
                state.installAndExecute(query, store: store, continuation: continuation)
            }
        } onCancel: {
            state.cancel()
        }
    }

    private static func utcHourStart(atOrBefore date: Date) -> Date {
        var calendar = Calendar(identifier: .gregorian)
        calendar.timeZone = TimeZone(secondsFromGMT: 0)!
        return calendar.dateInterval(of: .hour, for: date)?.start ?? date
    }

    private static func utcEpoch() -> Date {
        Date(timeIntervalSince1970: 0)
    }

    private static func makeISOFormatter() -> ISO8601DateFormatter {
        let formatter = ISO8601DateFormatter()
        formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return formatter
    }
}
