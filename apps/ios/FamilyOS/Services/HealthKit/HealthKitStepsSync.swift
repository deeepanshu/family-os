import Foundation
import HealthKit

/// Steps read over an explicit server-supplied range and are stored as complete
/// UTC hour buckets. The adapter uploads aggregates only; raw HealthKit samples
/// never leave the device.
enum HealthKitStepsSync {
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
        let predicate = HKQuery.predicateForSamples(withStart: queryStart, end: end, options: .strictStartDate)
        let statistics = try await queryHourlyStatistics(
            store: store,
            stepType: stepType,
            predicate: predicate,
            anchorDate: utcEpoch(),
            from: queryStart,
            through: end
        )

        var aggregates: [HourlyAggregate] = []
        aggregates.reserveCapacity(statistics.count)
        for statistic in statistics {
            guard let quantity = statistic.sumQuantity() else { continue }
            let value = quantity.doubleValue(for: .count())
            aggregates.append(HourlyAggregate(hourStart: statistic.startDate, count: value))
        }

        let samples = try makeStepHourSamples(from: aggregates)

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
                    continuation.resume(throwing: error)
                    return
                }
                var results: [HKStatistics] = []
                collection?.enumerateStatistics(from: from, to: through) { statistic, _ in
                    results.append(statistic)
                }
                continuation.resume(returning: results)
            }
            store.execute(query)
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
