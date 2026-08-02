import Foundation
import HealthKit

/// Minimal HealthKit availability + auth wrapper.
///
/// The previous full sync stack (engine, outbox, BG coordinator, worker) was removed.
/// Rebuild against `docs/HEALTHKIT_CORRECTNESS_FIRST_SYNC_PLAN.md` — do not reintroduce
/// entity versions, dual stores, or MainActor-owned BGTask handlers.
struct HealthKitClient {
    private let store = HKHealthStore()

    var isAvailable: Bool {
        HKHealthStore.isHealthDataAvailable()
    }

    /// Requests read access for the selected consent groups. No background delivery yet.
    func requestAuthorization(for metrics: Set<HealthKitSyncMetric>) async throws {
        guard isAvailable else { return }
        #if DEBUG
        // Headless simulator smoke cannot tap the system Health permission sheet.
        if ProcessInfo.processInfo.arguments.contains("-FamilyOSLocalSmoke") {
            CrashReporting.log("healthkit_auth_skipped_for_local_smoke")
            return
        }
        #endif
        let types = readTypes(for: metrics)
        guard !types.isEmpty else { return }
        try await withCheckedThrowingContinuation { (continuation: CheckedContinuation<Void, Error>) in
            store.requestAuthorization(toShare: nil, read: types) { _, error in
                if let error {
                    continuation.resume(throwing: error)
                } else {
                    continuation.resume()
                }
            }
        }
    }

    private func readTypes(for metrics: Set<HealthKitSyncMetric>) -> Set<HKObjectType> {
        var types = Set<HKObjectType>()
        for metric in metrics {
            for dataMetric in HealthKitDataMetric.metrics(for: metric) {
                if let sampleType = dataMetric.sampleType {
                    types.insert(sampleType)
                }
            }
        }
        if metrics.contains(.vitals) {
            if let systolic = HKQuantityType.quantityType(forIdentifier: .bloodPressureSystolic) {
                types.insert(systolic)
            }
            if let diastolic = HKQuantityType.quantityType(forIdentifier: .bloodPressureDiastolic) {
                types.insert(diastolic)
            }
        }
        return types
    }
}
