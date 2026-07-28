import Foundation
import HealthKit

/// HealthKit invokes this completion exactly once to release its background wake.
/// The API does not annotate it as Sendable, but this wrapper only forwards it.
private final class HealthKitObserverCompletion: @unchecked Sendable {
    private let handler: () -> Void

    init(_ handler: @escaping () -> Void) {
        self.handler = handler
    }

    func call() {
        handler()
    }
}

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

struct HealthKitSleepDayTotals {
    var totalMinutes: Int = 0
    var coreMinutes: Int = 0
    var deepMinutes: Int = 0
    var remMinutes: Int = 0
    var unspecifiedAsleepMinutes: Int = 0
    var awakeMinutes: Int = 0
    var inBedMinutes: Int = 0
    var wristTemperatureCelsius: Double?
    var breathingDisturbanceCount: Int?
}

struct HealthKitClient {
    private let store = HKHealthStore()

    var isAvailable: Bool {
        HKHealthStore.isHealthDataAvailable()
    }

    func requestAuthorization(for metrics: Set<HealthKitSyncMetric>) async throws {
        guard isAvailable else { throw HealthKitClientError.unavailable }
        let types = readTypes(for: metrics)
        guard !types.isEmpty else { throw HealthKitClientError.sampleTypeUnavailable }
        let metricSummary = metrics.map(\.rawValue).sorted().joined(separator: ",")
        CrashReporting.setCustomValues([
            "healthkit_stage": "authorization_requested",
            "healthkit_metrics": metricSummary
        ])
        CrashReporting.log("healthkit.authorization_requested metrics=\(metricSummary)")
        try await withCheckedThrowingContinuation { (continuation: CheckedContinuation<Void, Error>) in
            store.requestAuthorization(toShare: nil, read: types) { success, error in
                if let error {
                    CrashReporting.setCustomValues(["healthkit_stage": "authorization_failed"])
                    CrashReporting.log("healthkit.authorization_failed")
                    continuation.resume(throwing: error)
                } else if success {
                    CrashReporting.setCustomValues(["healthkit_stage": "authorization_succeeded"])
                    CrashReporting.log("healthkit.authorization_succeeded")
                    continuation.resume()
                } else {
                    CrashReporting.setCustomValues(["healthkit_stage": "authorization_unavailable"])
                    CrashReporting.log("healthkit.authorization_unavailable")
                    continuation.resume(throwing: HealthKitClientError.unavailable)
                }
            }
        }
    }

    func enableBackgroundDelivery(for metrics: Set<HealthKitSyncMetric>) async throws {
        guard isAvailable else { throw HealthKitClientError.unavailable }
        for type in backgroundDeliveryTypes(for: metrics) {
            CrashReporting.setCustomValues(["healthkit_stage": "background_delivery_requested"])
            CrashReporting.log("healthkit.background_delivery_requested type=\(type.identifier)")
            do {
                try await withCheckedThrowingContinuation { (continuation: CheckedContinuation<Void, Error>) in
                store.enableBackgroundDelivery(for: type, frequency: .immediate) { success, error in
                    if let error {
                        CrashReporting.log("healthkit.background_delivery_unavailable type=\(type.identifier)")
                        continuation.resume(throwing: error)
                    } else if success {
                        CrashReporting.log("healthkit.background_delivery_succeeded type=\(type.identifier)")
                        continuation.resume()
                    } else {
                        CrashReporting.log("healthkit.background_delivery_unavailable type=\(type.identifier)")
                        continuation.resume(throwing: HealthKitClientError.unavailable)
                    }
                }
                }
            } catch {
                // Background delivery is advisory. Foreground sync and the next app launch
                // still reconcile this type, so an unsupported type must not block consent.
                continue
            }
        }
    }

    func observe(
        type: HKSampleType,
        handler: @escaping @Sendable (@escaping @Sendable () -> Void) -> Void
    ) -> HKObserverQuery {
        let query = HKObserverQuery(sampleType: type, predicate: nil) { _, completionHandler, _ in
            let completion = HealthKitObserverCompletion(completionHandler)
            handler { completion.call() }
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
        case .activity:
            return try stepQuantityType()
        case .sleep:
            return try sleepType()
        case .vitals:
            return try bloodPressureType()
        default:
            guard let type = HealthKitDataMetric.metrics(for: metric).compactMap(\.sampleType).first else {
                throw HealthKitClientError.sampleTypeUnavailable
            }
            return type
        }
    }

