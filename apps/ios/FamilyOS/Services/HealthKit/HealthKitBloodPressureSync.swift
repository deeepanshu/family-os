import Foundation
import HealthKit

/// Blood pressure reads over an explicit range supplied by the run module.
/// The run kind owns range selection; no adapter-level window defaults.
enum HealthKitBloodPressureSync {
    struct BPSample: Sendable {
        let sourceObjectKey: String
        let measuredAtUtc: String
        let systolic: Int
        let diastolic: Int
        let pulse: Int?
    }

    static func naturalKey(for sample: BPSample) -> String {
        "blood_pressure:\(sample.sourceObjectKey)"
    }

    static func fetchBloodPressure(
        from start: Date,
        through end: Date,
        store: HKHealthStore = HKHealthStore()
    ) async throws -> [BPSample] {
        #if DEBUG
        // Headless smoke cannot complete Health permission UI; empty import still proves pipeline.
        if ProcessInfo.processInfo.arguments.contains("-FamilyOSLocalSmoke") {
            CrashReporting.log("healthkit_bp_fetch_skipped_for_local_smoke")
            return []
        }
        #endif
        guard let systolicType = HKQuantityType.quantityType(forIdentifier: .bloodPressureSystolic),
              let diastolicType = HKQuantityType.quantityType(forIdentifier: .bloodPressureDiastolic)
        else {
            return []
        }

        let predicate = HKQuery.predicateForSamples(withStart: start, end: end, options: .strictStartDate)
        let mmHg = HKUnit.millimeterOfMercury()
        let iso = makeISOFormatter()

        // 1) Prefer official BP correlations (most clinical sources write these).
        var results = try await fetchFromCorrelations(
            store: store,
            systolicType: systolicType,
            diastolicType: diastolicType,
            predicate: predicate,
            mmHg: mmHg,
            iso: iso
        )
        CrashReporting.log("healthkit_bp_correlation_count=\(results.count)")

        // 2) Fallback: pair raw systolic/diastolic quantity samples.
        // Some apps / manual entries only write quantity samples without a correlation.
        if results.isEmpty {
            results = try await fetchFromQuantityPairs(
                store: store,
                systolicType: systolicType,
                diastolicType: diastolicType,
                predicate: predicate,
                mmHg: mmHg,
                iso: iso
            )
            CrashReporting.log("healthkit_bp_quantity_pair_count=\(results.count)")
        }

        return results
    }

    static func enqueueSamples(_ samples: [BPSample], into syncStore: HealthKitSyncStore) throws {
        let encoder = JSONEncoder()
        encoder.dateEncodingStrategy = .iso8601
        var ops: [PendingOpRecord] = []
        ops.reserveCapacity(samples.count)
        for sample in samples {
            let payload = HealthKitOpPayloadWire.bloodPressure(
                sourceObjectKey: sample.sourceObjectKey,
                measuredAtUtc: sample.measuredAtUtc,
                systolic: sample.systolic,
                diastolic: sample.diastolic,
                pulse: sample.pulse
            )
            let data = try encoder.encode(payload)
            let json = String(data: data, encoding: .utf8)
            ops.append(
                PendingOpRecord(
                    opId: UUID().uuidString.lowercased(),
                    naturalKey: "blood_pressure:\(sample.sourceObjectKey)",
                    groupKey: "vitals",
                    scopeKey: "blood_pressure",
                    op: "upsert",
                    payloadJSON: json
                )
            )
        }
        try syncStore.enqueue(ops: ops)
    }

    // MARK: - Private

    private static func fetchFromCorrelations(
        store: HKHealthStore,
        systolicType: HKQuantityType,
        diastolicType: HKQuantityType,
        predicate: NSPredicate,
        mmHg: HKUnit,
        iso: ISO8601DateFormatter
    ) async throws -> [BPSample] {
        guard let correlationType = HKCorrelationType.correlationType(forIdentifier: .bloodPressure) else {
            return []
        }
        let correlations: [HKCorrelation] = try await querySamples(
            store: store,
            sampleType: correlationType,
            predicate: predicate
        )

        var results: [BPSample] = []
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

            results.append(
                BPSample(
                    sourceObjectKey: correlation.uuid.uuidString.lowercased(),
                    measuredAtUtc: isoString(correlation.startDate, iso: iso),
                    systolic: systolic,
                    diastolic: diastolic,
                    pulse: pulse
                )
            )
        }
        return results
    }

    private static func fetchFromQuantityPairs(
        store: HKHealthStore,
        systolicType: HKQuantityType,
        diastolicType: HKQuantityType,
        predicate: NSPredicate,
        mmHg: HKUnit,
        iso: ISO8601DateFormatter
    ) async throws -> [BPSample] {
        // Sequential queries: NSPredicate is not Sendable across concurrent tasks.
        let systolics: [HKQuantitySample] = try await querySamples(
            store: store,
            sampleType: systolicType,
            predicate: predicate
        )
        let diastolics: [HKQuantitySample] = try await querySamples(
            store: store,
            sampleType: diastolicType,
            predicate: predicate
        )
        CrashReporting.log(
            "healthkit_bp_raw_counts systolic=\(systolics.count) diastolic=\(diastolics.count)"
        )

        guard !systolics.isEmpty, !diastolics.isEmpty else { return [] }

        // Greedy match: each systolic pairs with nearest unused diastolic within 2 minutes.
        var unmatchedDiastolic = diastolics
        var results: [BPSample] = []
        let maxDelta: TimeInterval = 120

        for sys in systolics.sorted(by: { $0.startDate < $1.startDate }) {
            guard let bestIndex = unmatchedDiastolic.enumerated()
                .map({ index, dia -> (Int, TimeInterval) in
                    (index, abs(dia.startDate.timeIntervalSince(sys.startDate)))
                })
                .filter({ $0.1 <= maxDelta })
                .min(by: { $0.1 < $1.1 })?
                .0
            else {
                continue
            }
            let dia = unmatchedDiastolic.remove(at: bestIndex)
            let systolic = Int(sys.quantity.doubleValue(for: mmHg).rounded())
            let diastolic = Int(dia.quantity.doubleValue(for: mmHg).rounded())
            guard systolic > diastolic else { continue }

            // Stable key from both sample UUIDs so re-imports stay idempotent.
            let key = [sys.uuid.uuidString, dia.uuid.uuidString]
                .map { $0.lowercased() }
                .sorted()
                .joined(separator: "+")

            results.append(
                BPSample(
                    sourceObjectKey: key,
                    measuredAtUtc: isoString(sys.startDate, iso: iso),
                    systolic: systolic,
                    diastolic: diastolic,
                    pulse: nil
                )
            )
        }
        return results
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
