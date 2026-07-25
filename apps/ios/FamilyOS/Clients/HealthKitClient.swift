import Foundation
import HealthKit

enum HealthKitClientError: LocalizedError {
    case unavailable
    case sampleTypeUnavailable

    var errorDescription: String? {
        switch self {
        case .unavailable:
            return "HealthKit is not available on this device."
        case .sampleTypeUnavailable:
            return "One or more HealthKit sample types are unavailable."
        }
    }
}

struct HealthKitAnchoredChangePage {
    var added: [HKSample]
    var deletedObjectUUIDs: [UUID]
    var newAnchor: HKQueryAnchor
}

struct HealthKitClient {
    private let store = HKHealthStore()

    var isAvailable: Bool {
        HKHealthStore.isHealthDataAvailable()
    }

    func requestAuthorization() async throws {
        guard isAvailable else { throw HealthKitClientError.unavailable }
        try await store.requestAuthorization(toShare: [], read: Set(readTypes()))
    }

    func enableBackgroundDelivery() async throws {
        guard isAvailable else { throw HealthKitClientError.unavailable }
        for type in observerTypes() {
            try await withCheckedThrowingContinuation { (continuation: CheckedContinuation<Void, Error>) in
                store.enableBackgroundDelivery(for: type, frequency: .immediate) { success, error in
                    if let error {
                        continuation.resume(throwing: error)
                    } else if success {
                        continuation.resume()
                    } else {
                        continuation.resume(throwing: HealthKitClientError.unavailable)
                    }
                }
            }
        }
    }

    func observe(type: HKSampleType, handler: @escaping () -> Void) -> HKObserverQuery {
        let query = HKObserverQuery(sampleType: type, predicate: nil) { _, completionHandler, _ in
            handler()
            completionHandler()
        }
        store.execute(query)
        return query
    }

    func stop(_ query: HKQuery) {
        store.stop(query)
    }

    func stepQuantityType() throws -> HKQuantityType {
        guard let type = HKQuantityType.quantityType(forIdentifier: .stepCount) else {
            throw HealthKitClientError.sampleTypeUnavailable
        }
        return type
    }

    func sleepType() throws -> HKCategoryType {
        guard let type = HKCategoryType.categoryType(forIdentifier: .sleepAnalysis) else {
            throw HealthKitClientError.sampleTypeUnavailable
        }
        return type
    }

    func bloodPressureType() throws -> HKCorrelationType {
        guard let type = HKCorrelationType.correlationType(forIdentifier: .bloodPressure) else {
            throw HealthKitClientError.sampleTypeUnavailable
        }
        return type
    }

    func sampleType(for metric: HealthKitSyncMetric) throws -> HKSampleType {
        switch metric {
        case .steps:
            return try stepQuantityType()
        case .sleep:
            return try sleepType()
        case .bloodPressure:
            return try bloodPressureType()
        }
    }

    func anchoredQuery(
        type: HKSampleType,
        anchor: HKQueryAnchor?,
        limit: Int = HKObjectQueryNoLimit
    ) async throws -> HealthKitAnchoredChangePage {
        try await withCheckedThrowingContinuation { continuation in
            let query = HKAnchoredObjectQuery(
                type: type,
                predicate: nil,
                anchor: anchor,
                limit: limit
            ) { _, samples, deleted, newAnchor, error in
                if let error {
                    continuation.resume(throwing: error)
                    return
                }
                continuation.resume(
                    returning: HealthKitAnchoredChangePage(
                        added: samples ?? [],
                        deletedObjectUUIDs: (deleted ?? []).map(\.uuid),
                        newAnchor: newAnchor ?? anchor ?? HKQueryAnchor(fromValue: 0)
                    )
                )
            }
            store.execute(query)
        }
    }

    /// UTC hourly step totals for the given range. Empty when no readable data.
    func hourlyStepCounts(from start: Date, to end: Date) async throws -> [(hourStartUtc: Date, count: Int)] {
        let type = try stepQuantityType()
        let unit = HKUnit.count()
        return try await withCheckedThrowingContinuation { continuation in
            let predicate = HKQuery.predicateForSamples(withStart: start, end: end, options: [.strictStartDate])
            let calendar = Calendar(identifier: .gregorian)
            var utcCalendar = calendar
            utcCalendar.timeZone = TimeZone(secondsFromGMT: 0)!
            let anchorComponents = utcCalendar.dateComponents([.year, .month, .day, .hour], from: start)
            let anchorDate = utcCalendar.date(from: anchorComponents) ?? start
            let query = HKStatisticsCollectionQuery(
                quantityType: type,
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
                var output: [(Date, Int)] = []
                collection?.enumerateStatistics(from: start, to: end) { statistics, _ in
                    if let quantity = statistics.sumQuantity() {
                        let value = Int(quantity.doubleValue(for: unit).rounded())
                        output.append((statistics.startDate, value))
                    }
                }
                continuation.resume(returning: output.map { (hourStartUtc: $0.0, count: $0.1) })
            }
            store.execute(query)
        }
    }

    func sleepAsleepSamples(from start: Date, to end: Date) async throws -> [HKCategorySample] {
        let type = try sleepType()
        // Sleep can start on the preceding local day. Include overlapping samples
        // and let the caller keep only the requested profile-local sleep days.
        let samples = try await sampleQuery(type: type, since: start, until: end, options: [])
        return samples.compactMap { sample in
            guard let category = sample as? HKCategorySample, isAsleep(category.value) else { return nil }
            return category
        }
    }