    /// Blood-pressure correlations do not support background delivery. Their
    /// systolic component is written with every BP correlation and wakes a
    /// sync that reads the complete correlation.
    func backgroundDeliveryType(for metric: HealthKitSyncMetric) throws -> HKSampleType {
        switch metric {
        case .vitals:
            guard let type = HKQuantityType.quantityType(forIdentifier: .bloodPressureSystolic) else {
                throw HealthKitClientError.sampleTypeUnavailable
            }
            return type
        case .activity, .sleep:
            return try sampleType(for: metric)
        default:
            guard let type = backgroundDeliveryTypes(for: [metric]).first else {
                throw HealthKitClientError.sampleTypeUnavailable
            }
            return type
        }
    }

    func backgroundDeliveryTypes(for groups: Set<HealthKitSyncMetric>) -> Set<HKSampleType> {
        var types = Set(
            HealthKitDataMetric.allCases
                .filter { groups.contains($0.group) }
                .compactMap(\.sampleType)
                .filter { !($0 is HKCorrelationType) }
        )
        if groups.contains(.vitals), let systolic = HKQuantityType.quantityType(forIdentifier: .bloodPressureSystolic) {
            types.insert(systolic)
        }
        return types
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

    func sleepSamples(from start: Date, to end: Date) async throws -> [HKCategorySample] {
        let type = try sleepType()
        let samples = try await sampleQuery(type: type, since: start, until: end, options: [])
        return preferredSamples(samples.compactMap { $0 as? HKCategorySample })
    }

    func bloodPressureCorrelations(from start: Date, to end: Date) async throws -> [HKCorrelation] {
        let type = try bloodPressureType()
        let samples = try await sampleQuery(type: type, since: start, until: end)
        return preferredSamples(samples.compactMap { $0 as? HKCorrelation })
    }

    func stepQuantitySamples(from start: Date, to end: Date) async throws -> [HKQuantitySample] {
        let type = try stepQuantityType()
        let samples = try await sampleQuery(type: type, since: start, until: end)
        return samples.compactMap { $0 as? HKQuantitySample }
    }

    func quantitySamples(for metric: HealthKitDataMetric, from start: Date, to end: Date) async throws -> [HKQuantitySample] {
        guard let type = metric.sampleType as? HKQuantityType else { return [] }
        let samples = try await sampleQuery(type: type, since: start, until: end)
        return preferredSamples(samples.compactMap { $0 as? HKQuantitySample })
    }

    func samples(for metric: HealthKitDataMetric, from start: Date, to end: Date) async throws -> [HKSample] {
        guard let type = metric.sampleType else { return [] }
        return try await sampleQuery(type: type, since: start, until: end)
    }

    func workouts(from start: Date, to end: Date) async throws -> [HKWorkout] {
        guard let type = HealthKitDataMetric.workout.sampleType else { return [] }
        let samples = try await sampleQuery(type: type, since: start, until: end)
        return preferredSamples(samples.compactMap { $0 as? HKWorkout })
    }

    func mindfulSessions(from start: Date, to end: Date) async throws -> [HKCategorySample] {
        guard let type = HealthKitDataMetric.mindfulMinutes.sampleType else { return [] }
        let samples = try await sampleQuery(type: type, since: start, until: end)
        return preferredSamples(samples.compactMap { $0 as? HKCategorySample })
    }

    /// HealthKit may surface equivalent writes from a watch, phone, and third-party
    /// apps. Keep the highest-priority overlapping source instead of adding both.
    /// Non-overlapping samples remain, so separate meals or workouts still count.
    private func preferredSamples<T: HKSample>(_ samples: [T]) -> [T] {
        let sorted = samples.sorted { lhs, rhs in
            let lhsRank = sourceRank(lhs)
            let rhsRank = sourceRank(rhs)
            if lhsRank != rhsRank { return lhsRank < rhsRank }
            if lhs.startDate != rhs.startDate { return lhs.startDate < rhs.startDate }
            return lhs.uuid.uuidString < rhs.uuid.uuidString
        }
        var accepted: [T] = []
        for sample in sorted {
            let overlapsAccepted = accepted.contains { existing in
                let startsTogether = abs(existing.startDate.timeIntervalSince(sample.startDate)) < 60
                let endsTogether = abs(existing.endDate.timeIntervalSince(sample.endDate)) < 60
                return startsTogether && endsTogether
                    || (sample.startDate < existing.endDate && existing.startDate < sample.endDate)
            }
            if !overlapsAccepted {
                accepted.append(sample)
            }
        }
        return accepted
    }

    private func sourceRank(_ sample: HKSample) -> Int {
        let source = sample.sourceRevision.source
        let bundle = source.bundleIdentifier.lowercased()
        let product = sample.sourceRevision.productType?.lowercased() ?? ""
        if product.contains("watch") { return 0 }
        if bundle.hasPrefix("com.apple") { return 1 }
        return 2
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

    /// Split sleep samples at profile-local day boundaries before aggregation.
    /// Asleep totals merge intervals so duplicate HealthKit sources do not inflate duration.
    func sleepDayTotals(
        samples: [HKCategorySample],
        timeZoneIdentifier: String
    ) -> [String: HealthKitSleepDayTotals] {
        guard let timeZone = TimeZone(identifier: timeZoneIdentifier) else { return [:] }
        var calendar = Calendar(identifier: .gregorian)
        calendar.timeZone = timeZone

        var asleepIntervals: [String: [(start: Date, end: Date)]] = [:]
        var totals: [String: HealthKitSleepDayTotals] = [:]
        let formatter = DateFormatter()
        formatter.calendar = calendar
        formatter.locale = Locale(identifier: "en_US_POSIX")
        formatter.timeZone = timeZone
        formatter.dateFormat = "yyyy-MM-dd"

        for sample in samples {
            for segment in splitAtLocalDayBoundaries(from: sample.startDate, to: sample.endDate, calendar: calendar) {
                let day = formatter.string(from: segment.start)
                let minutes = max(0, Int((segment.end.timeIntervalSince(segment.start) / 60).rounded()))
                var total = totals[day, default: HealthKitSleepDayTotals()]
                switch sample.value {
                case HKCategoryValueSleepAnalysis.asleepCore.rawValue:
                    total.coreMinutes += minutes
                    asleepIntervals[day, default: []].append(segment)
                case HKCategoryValueSleepAnalysis.asleepDeep.rawValue:
                    total.deepMinutes += minutes
                    asleepIntervals[day, default: []].append(segment)
                case HKCategoryValueSleepAnalysis.asleepREM.rawValue:
                    total.remMinutes += minutes
                    asleepIntervals[day, default: []].append(segment)
                case HKCategoryValueSleepAnalysis.asleepUnspecified.rawValue:
                    total.unspecifiedAsleepMinutes += minutes
                    asleepIntervals[day, default: []].append(segment)
                case HKCategoryValueSleepAnalysis.awake.rawValue:
                    total.awakeMinutes += minutes
                case HKCategoryValueSleepAnalysis.inBed.rawValue:
                    total.inBedMinutes += minutes
                default:
                    break
                }
                totals[day] = total
            }
        }
        for (day, intervals) in asleepIntervals {
            var total = totals[day, default: HealthKitSleepDayTotals()]
            let mergedMinutes = mergeIntervals(intervals).reduce(0) { partial, interval in
                partial + max(0, Int((interval.end.timeIntervalSince(interval.start) / 60).rounded()))
            }
            let sourceStageMinutes = total.coreMinutes + total.deepMinutes + total.remMinutes + total.unspecifiedAsleepMinutes
            total.totalMinutes = min(mergedMinutes, sourceStageMinutes)
            totals[day] = total
        }
        return totals
    }

    private func splitAtLocalDayBoundaries(
        from start: Date,
        to end: Date,
        calendar: Calendar
    ) -> [(start: Date, end: Date)] {
        guard start < end else { return [] }

        var segments: [(start: Date, end: Date)] = []
        var cursor = start
        while cursor < end {
            let dayStart = calendar.startOfDay(for: cursor)
            guard let nextDayStart = calendar.date(byAdding: .day, value: 1, to: dayStart) else { break }
            let segmentEnd = min(nextDayStart, end)
            guard segmentEnd > cursor else { break }
            segments.append((start: cursor, end: segmentEnd))
            cursor = segmentEnd
        }
        return segments
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

    private func readTypes(for metrics: Set<HealthKitSyncMetric>) -> Set<HKObjectType> {
        var types = Set(
            HealthKitDataMetric.allCases
                .filter { metrics.contains($0.group) }
                .compactMap(\.sampleType)
                .filter { !($0 is HKCorrelationType) }
        )
        if metrics.contains(.vitals) {
            [
                HKQuantityType.quantityType(forIdentifier: .bloodPressureSystolic),
                HKQuantityType.quantityType(forIdentifier: .bloodPressureDiastolic)
            ].compactMap { $0 }.forEach { types.insert($0) }
        }
        return types
    }

}
