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

    var isAvailable: Bool {
        HKHealthStore.isHealthDataAvailable()
    }

    func requestAuthorization() async throws {
        guard isAvailable else { throw HealthKitClientError.unavailable }
        try await store.requestAuthorization(toShare: [], read: Set(readTypes()))
    }

    func readSamples(since startDate: Date, until endDate: Date = Date()) async throws -> [HealthKitSampleInput] {
        guard isAvailable else { throw HealthKitClientError.unavailable }
        async let steps = readQuantitySamples(metricType: .steps, identifier: .stepCount, unit: .count(), since: startDate, until: endDate)
        async let distance = readQuantitySamples(metricType: .walkingDistance, identifier: .distanceWalkingRunning, unit: .meter(), since: startDate, until: endDate)
        async let weight = readQuantitySamples(metricType: .weight, identifier: .bodyMass, unit: .gramUnit(with: .kilo), since: startDate, until: endDate)
        async let glucose = readGlucoseSamples(since: startDate, until: endDate)
        async let sleep = readSleepSamples(since: startDate, until: endDate)
        async let bloodPressure = readBloodPressureSamples(since: startDate, until: endDate)
        return try await steps + distance + weight + glucose + sleep + bloodPressure
    }

    private func readTypes() -> [HKObjectType] {
        [
            HKQuantityType.quantityType(forIdentifier: .stepCount),
            HKQuantityType.quantityType(forIdentifier: .distanceWalkingRunning),
            HKQuantityType.quantityType(forIdentifier: .bodyMass),
            HKQuantityType.quantityType(forIdentifier: .bloodGlucose),
            HKQuantityType.quantityType(forIdentifier: .bloodPressureSystolic),
            HKQuantityType.quantityType(forIdentifier: .bloodPressureDiastolic),
            HKCategoryType.categoryType(forIdentifier: .sleepAnalysis),
            HKCorrelationType.correlationType(forIdentifier: .bloodPressure)
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

    private func correlationQuery(type: HKCorrelationType, since startDate: Date, until endDate: Date) async throws -> [HKCorrelation] {
        try await withCheckedThrowingContinuation { continuation in
            let predicate = HKQuery.predicateForSamples(withStart: startDate, end: endDate, options: [.strictStartDate])
            let sort = NSSortDescriptor(key: HKSampleSortIdentifierStartDate, ascending: true)
            let query = HKSampleQuery(sampleType: type, predicate: predicate, limit: HKObjectQueryNoLimit, sortDescriptors: [sort]) { _, samples, error in
                if let error {
                    continuation.resume(throwing: error)
                } else {
                    continuation.resume(returning: (samples ?? []).compactMap { $0 as? HKCorrelation })
                }
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
}
