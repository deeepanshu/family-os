import Foundation
import HealthKit

/// Sample-level blood glucose reads. Range is usually the run descriptor;
/// the first vitals fetch after this adapter ships widens to 90 days once
/// so already-imported vitals users get glucose without Repair.
enum HealthKitBloodGlucoseSync {
    nonisolated(unsafe) static var defaults: UserDefaults = .standard
    static let initialBackfillCompletedKey = "healthkit.bloodGlucose.initialBackfillCompleted"
    static let pageSize = 1_000
    static let valueRangeMgDl = 20.0 ... 700.0
    static let initialBackfillInterval: TimeInterval = 90 * 24 * 60 * 60

    struct GlucoseSample: Sendable, Equatable {
        let sourceSampleKey: String
        let measuredAtUtc: String
        let valueMgDl: Double
        let mealTime: String?
    }

    static func naturalKey(for sample: GlucoseSample) -> String {
        "blood_glucose:\(sample.sourceSampleKey)"
    }

    static func fetchStart(serverFrom: Date, through end: Date) -> Date {
        if defaults.bool(forKey: initialBackfillCompletedKey) {
            return serverFrom
        }
        return end.addingTimeInterval(-initialBackfillInterval)
    }

    static func markInitialBackfillCompleted() {
        defaults.set(true, forKey: initialBackfillCompletedKey)
    }

    static func fetchBloodGlucose(
        from serverFrom: Date,
        through end: Date,
        store: HKHealthStore = HKHealthStore()
    ) async throws -> [GlucoseSample] {
        #if DEBUG
        if ProcessInfo.processInfo.arguments.contains("-FamilyOSLocalSmoke") {
            CrashReporting.log("healthkit_glucose_fetch_skipped_for_local_smoke")
            return []
        }
        #endif
        guard let glucoseType = HKQuantityType.quantityType(forIdentifier: .bloodGlucose) else {
            return []
        }

        let start = fetchStart(serverFrom: serverFrom, through: end)
        let mgDl = HKUnit.gramUnit(with: .milli).unitDivided(by: HKUnit.literUnit(with: .deci))
        let iso = makeISOFormatter()
        var cursor = start
        var seen = Set<UUID>()
        var results: [GlucoseSample] = []

        while true {
            let predicate = HKQuery.predicateForSamples(withStart: cursor, end: end, options: .strictStartDate)
            let page: [HKQuantitySample] = try await querySamples(
                store: store,
                sampleType: glucoseType,
                predicate: predicate,
                limit: pageSize
            )
            if page.isEmpty { break }

            var added = 0
            for sample in page {
                if !seen.insert(sample.uuid).inserted { continue }
                added += 1
                let value = sample.quantity.doubleValue(for: mgDl)
                guard value.isFinite, valueRangeMgDl.contains(value) else { continue }
                results.append(
                    GlucoseSample(
                        sourceSampleKey: sample.uuid.uuidString.lowercased(),
                        measuredAtUtc: isoString(sample.startDate, iso: iso),
                        valueMgDl: value,
                        mealTime: mealTime(from: sample.metadata)
                    )
                )
            }

            if page.count < pageSize { break }
            guard let lastStart = page.last?.startDate else { break }
            if lastStart <= cursor {
                if added == 0 { break }
                cursor = lastStart.addingTimeInterval(0.001)
            } else {
                cursor = lastStart
            }
        }

        CrashReporting.log("healthkit_glucose_sample_count=\(results.count)")
        return results
    }

    static func enqueueSamples(_ samples: [GlucoseSample], into syncStore: HealthKitSyncStore) throws {
        let encoder = JSONEncoder()
        encoder.dateEncodingStrategy = .iso8601
        var ops: [PendingOpRecord] = []
        ops.reserveCapacity(samples.count)
        for sample in samples {
            let payload = HealthKitOpPayloadWire.bloodGlucose(
                sourceSampleKey: sample.sourceSampleKey,
                measuredAtUtc: sample.measuredAtUtc,
                valueMgDl: sample.valueMgDl,
                mealTime: sample.mealTime
            )
            let data = try encoder.encode(payload)
            let json = String(data: data, encoding: .utf8)
            ops.append(
                PendingOpRecord(
                    opId: UUID().uuidString.lowercased(),
                    naturalKey: naturalKey(for: sample),
                    groupKey: "vitals",
                    scopeKey: "blood_glucose",
                    op: "upsert",
                    payloadJSON: json
                )
            )
        }
        try syncStore.enqueue(ops: ops)
    }

    // MARK: - Private

    static func mealTime(from metadata: [String: Any]?) -> String? {
        guard let raw = metadata?[HKMetadataKeyBloodGlucoseMealTime] else { return nil }
        let value: Int?
        if let number = raw as? NSNumber {
            value = number.intValue
        } else if let int = raw as? Int {
            value = int
        } else {
            value = nil
        }
        guard let value, let meal = HKBloodGlucoseMealTime(rawValue: value) else { return nil }
        switch meal {
        case .preprandial: return "preprandial"
        case .postprandial: return "postprandial"
        @unknown default: return nil
        }
    }

    private static func querySamples<T: HKSample>(
        store: HKHealthStore,
        sampleType: HKSampleType,
        predicate: NSPredicate,
        limit: Int
    ) async throws -> [T] {
        try await withCheckedThrowingContinuation { continuation in
            let query = HKSampleQuery(
                sampleType: sampleType,
                predicate: predicate,
                limit: limit,
                sortDescriptors: [NSSortDescriptor(key: HKSampleSortIdentifierStartDate, ascending: true)]
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

    private static func makeISOFormatter() -> ISO8601DateFormatter {
        let iso = ISO8601DateFormatter()
        iso.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return iso
    }

    private static func isoString(_ date: Date, iso: ISO8601DateFormatter) -> String {
        var measuredString = iso.string(from: date)
        if measuredString.isEmpty {
            let fallback = ISO8601DateFormatter()
            fallback.formatOptions = [.withInternetDateTime]
            measuredString = fallback.string(from: date)
        }
        return measuredString
    }
}