    func bloodPressureCorrelations(from start: Date, to end: Date) async throws -> [HKCorrelation] {
        let type = try bloodPressureType()
        let samples = try await sampleQuery(type: type, since: start, until: end)
        return samples.compactMap { $0 as? HKCorrelation }
    }

    func stepQuantitySamples(from start: Date, to end: Date) async throws -> [HKQuantitySample] {
        let type = try stepQuantityType()
        let samples = try await sampleQuery(type: type, since: start, until: end)
        return samples.compactMap { $0 as? HKQuantitySample }
    }

    func parseBloodPressure(_ correlation: HKCorrelation) -> (systolic: Int, diastolic: Int, pulse: Int?, measuredAt: Date)? {
        guard
            let systolicType = HKQuantityType.quantityType(forIdentifier: .bloodPressureSystolic),
            let diastolicType = HKQuantityType.quantityType(forIdentifier: .bloodPressureDiastolic),
            let systolicSample = correlation.objects(for: systolicType).first as? HKQuantitySample,
            let diastolicSample = correlation.objects(for: diastolicType).first as? HKQuantitySample
        else {
            return nil
        }
        let unit = HKUnit.millimeterOfMercury()
        let systolic = Int(systolicSample.quantity.doubleValue(for: unit).rounded())
        let diastolic = Int(diastolicSample.quantity.doubleValue(for: unit).rounded())
        var pulse: Int?
        if let heartRateType = HKQuantityType.quantityType(forIdentifier: .heartRate),
           let pulseSample = correlation.objects(for: heartRateType).first as? HKQuantitySample {
            let bpm = HKUnit.count().unitDivided(by: .minute())
            pulse = Int(pulseSample.quantity.doubleValue(for: bpm).rounded())
        }
        return (systolic, diastolic, pulse, correlation.startDate)
    }

    /// Merge overlapping asleep intervals and attribute minutes to profile-local ending day.
    func sleepDayMinutes(
        samples: [HKCategorySample],
        timeZoneIdentifier: String
    ) -> [String: Int] {
        guard let timeZone = TimeZone(identifier: timeZoneIdentifier) else { return [:] }
        var calendar = Calendar(identifier: .gregorian)
        calendar.timeZone = timeZone

        let intervals = samples
            .map { (start: $0.startDate, end: $0.endDate) }
            .sorted { $0.start < $1.start }
        let merged = mergeIntervals(intervals)

        var totals: [String: Int] = [:]
        let formatter = DateFormatter()
        formatter.calendar = calendar
        formatter.locale = Locale(identifier: "en_US_POSIX")
        formatter.timeZone = timeZone
        formatter.dateFormat = "yyyy-MM-dd"

        for interval in merged {
            let minutes = Int((interval.end.timeIntervalSince(interval.start) / 60).rounded())
            let day = formatter.string(from: interval.end)
            totals[day, default: 0] += max(0, minutes)
        }
        return totals
    }

    private func mergeIntervals(_ intervals: [(start: Date, end: Date)]) -> [(start: Date, end: Date)] {
        guard var current = intervals.first else { return [] }
        var result: [(start: Date, end: Date)] = []
        for interval in intervals.dropFirst() {
            if interval.start <= current.end {
                current.end = max(current.end, interval.end)
            } else {
                result.append(current)
                current = interval
            }
        }
        result.append(current)
        return result
    }

    private func sampleQuery(
        type: HKSampleType,
        since startDate: Date,
        until endDate: Date,
        options: HKQueryOptions = [.strictStartDate]
    ) async throws -> [HKSample] {
        try await withCheckedThrowingContinuation { continuation in
            let predicate = HKQuery.predicateForSamples(withStart: startDate, end: endDate, options: options)
            let sort = NSSortDescriptor(key: HKSampleSortIdentifierStartDate, ascending: true)
            let query = HKSampleQuery(sampleType: type, predicate: predicate, limit: HKObjectQueryNoLimit, sortDescriptors: [sort]) { _, samples, error in
                if let error {
                    continuation.resume(throwing: error)
                } else {
                    continuation.resume(returning: samples ?? [])
                }
            }
            store.execute(query)
        }
    }

    private func readTypes() -> [HKObjectType] {
        [
            HKQuantityType.quantityType(forIdentifier: .stepCount),
            HKQuantityType.quantityType(forIdentifier: .bloodPressureSystolic),
            HKQuantityType.quantityType(forIdentifier: .bloodPressureDiastolic),
            HKQuantityType.quantityType(forIdentifier: .heartRate),
            HKCategoryType.categoryType(forIdentifier: .sleepAnalysis),
            HKCorrelationType.correlationType(forIdentifier: .bloodPressure)
        ].compactMap { $0 }
    }

    private func observerTypes() -> [HKSampleType] {
        [
            HKQuantityType.quantityType(forIdentifier: .stepCount),
            HKCategoryType.categoryType(forIdentifier: .sleepAnalysis),
            HKCorrelationType.correlationType(forIdentifier: .bloodPressure)
        ].compactMap { $0 }
    }

    private func isAsleep(_ value: Int) -> Bool {
        [
            HKCategoryValueSleepAnalysis.asleepUnspecified.rawValue,
            HKCategoryValueSleepAnalysis.asleepCore.rawValue,
            HKCategoryValueSleepAnalysis.asleepDeep.rawValue,
            HKCategoryValueSleepAnalysis.asleepREM.rawValue
        ].contains(value)
    }
}
