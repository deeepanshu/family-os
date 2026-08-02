import Foundation
import HealthKit

/// Foreground BP import: query HealthKit → enqueue natural-key ops → drain.
/// Milestone 1 only; no BG, no other metrics.
enum HealthKitBloodPressureSync {
    static let backfillWindowDays = 90

    struct BPSample: Sendable {
        let sourceObjectKey: String
        let measuredAtUtc: String
        let systolic: Int
        let diastolic: Int
        let pulse: Int?
    }

    static func fetchBloodPressure(
        store: HKHealthStore = HKHealthStore(),
        now: Date = Date()
    ) async throws -> [BPSample] {
        guard let correlationType = HKCorrelationType.correlationType(forIdentifier: .bloodPressure) else {
            return []
        }
        guard let systolicType = HKQuantityType.quantityType(forIdentifier: .bloodPressureSystolic),
              let diastolicType = HKQuantityType.quantityType(forIdentifier: .bloodPressureDiastolic)
        else {
            return []
        }

        let start = Calendar.current.date(byAdding: .day, value: -backfillWindowDays, to: now) ?? now
        let predicate = HKQuery.predicateForSamples(withStart: start, end: now, options: .strictStartDate)

        let correlations: [HKCorrelation] = try await withCheckedThrowingContinuation { continuation in
            let query = HKSampleQuery(
                sampleType: correlationType,
                predicate: predicate,
                limit: HKObjectQueryNoLimit,
                sortDescriptors: [NSSortDescriptor(key: HKSampleSortIdentifierStartDate, ascending: true)]
            ) { _, samples, error in
                if let error {
                    continuation.resume(throwing: error)
                    return
                }
                let rows = (samples as? [HKCorrelation]) ?? []
                continuation.resume(returning: rows)
            }
            store.execute(query)
        }

        let mmHg = HKUnit.millimeterOfMercury()
        var results: [BPSample] = []
        let iso = ISO8601DateFormatter()
        iso.formatOptions = [.withInternetDateTime, .withFractionalSeconds]

        for correlation in correlations {
            guard let systolicSample = correlation.objects(for: systolicType).first as? HKQuantitySample,
                  let diastolicSample = correlation.objects(for: diastolicType).first as? HKQuantitySample
            else {
                continue
            }
            let systolic = Int(systolicSample.quantity.doubleValue(for: mmHg).rounded())
            let diastolic = Int(diastolicSample.quantity.doubleValue(for: mmHg).rounded())
            guard systolic > diastolic else { continue }

            var pulse: Int?
            if let hrType = HKQuantityType.quantityType(forIdentifier: .heartRate),
               let hrSample = correlation.objects(for: hrType).first as? HKQuantitySample
            {
                let unit = HKUnit.count().unitDivided(by: .minute())
                pulse = Int(hrSample.quantity.doubleValue(for: unit).rounded())
            }

            let measured = correlation.startDate
            var measuredString = iso.string(from: measured)
            if measuredString.isEmpty {
                iso.formatOptions = [.withInternetDateTime]
                measuredString = iso.string(from: measured)
            }

            results.append(
                BPSample(
                    sourceObjectKey: correlation.uuid.uuidString.lowercased(),
                    measuredAtUtc: measuredString,
                    systolic: systolic,
                    diastolic: diastolic,
                    pulse: pulse
                )
            )
        }
        return results
    }

    static func enqueueSamples(_ samples: [BPSample], into syncStore: HealthKitSyncStore) throws {
        let encoder = JSONEncoder()
        encoder.dateEncodingStrategy = .iso8601
        for sample in samples {
            let payload = HealthKitOpPayloadWire.bloodPressure(
                sourceObjectKey: sample.sourceObjectKey,
                measuredAtUtc: sample.measuredAtUtc,
                systolic: sample.systolic,
                diastolic: sample.diastolic,
                pulse: sample.pulse
            ) // enum case, not free function
            let data = try encoder.encode(payload)
            let json = String(data: data, encoding: .utf8)
            try syncStore.enqueue(
                op: PendingOpRecord(
                    opId: UUID().uuidString.lowercased(),
                    naturalKey: "blood_pressure:\(sample.sourceObjectKey)",
                    groupKey: "vitals",
                    scopeKey: "blood_pressure",
                    op: "upsert",
                    payloadJSON: json
                )
            )
        }
    }
}
