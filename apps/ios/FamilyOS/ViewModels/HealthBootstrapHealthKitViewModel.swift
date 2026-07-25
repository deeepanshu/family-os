import Foundation

extension HealthBootstrapViewModel {
    private var syncEngine: HealthKitSyncEngine { HealthKitSyncEngine() }
    private var syncStateStore: HealthKitSyncStateStore { HealthKitSyncStateStore() }

    func loadHealthKitStatus() async {
        healthKit.isAvailable = healthKitClient.isAvailable
        await request {
            let status = try await client.healthKitSettings(
                baseURL: connection.baseURL,
                accessToken: auth.accessToken,
                personId: selfProfile?.id
            )
            healthKit.apply(status: status)
            try await persistLocalConfiguration(from: status)
            if status.consentActive {
                HealthKitBackgroundSyncCoordinator.shared.configureObservers(for: status.enabledMetrics)
            } else {
                HealthKitBackgroundSyncCoordinator.shared.stopObservers()
            }
            return "Loaded HealthKit sync status."
        }
    }

    func saveHealthKitSettings(replaceInstallation: Bool = false) async {
        guard let personId = selfProfile?.id else {
            isError = true
            statusMessage = "Create your profile before enabling HealthKit sync."
            return
        }
        if healthKit.consentGranted && healthKit.enabledMetrics.isEmpty {
            isError = true
            statusMessage = "Select at least one HealthKit metric, or turn off consent."
            return
        }
        let metricSummary = healthKit.enabledMetrics.map(\.rawValue).sorted().joined(separator: ",")
        CrashReporting.setCustomValues([
            "healthkit_stage": "settings_save_requested",
            "healthkit_metrics": metricSummary
        ])
        CrashReporting.log("healthkit.settings_save_requested metrics=\(metricSummary)")
        await request {
            let installationId = try await syncStateStore.installationId()
            let consentVersion = healthKit.consentGranted ? HealthKitConsent.version : nil
            let enabled = healthKit.consentGranted
                ? Array(healthKit.enabledMetrics).sorted { $0.rawValue < $1.rawValue }
                : []
            let status = try await client.putHealthKitSettings(
                baseURL: connection.baseURL,
                accessToken: auth.accessToken,
                personId: personId,
                consentVersion: consentVersion,
                enabledGroups: enabled,
                healthTimezone: healthKit.selectedTimezone,
                installationId: installationId,
                replaceActiveInstallation: replaceInstallation
            )
            healthKit.apply(status: status)
            CrashReporting.setCustomValues(["healthkit_stage": "settings_saved"])
            CrashReporting.log("healthkit.settings_saved")
            try await persistLocalConfiguration(from: status)
            if status.consentActive {
                try await healthKitClient.requestAuthorization(for: Set(status.enabledMetrics))
                try await healthKitClient.enableBackgroundDelivery(for: Set(status.enabledMetrics))
                HealthKitBackgroundSyncCoordinator.shared.configureObservers(for: status.enabledMetrics)
            } else if let userId = auth.signedInUserId {
                await syncStateStore.clearAll(userId: userId, personId: personId)
                HealthKitBackgroundSyncCoordinator.shared.stopObservers()
            }
            return status.consentActive ? "HealthKit sync settings saved." : "HealthKit consent withdrawn."
        }
    }

    func syncHealthKitNow() async {
        guard healthKitClient.isAvailable else {
            isError = true
            statusMessage = "HealthKit is not available on this device."
            return
        }
        guard let personId = selfProfile?.id else {
            isError = true
            statusMessage = "Create your profile before syncing HealthKit."
            return
        }
        guard healthKit.linkedProfileId == nil || healthKit.linkedProfileId == personId else {
            isError = true
            statusMessage = "HealthKit sync must target your own profile."
            return
        }

        if healthKit.status == nil {
            await loadHealthKitStatus()
            if isError { return }
        }

        if healthKit.status?.consentActive != true {
            healthKit.consentGranted = true
            if healthKit.enabledMetrics.isEmpty {
                healthKit.enabledMetrics = Set(HealthKitSyncMetric.allCases)
            }
            await saveHealthKitSettings()
            if isError { return }
        }

        healthKit.isSyncing = true
        defer { healthKit.isSyncing = false }

        await request {
            guard let status = healthKit.status else {
                throw HealthAPIError.badStatus(409, "HealthKit settings could not be loaded. Save the settings and try again.")
            }
            let userId = try await syncUserId()

            let installationId = try await syncStateStore.installationId()
            let context = HealthKitSyncEngine.SessionContext(
                baseURL: connection.baseURL,
                accessToken: auth.accessToken,
                userId: userId,
                personId: personId,
                timezone: status.healthTimezone,
                timezoneVersion: status.healthTimezoneVersion,
                installationId: installationId,
                enabledGroups: status.enabledGroups
            )

            try await persistLocalConfiguration(from: status, userId: userId, installationId: installationId)
            try await syncEngine.enableAndRepair(context: context)
            let refreshed = try await client.healthKitSettings(
                baseURL: connection.baseURL,
                accessToken: auth.accessToken,
                personId: personId
            )
            healthKit.apply(status: refreshed)
            try await persistLocalConfiguration(from: refreshed, userId: userId, installationId: installationId)
            readings.bloodPressureReadings = try await client.listBloodPressure(
                baseURL: connection.baseURL,
                accessToken: auth.accessToken,
                personId: personId
            )
            HealthKitBackgroundSyncCoordinator.shared.configureObservers(for: refreshed.enabledMetrics)
            return "HealthKit sync completed. Background delivery is best effort."
        }
    }

    func changeHealthTimezone() async {
        guard healthKit.confirmTimezoneChange else {
            isError = true
            statusMessage = "Confirm the timezone change. This repairs the latest 90 days."
            return
        }
        await saveHealthKitSettings()
        guard !isError else { return }
        await syncHealthKitNow()
        healthKit.confirmTimezoneChange = false
    }

    private func persistLocalConfiguration(
        from status: HealthKitSyncStatus,
        userId: String? = nil,
        installationId: String? = nil
    ) async throws {
        let resolvedUserId = userId
            ?? auth.signedInUserId
            ?? defaults.string(forKey: DefaultsKey.userId)
            ?? ""
        let resolvedInstallation: String
        if let installationId {
            resolvedInstallation = installationId
        } else {
            resolvedInstallation = try await syncStateStore.installationId()
        }
        guard status.consentActive else {
            await syncStateStore.clearConfiguration()
            return
        }
        guard !resolvedUserId.isEmpty else { return }
        await syncStateStore.saveConfiguration(
            HealthKitLocalConfiguration(
                userId: resolvedUserId,
                personId: status.personId,
                healthTimezone: status.healthTimezone,
                healthTimezoneVersion: status.healthTimezoneVersion,
                enabledMetrics: status.enabledGroups,
                consentVersion: status.consentVersion,
                installationId: resolvedInstallation,
                updatedAt: Date()
            )
        )
    }

    private func syncUserId() async throws -> String {
        if let userId = auth.signedInUserId, !userId.isEmpty {
            return userId
        }
        if let userId = defaults.string(forKey: DefaultsKey.userId), !userId.isEmpty {
            auth.signedInUserId = userId
            return userId
        }

        let session = try await client.session(
            baseURL: connection.baseURL,
            accessToken: auth.accessToken
        )
        auth.signedInUserId = session.userId
        defaults.set(session.userId, forKey: DefaultsKey.userId)
        return session.userId
    }
}
