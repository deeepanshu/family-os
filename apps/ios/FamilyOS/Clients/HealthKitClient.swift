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
    ///
    /// Prefer `ensureReadAuthorization` on the sync path so we only prompt when needed.
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

        try await performAuthorizationRequest(read: types)
    }

    /// Ensures HealthKit read access for milestone metrics. Prompts when status is
    /// `.shouldRequest` / `.unknown`. Does not prove the user enabled every toggle
    /// (Apple hides denied-vs-granted for reads); callers must still handle empty queries.
    func ensureReadAuthorization(for metrics: Set<HealthKitSyncMetric>) async throws {
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

        let requestStatus = try await withCheckedThrowingContinuation {
            (continuation: CheckedContinuation<HKAuthorizationRequestStatus, Error>) in
            store.getRequestStatusForAuthorization(toShare: Set<HKSampleType>(), read: types) { status, error in
                if let error {
                    continuation.resume(throwing: error)
                } else {
                    continuation.resume(returning: status)
                }
            }
        }

        switch requestStatus {
        case .unnecessary:
            CrashReporting.log("healthkit_auth_status=unnecessary")
            return
        case .shouldRequest, .unknown:
            CrashReporting.log("healthkit_auth_status=\(String(describing: requestStatus)) prompting")
            try await performAuthorizationRequest(read: types)
        @unknown default:
            try await performAuthorizationRequest(read: types)
        }
    }

    private func performAuthorizationRequest(read types: Set<HKObjectType>) async throws {
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
                    self.store.requestAuthorization(toShare: Set<HKSampleType>(), read: types) { success, error in
                        if let error {
                            resumeOnce(.failure(error))
                        } else if !success {
                            // Rare: no NSError but system did not complete authorization.
                            resumeOnce(
                                .failure(
                                    NSError(
                                        domain: HKError.errorDomain,
                                        code: HKError.Code.errorAuthorizationNotDetermined.rawValue,
                                        userInfo: [
                                            NSLocalizedDescriptionKey:
                                                "Health authorization was not completed. Enable Blood Pressure for Kinstead in Settings → Health → Data Access."
                                        ]
                                    )
                                )
                            )
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
    ///
    /// Do **not** request `HKCorrelationType.bloodPressure` for authorization — HealthKit
    /// rejects it with `NSInvalidArgumentException` ("Authorization to read … is disallowed").
    /// Request the underlying quantity types; correlation samples are still queryable after.
    private func readTypes(for metrics: Set<HealthKitSyncMetric>) -> Set<HKObjectType> {
        var types = Set<HKObjectType>()
        if metrics.contains(.vitals) {
            if let systolic = HKObjectType.quantityType(forIdentifier: .bloodPressureSystolic) {
                types.insert(systolic)
            }
            if let diastolic = HKObjectType.quantityType(forIdentifier: .bloodPressureDiastolic) {
                types.insert(diastolic)
            }
            // Optional pulse attached to BP correlations.
            if let heartRate = HKObjectType.quantityType(forIdentifier: .heartRate) {
                types.insert(heartRate)
            }
        }
        return types
    }
}
