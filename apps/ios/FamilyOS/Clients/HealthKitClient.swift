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

struct HealthKitClient {
    private let store = HKHealthStore()
    private let sampleLimit = HKObjectQueryNoLimit

    var isAvailable: Bool {
        HKHealthStore.isHealthDataAvailable()
    }

    func requestAuthorization() async throws {
        guard isAvailable else { throw HealthKitClientError.unavailable }
        try await store.requestAuthorization(toShare: [], read: Set(readTypes()))
    }

    func readSamples(since startDate: Date, until endDate: Date = Date()) async throws -> [HealthKitSampleInput] {
        guard isAvailable else { throw HealthKitClientError.unavailable }
        var samples: [HealthKitSampleInput] = []
        if let steps = try? await readDailyQuantitySummaries(metricType: .steps, identifier: .stepCount, unit: .count(), since: startDate, until: endDate) {
            samples += steps
        }
        if let distance = try? await readDailyQuantitySummaries(metricType: .walkingDistance, identifier: .distanceWalkingRunning, unit: .meter(), since: startDate, until: endDate) {
            samples += distance
        }
        if let weight = try? await readQuantitySamples(metricType: .weight, identifier: .bodyMass, unit: .gramUnit(with: .kilo), since: startDate, until: endDate) {
            samples += weight
        }
        if let glucose = try? await readGlucoseSamples(since: startDate, until: endDate) {
            samples += glucose
        }
        if let sleep = try? await readSleepSamples(since: startDate, until: endDate) {
            samples += sleep
        }
        if let bloodPressure = try? await readBloodPressureSamples(since: startDate, until: endDate) {
            samples += bloodPressure
        }
        return samples
    }

    private func readTypes() -> [HKObjectType] {
        [
            HKQuantityType.quantityType(forIdentifier: .stepCount),
            HKQuantityType.quantityType(forIdentifier: .distanceWalkingRunning),
            HKQuantityType.quantityType(forIdentifier: .bodyMass),
            HKQuantityType.quantityType(forIdentifier: .bloodGlucose),
            HKQuantityType.quantityType(forIdentifier: .bloodPressureSystolic),
            HKQuantityType.quantityType(forIdentifier: .bloodPressureDiastolic),
            HKCategoryType.categoryType(forIdentifier: .sleepAnalysis)
        ].compactMap { $0 }
    }

    private func readQuantitySamples(
        metricType: HealthKitMetricType,
        identifier: HKQuantityTypeIdentifier,
        unit: HKUnit,
        since startDate: Date,
        until endDate: Date
    ) async throws -> [HealthKitSampleInput] {
        guard let type = HKQuantityType.quantityType(forIdentifier: identifier) else {
            throw HealthKitClientError.sampleTypeUnavailable
        }
        let samples = try await sampleQuery(type: type, since: startDate, until: endDate)
        return samples.compactMap { sample in
            guard let quantity = sample as? HKQuantitySample else { return nil }
            return HealthKitSampleInput(
                metricType: metricType,
                sourceSampleKey: "\(quantity.uuid.uuidString):\(metricType.rawValue)",
                startDate: isoString(quantity.startDate),
                endDate: isoString(quantity.endDate),
                value: quantity.quantity.doubleValue(for: unit),
                unit: unitName(for: metricType),
                systolic: nil,
                diastolic: nil,
                pulse: nil,
                glucoseContext: nil
            )
        }
    }

    private func readDailyQuantitySummaries(
        metricType: HealthKitMetricType,
        identifier: HKQuantityTypeIdentifier,
        unit: HKUnit,
        since startDate: Date,
        until endDate: Date
    ) async throws -> [HealthKitSampleInput] {
        guard let type = HKQuantityType.quantityType(forIdentifier: identifier) else {
            throw HealthKitClientError.sampleTypeUnavailable
        }
        let calendar = Calendar(identifier: .gregorian)
        let startOfDay = calendar.startOfDay(for: startDate)
        let summaries = try await statisticsCollection(
            type: type,
            unit: unit,
            since: startOfDay,
            until: endDate
        )
        return summaries.compactMap { summary in
            guard summary.value > 0 else { return nil }
            let day = dayString(summary.startDate)
            return HealthKitSampleInput(
                metricType: metricType,
                sourceSampleKey: "\(metricType.rawValue):\(day)",
                startDate: isoString(summary.startDate),
                endDate: isoString(summary.endDate),
                value: summary.value,
                unit: unitName(for: metricType),
                systolic: nil,
                diastolic: nil,
                pulse: nil,
                glucoseContext: nil
            )
        }
    }

