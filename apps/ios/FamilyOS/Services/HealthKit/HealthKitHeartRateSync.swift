import Foundation
import HealthKit

/// Daily heart-rate statistics over an explicit server-supplied range.
/// Aggregates only; raw HealthKit samples never leave the device.
enum HealthKitHeartRateSync {
    struct HeartRateDaySample: Sendable, Equatable {
        let localDay: String
        let averageValue: Double
        let minimumValue: Double
        let maximumValue: Double
        let latestValue: Double
        let sampleCount: Int
    }

    struct HeartRateInstant: Sendable, Equatable {
        let date: Date
        let bpm: Double
    }

    static func naturalKey(for sample: HeartRateDaySample) -> String {
        "daily_metric:heart_rate:\(sample.localDay)"
    }

    static func fetchHeartRateDays(
        from start: Date,
        through end: Date,
        healthTimezone: String,
        store: HKHealthStore = HKHealthStore()
    ) async throws -> [HeartRateDaySample] {
        #if DEBUG
        if ProcessInfo.processInfo.arguments.contains("-FamilyOSLocalSmoke") {
            CrashReporting.log("healthkit_heart_rate_fetch_skipped_for_local_smoke")
            return []
        }
        #endif

        guard let hrType = HKQuantityType.quantityType(forIdentifier: .heartRate) else {
            return []
        }

        let predicate = HKQuery.predicateForSamples(withStart: start, end: end, options: .strictStartDate)
        let samples: [HKQuantitySample] = try await querySamples(
            store: store,
            sampleType: hrType,
            predicate: predicate
        )
        CrashReporting.log("healthkit_heart_rate_raw_sample_count=\(samples.count)")

        let unit = HKUnit.count().unitDivided(by: .minute())
        let instants = samples.map { sample in
            HeartRateInstant(date: sample.endDate, bpm: sample.quantity.doubleValue(for: unit))
        }
        let days = makeHeartRateDays(from: instants, healthTimezone: healthTimezone)
        CrashReporting.log("healthkit_heart_rate_day_count=\(days.count)")
        return days
    }

    static func makeHeartRateDays(
        from instants: [HeartRateInstant],
        healthTimezone: String
    ) -> [HeartRateDaySample] {
        let timeZone = TimeZone(identifier: healthTimezone) ?? .current
        var calendar = Calendar(identifier: .gregorian)
        calendar.timeZone = timeZone

        var byDay: [String: [HeartRateInstant]] = [:]
        for instant in instants {
            guard instant.bpm.isFinite, instant.bpm >= 20, instant.bpm <= 250 else {
                CrashReporting.log("healthkit_heart_rate_invalid_sample_skipped")
                continue
            }
            let day = dayString(for: instant.date, calendar: calendar)
            byDay[day, default: []].append(instant)
        }

        return byDay.keys.sorted().compactMap { day in
            guard var samples = byDay[day], !samples.isEmpty else { return nil }
            samples.sort { $0.date < $1.date }
            let values = samples.map(\.bpm)
            let minimum = values.min() ?? values[0]
            let maximum = values.max() ?? values[0]
            let average = values.reduce(0, +) / Double(values.count)
            let latest = samples[samples.count - 1].bpm
            guard average.isFinite, average >= minimum, average <= maximum else { return nil }
            return HeartRateDaySample(
                localDay: day,
                averageValue: average,
                minimumValue: minimum,
                maximumValue: maximum,
                latestValue: latest,
                sampleCount: values.count
            )
        }
    }

    static func enqueueSamples(_ samples: [HeartRateDaySample], into syncStore: HealthKitSyncStore) throws {
        let encoder = JSONEncoder()
        var ops: [PendingOpRecord] = []
        ops.reserveCapacity(samples.count)
        for sample in samples {
            let payload = HealthKitOpPayloadWire.dailyMetric(
                healthMetric: "heart_rate",
                localDay: sample.localDay,
                sumValue: nil,
                averageValue: sample.averageValue,
                minimumValue: sample.minimumValue,
                maximumValue: sample.maximumValue,
                latestValue: sample.latestValue,
                sampleCount: sample.sampleCount
            )
            let data = try encoder.encode(payload)
            ops.append(
                PendingOpRecord(
                    opId: UUID().uuidString.lowercased(),
                    naturalKey: naturalKey(for: sample),
                    groupKey: "vitals",
                    scopeKey: "heart_rate",
                    op: "upsert",
                    payloadJSON: String(data: data, encoding: .utf8)
                )
            )
        }
        try syncStore.enqueue(ops: ops)
    }

    private static func dayString(for date: Date, calendar: Calendar) -> String {
        let parts = calendar.dateComponents([.year, .month, .day], from: date)
        let y = parts.year ?? 1970
        let m = parts.month ?? 1
        let d = parts.day ?? 1
        return String(format: "%04d-%02d-%02d", y, m, d)
    }

    private static func querySamples<T: HKSample>(
        store: HKHealthStore,
        sampleType: HKSampleType,
        predicate: NSPredicate
    ) async throws -> [T] {
        try await withCheckedThrowingContinuation { continuation in
            let query = HKSampleQuery(
                sampleType: sampleType,
                predicate: predicate,
                limit: HKObjectQueryNoLimit,
                sortDescriptors: [NSSortDescriptor(key: HKSampleSortIdentifierEndDate, ascending: true)]
            ) { _, samples, error in
                if let error {
                    continuation.resume(throwing: error)
                    return
                }
                continuation.resume(returning: (samples as? [T]) ?? [])
            }
            store.execute(query)
        }
    }
}
