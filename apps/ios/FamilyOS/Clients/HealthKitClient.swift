import Foundation
import HealthKit

/// Minimal HealthKit availability + auth wrapper.
///
/// Auth must never process-kill: HealthKit can raise NSExceptions from
/// `requestAuthorization` (`_throwIfAuthorizationDisallowedForSharing`).
///
/// **One request only** — never chain BP → pulse → sleep → workouts sheets.
/// Chained `requestAuthorization` calls hang indefinitely when permissions
/// are already granted in Settings.
struct HealthKitClient {
    /// Hard ceiling so Save/Sync UI can never spin forever on a missing HK callback.
    static let authorizationTimeoutSeconds: TimeInterval = 45

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

    /// Single Health permission request for **all** types needed by `metrics`.
    ///
    /// - Never requests `HKCorrelationType.bloodPressure` (HealthKit rejects it).
    /// - Uses quantity types for BP; correlations stay queryable after grant.
    /// - Times out if Apple never calls back (common when access already granted).
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

        let types = Self.readTypes(for: metrics)
        guard !types.isEmpty else {
            CrashReporting.log("healthkit_auth_skipped_empty_types")
            return
        }

        CrashReporting.log(
            "healthkit_auth_requesting_once groups=\(metrics.map(\.rawValue).sorted().joined(separator: ",")) types=\(Self.typeIds(types))"
        )
        try await performAuthorizationRequest(read: types)
    }

    func ensureReadAuthorization(for metrics: Set<HealthKitSyncMetric>) async throws {
        try await requestAuthorization(for: metrics)
    }

    /// Combined set for auth, tests, and diagnostics.
    static func readTypes(for metrics: Set<HealthKitSyncMetric>) -> Set<HKObjectType> {
        var types = Set<HKObjectType>()
        if metrics.contains(.activity) {
            types.formUnion(stepsReadTypes())
        }
        if metrics.contains(.vitals) {
            types.formUnion(bloodPressureReadTypes())
            types.formUnion(pulseReadTypes())
        }
        if metrics.contains(.sleep) {
            types.formUnion(sleepReadTypes())
        }
        if metrics.contains(.workouts) {
            types.formUnion(workoutReadTypes())
        }
        return types
    }

    static func stepsReadTypes() -> Set<HKObjectType> {
        var types = Set<HKObjectType>()
        if let steps = HKObjectType.quantityType(forIdentifier: .stepCount) {
            types.insert(steps)
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

    static func workoutReadTypes() -> Set<HKObjectType> {
        [HKObjectType.workoutType()]
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
        try await withThrowingTaskGroup(of: Void.self) { group in
            group.addTask {
                try await self.performAuthorizationRequestOnce(read: types)
            }
            group.addTask {
                try await Task.sleep(nanoseconds: UInt64(Self.authorizationTimeoutSeconds * 1_000_000_000))
                throw NSError(
                    domain: CrashReporting.healthKitErrorDomain,
                    code: CrashReporting.HealthKitCode.fetchFailed.rawValue,
                    userInfo: [
                        NSLocalizedDescriptionKey:
                            "Health authorization timed out after \(Int(Self.authorizationTimeoutSeconds))s. If you already enabled access in Settings → Health → Data Access → Kinstead, pull to dismiss and tap Sync again."
                    ]
                )
            }
            // First finished wins: success/failure from HK, or timeout.
            try await group.next()
            group.cancelAll()
        }
    }

    private func performAuthorizationRequestOnce(read types: Set<HKObjectType>) async throws {
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

/// HealthKit encrypts samples while the device is locked. Queries then fail with
/// `HKError.errorDatabaseInaccessible` (code 6). Crashlytics on 0.1.0 (61)
/// shows `bg_refresh` beginning every metric then failing fetch with that code,
/// which left server groups on `syncing`.
enum HealthKitDatabaseAccess {
    static func isInaccessible(_ error: Error) -> Bool {
        let ns = error as NSError
        return ns.domain == HKError.errorDomain
            && ns.code == HKError.Code.errorDatabaseInaccessible.rawValue
    }

    static func assertAccessible(store: HKHealthStore = HKHealthStore()) async throws {
        do {
            try await probe(store: store)
        } catch {
            if isInaccessible(error) {
                CrashReporting.log("healthkit_database_inaccessible")
                throw HealthKitRunError.databaseInaccessible
            }
            CrashReporting.log(
                "healthkit_database_probe_other_error domain=\((error as NSError).domain) code=\((error as NSError).code)"
            )
        }
    }

    private static func probe(store: HKHealthStore) async throws {
        try await withCheckedThrowingContinuation { (continuation: CheckedContinuation<Void, Error>) in
            let query = HKSampleQuery(
                sampleType: HKObjectType.workoutType(),
                predicate: nil,
                limit: 1,
                sortDescriptors: nil
            ) { _, _, error in
                if let error {
                    continuation.resume(throwing: error)
                } else {
                    continuation.resume()
                }
            }
            store.execute(query)
        }
    }
}
