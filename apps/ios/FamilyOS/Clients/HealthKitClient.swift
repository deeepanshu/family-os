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

    /// Sequential Health permission overlays per enabled group:
    /// - vitals: BP (required) then pulse (best-effort)
    /// - sleep: sleepAnalysis
    ///
    /// Never request `HKCorrelationType.bloodPressure` for auth (HealthKit rejects it).
    /// Request quantity types only; correlations remain queryable after grant.
    func requestAuthorization(for metrics: Set<HealthKitSyncMetric>) async throws {
        guard isAvailable else { return }
        #if DEBUG
        if ProcessInfo.processInfo.arguments.contains("-FamilyOSLocalSmoke") {
            CrashReporting.log("healthkit_auth_skipped_for_local_smoke")
            return
        }
        #endif

        guard !metrics.isEmpty else {
            CrashReporting.log("healthkit_auth_skipped_empty_metrics")
            return
        }

        // Stable order: vitals overlays then sleep. Never early-return past later groups.
        if metrics.contains(.vitals) {
            let bpTypes = Self.bloodPressureReadTypes()
            if bpTypes.isEmpty {
                CrashReporting.log("healthkit_auth_skipped_empty_bp_types")
            } else {
                CrashReporting.log("healthkit_auth_requesting_bp \(Self.typeIds(bpTypes))")
                try await performAuthorizationRequest(read: bpTypes)

                // Overlay 2: Pulse (heart rate). Best-effort so a deny/skip cannot block BP.
                let pulseTypes = Self.pulseReadTypes()
                if !pulseTypes.isEmpty {
                    CrashReporting.log("healthkit_auth_requesting_pulse \(Self.typeIds(pulseTypes))")
                    do {
                        try await performAuthorizationRequest(read: pulseTypes)
                    } catch {
                        CrashReporting.healthKitNonFatal(
                            .fetchFailed,
                            stage: .authRequested,
                            message: "healthkit_auth_pulse_soft_failed",
                            group: "vitals",
                            metric: "heart_rate",
                            underlying: error
                        )
                    }
                }
            }
        }

        if metrics.contains(.sleep) {
            let sleepTypes = Self.sleepReadTypes()
            if sleepTypes.isEmpty {
                CrashReporting.log("healthkit_auth_skipped_empty_sleep_types")
            } else {
                CrashReporting.log("healthkit_auth_requesting_sleep \(Self.typeIds(sleepTypes))")
                try await performAuthorizationRequest(read: sleepTypes)
            }
        }
    }

    func ensureReadAuthorization(for metrics: Set<HealthKitSyncMetric>) async throws {
        try await requestAuthorization(for: metrics)
    }

    /// Combined set for tests / diagnostics.
    static func readTypes(for metrics: Set<HealthKitSyncMetric>) -> Set<HKObjectType> {
        var types = Set<HKObjectType>()
        if metrics.contains(.vitals) {
            types.formUnion(bloodPressureReadTypes())
            types.formUnion(pulseReadTypes())
        }
        if metrics.contains(.sleep) {
            types.formUnion(sleepReadTypes())
        }
        return types
    }

    static func bloodPressureReadTypes() -> Set<HKObjectType> {
        var types = Set<HKObjectType>()
        if let systolic = HKObjectType.quantityType(forIdentifier: .bloodPressureSystolic) {
            types.insert(systolic)
        }
        if let diastolic = HKObjectType.quantityType(forIdentifier: .bloodPressureDiastolic) {
            types.insert(diastolic)
        }
        return types
    }

    static func pulseReadTypes() -> Set<HKObjectType> {
        var types = Set<HKObjectType>()
        if let heartRate = HKObjectType.quantityType(forIdentifier: .heartRate) {
            types.insert(heartRate)
        }
        return types
    }

    static func sleepReadTypes() -> Set<HKObjectType> {
        var types = Set<HKObjectType>()
        if let sleep = HKObjectType.categoryType(forIdentifier: .sleepAnalysis) {
            types.insert(sleep)
        }
        return types
    }

    static func typeIds(_ types: Set<HKObjectType>) -> String {
        types.map(\.identifier).sorted().joined(separator: ",")
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
                    self.store.requestAuthorization(toShare: Set<HKSampleType>(), read: types) { success, error in
                        if let error {
                            resumeOnce(.failure(error))
                        } else if !success {
                            resumeOnce(
                                .failure(
                                    NSError(
                                        domain: HKError.errorDomain,
                                        code: HKError.Code.errorAuthorizationNotDetermined.rawValue,
                                        userInfo: [
                                            NSLocalizedDescriptionKey:
                                                "Health authorization was not completed. Enable the requested types for Kinstead in Settings → Health → Data Access."
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
}
