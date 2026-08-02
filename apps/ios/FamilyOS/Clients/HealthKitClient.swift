import Foundation
import HealthKit

/// Minimal HealthKit availability + auth wrapper.
///
/// Auth must never process-kill: HealthKit can raise NSExceptions from
/// `requestAuthorization` (`_throwIfAuthorizationDisallowedForSharing`).
struct HealthKitClient {
    private let store = HKHealthStore()

    var isAvailable: Bool {
        HKHealthStore.isHealthDataAvailable()
    }

    /// Soft auth for settings save — never throws (settings already on server).
    func requestAuthorizationSoft(for metrics: Set<HealthKitSyncMetric>) async {
        do {
            try await requestAuthorization(for: metrics)
            CrashReporting.healthKit(.authRequested, group: metrics.first?.rawValue)
        } catch {
            CrashReporting.healthKitNonFatal(
                .fetchFailed,
                stage: .authRequested,
                message: "healthkit_auth_soft_failed",
                underlying: error
            )
        }
    }

    /// Requests read access for types we actually sync (narrow v1: BP under vitals).
    func requestAuthorization(for metrics: Set<HealthKitSyncMetric>) async throws {
        guard isAvailable else { return }
        #if DEBUG
        if ProcessInfo.processInfo.arguments.contains("-FamilyOSLocalSmoke") {
            CrashReporting.log("healthkit_auth_skipped_for_local_smoke")
            return
        }
        #endif

        let types = readTypes(for: metrics)
        guard !types.isEmpty else {
            CrashReporting.log("healthkit_auth_skipped_empty_types")
            return
        }

        try await withCheckedThrowingContinuation { (continuation: CheckedContinuation<Void, Error>) in
            DispatchQueue.main.async {
                var resumed = false
                let resumeOnce: (Result<Void, Error>) -> Void = { result in
                    guard !resumed else { return }
                    resumed = true
                    continuation.resume(with: result)
                }

                let exception = HealthKitAuthExceptionCatcher.performAndReturnException {
                    // Empty share set — we never write to HealthKit.
                    self.store.requestAuthorization(toShare: Set<HKSampleType>(), read: types) { _, error in
                        if let error {
                            resumeOnce(.failure(error))
                        } else {
                            resumeOnce(.success(()))
                        }
                    }
                }

                if let exception {
                    CrashReporting.log(
                        "healthkit_auth_ns_exception name=\(exception.name.rawValue)"
                    )
                    resumeOnce(
                        .failure(
                            NSError(
                                domain: CrashReporting.healthKitErrorDomain,
                                code: CrashReporting.HealthKitCode.fetchFailed.rawValue,
                                userInfo: [
                                    NSLocalizedDescriptionKey: exception.reason
                                        ?? "HealthKit authorization is not allowed on this device."
                                ]
                            )
                        )
                    )
                }
            }
        }
    }

    /// Milestone 1: blood-pressure types only under vitals. No full registry matrix.
    private func readTypes(for metrics: Set<HealthKitSyncMetric>) -> Set<HKObjectType> {
        var types = Set<HKObjectType>()
        if metrics.contains(.vitals) {
            if let correlation = HKObjectType.correlationType(forIdentifier: .bloodPressure) {
                types.insert(correlation)
            }
            if let systolic = HKObjectType.quantityType(forIdentifier: .bloodPressureSystolic) {
                types.insert(systolic)
            }
            if let diastolic = HKObjectType.quantityType(forIdentifier: .bloodPressureDiastolic) {
                types.insert(diastolic)
            }
        }
        return types
    }
}