    private func readGlucoseSamples(since startDate: Date, until endDate: Date) async throws -> [HealthKitSampleInput] {
        guard let type = HKQuantityType.quantityType(forIdentifier: .bloodGlucose) else {
            throw HealthKitClientError.sampleTypeUnavailable
        }
        let unit = HKUnit.gramUnit(with: .milli).unitDivided(by: .literUnit(with: .deci))
        let samples = try await sampleQuery(type: type, since: startDate, until: endDate)
        return samples.compactMap { sample in
            guard let quantity = sample as? HKQuantitySample else { return nil }
            return HealthKitSampleInput(
                metricType: .bloodGlucose,
                sourceSampleKey: "\(quantity.uuid.uuidString):blood_glucose",
                startDate: isoString(quantity.startDate),
                endDate: isoString(quantity.endDate),
                value: quantity.quantity.doubleValue(for: unit),
                unit: "mg/dL",
                systolic: nil,
                diastolic: nil,
                pulse: nil,
                glucoseContext: .random
            )
        }
    }

    private func readSleepSamples(since startDate: Date, until endDate: Date) async throws -> [HealthKitSampleInput] {
        guard let type = HKCategoryType.categoryType(forIdentifier: .sleepAnalysis) else {
            throw HealthKitClientError.sampleTypeUnavailable
        }
        let samples = try await sampleQuery(type: type, since: startDate, until: endDate)
        return samples.compactMap { sample in
            guard let category = sample as? HKCategorySample, isAsleep(category.value) else { return nil }
            return HealthKitSampleInput(
                metricType: .sleep,
                sourceSampleKey: "\(category.uuid.uuidString):sleep",
                startDate: isoString(category.startDate),
                endDate: isoString(category.endDate),
                value: category.endDate.timeIntervalSince(category.startDate) / 60,
                unit: "min",
                systolic: nil,
                diastolic: nil,
                pulse: nil,
                glucoseContext: nil
            )
        }
    }

    private func readBloodPressureSamples(since startDate: Date, until endDate: Date) async throws -> [HealthKitSampleInput] {
        guard
            let type = HKCorrelationType.correlationType(forIdentifier: .bloodPressure),
            let systolicType = HKQuantityType.quantityType(forIdentifier: .bloodPressureSystolic),
            let diastolicType = HKQuantityType.quantityType(forIdentifier: .bloodPressureDiastolic)
        else {
            throw HealthKitClientError.sampleTypeUnavailable
        }
        let correlations = try await correlationQuery(type: type, since: startDate, until: endDate)
        let unit = HKUnit.millimeterOfMercury()
        return correlations.compactMap { correlation in
            guard
                let systolicSample = correlation.objects(for: systolicType).first as? HKQuantitySample,
                let diastolicSample = correlation.objects(for: diastolicType).first as? HKQuantitySample
            else {
                return nil
            }
            return HealthKitSampleInput(
                metricType: .bloodPressure,
                sourceSampleKey: "\(correlation.uuid.uuidString):blood_pressure",
                startDate: isoString(correlation.startDate),
                endDate: isoString(correlation.endDate),
                value: nil,
                unit: "mmHg",
                systolic: Int(systolicSample.quantity.doubleValue(for: unit).rounded()),
                diastolic: Int(diastolicSample.quantity.doubleValue(for: unit).rounded()),
                pulse: nil,
                glucoseContext: nil
            )
        }
    }

    private func sampleQuery(type: HKSampleType, since startDate: Date, until endDate: Date) async throws -> [HKSample] {
        try await withCheckedThrowingContinuation { continuation in
            let predicate = HKQuery.predicateForSamples(withStart: startDate, end: endDate, options: [.strictStartDate])
            let sort = NSSortDescriptor(key: HKSampleSortIdentifierStartDate, ascending: true)
            let query = HKSampleQuery(sampleType: type, predicate: predicate, limit: sampleLimit, sortDescriptors: [sort]) { _, samples, error in
                if let error {
                    continuation.resume(throwing: error)
                } else {
                    continuation.resume(returning: samples ?? [])
                }
            }
            store.execute(query)
        }
    }

    private func correlationQuery(type: HKCorrelationType, since startDate: Date, until endDate: Date) async throws -> [HKCorrelation] {
        try await withCheckedThrowingContinuation { continuation in
            let predicate = HKQuery.predicateForSamples(withStart: startDate, end: endDate, options: [.strictStartDate])
            let sort = NSSortDescriptor(key: HKSampleSortIdentifierStartDate, ascending: true)
            let query = HKSampleQuery(sampleType: type, predicate: predicate, limit: sampleLimit, sortDescriptors: [sort]) { _, samples, error in
                if let error {
                    continuation.resume(throwing: error)
                } else {
                    continuation.resume(returning: (samples ?? []).compactMap { $0 as? HKCorrelation })
                }
            }
            store.execute(query)
        }
    }

    private struct QuantitySummary {
        let startDate: Date
        let endDate: Date
        let value: Double
    }

    private func statisticsCollection(
        type: HKQuantityType,
        unit: HKUnit,
        since startDate: Date,
        until endDate: Date
    ) async throws -> [QuantitySummary] {
        try await withCheckedThrowingContinuation { continuation in
            let interval = DateComponents(day: 1)
            let predicate = HKQuery.predicateForSamples(withStart: startDate, end: endDate, options: [.strictStartDate])
            let query = HKStatisticsCollectionQuery(
                quantityType: type,
                quantitySamplePredicate: predicate,
                options: .cumulativeSum,
                anchorDate: startDate,
                intervalComponents: interval
            )
            query.initialResultsHandler = { _, collection, error in
                if let error {
                    continuation.resume(throwing: error)
                    return
                }
                var output: [QuantitySummary] = []
                collection?.enumerateStatistics(from: startDate, to: endDate) { statistics, _ in
                    if let quantity = statistics.sumQuantity() {
                        output.append(
                            QuantitySummary(
                                startDate: statistics.startDate,
                                endDate: statistics.endDate,
                                value: quantity.doubleValue(for: unit)
                            )
                        )
                    }
                }
                continuation.resume(returning: output)
            }
            store.execute(query)
        }
    }

    private func isAsleep(_ value: Int) -> Bool {
        [
            HKCategoryValueSleepAnalysis.asleepUnspecified.rawValue,
            HKCategoryValueSleepAnalysis.asleepCore.rawValue,
            HKCategoryValueSleepAnalysis.asleepDeep.rawValue,
            HKCategoryValueSleepAnalysis.asleepREM.rawValue
        ].contains(value)
    }

    private func unitName(for metricType: HealthKitMetricType) -> String {
        switch metricType {
        case .steps:
            return "count"
        case .walkingDistance:
            return "m"
        case .weight:
            return "kg"
        case .sleep:
            return "min"
        case .bloodPressure:
            return "mmHg"
        case .bloodGlucose:
            return "mg/dL"
        }
    }

    private func isoString(_ date: Date) -> String {
        ISO8601DateFormatter().string(from: date)
    }

    private func dayString(_ date: Date) -> String {
        let formatter = DateFormatter()
        formatter.calendar = Calendar(identifier: .gregorian)
        formatter.locale = Locale(identifier: "en_US_POSIX")
        formatter.dateFormat = "yyyy-MM-dd"
        return formatter.string(from: date)
    }
}
