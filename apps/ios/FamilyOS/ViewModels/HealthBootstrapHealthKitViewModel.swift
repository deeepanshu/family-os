import Foundation

extension HealthBootstrapViewModel {
    func loadHealthKitStatus() async {
        healthKit.isAvailable = healthKitClient.isAvailable
        await request {
            let status = try await client.healthKitSettings(
                baseURL: connection.baseURL,
                accessToken: auth.accessToken,
                personId: selfProfile?.id
            )
            healthKit.apply(status: status)
            return "Loaded HealthKit status."
        }
    }

    func refreshHealthKitOutboxDiagnostics() {
        // Outbox removed with the old sync stack.
    }

    func saveHealthKitSettings(
        replaceInstallation: Bool = false,
        showsFeedback: Bool = true
    ) async {
        guard let personId = selfProfile?.id else {
            isError = true
            statusMessage = "Create your profile before enabling HealthKit."
            if showsFeedback {
                reportActionFailure(statusMessage)
            }
            return
        }
        if healthKit.consentGranted && healthKit.enabledMetrics.isEmpty {
            isError = true
            statusMessage = "Select at least one HealthKit metric, or turn off consent."
            if showsFeedback {
                reportActionFailure(statusMessage)
            }
            return
        }
        await request(showsFeedback: showsFeedback) {
            let installationId = try HealthKitInstallationId.current(using: keychain)
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
            if status.consentActive {
                try await healthKitClient.requestAuthorization(for: Set(status.enabledMetrics))
            }
            return status.consentActive
                ? "HealthKit settings saved."
                : "HealthKit consent withdrawn."
        }
    }

    func syncHealthKitNow() async {
        guard let personId = selfProfile?.id else {
            isError = true
            statusMessage = "Create your profile before syncing HealthKit."
            reportActionFailure(statusMessage)
            return
        }
        guard healthKit.linkedProfileId == nil || healthKit.linkedProfileId == personId else {
            isError = true
            statusMessage = "HealthKit sync must target your own profile."
            reportActionFailure(statusMessage)
            return
        }
        guard healthKitClient.isAvailable || healthKit.isAvailable else {
            isError = true
            statusMessage = "HealthKit is not available on this device."
            reportActionFailure(statusMessage)
            return
        }
        guard healthKit.consentGranted, healthKit.enabledMetrics.contains(.vitals) else {
            isError = true
            statusMessage = "Enable vitals consent before blood pressure sync."
            reportActionFailure(statusMessage)
            return
        }

        healthKit.isSyncing = true
        defer { healthKit.isSyncing = false }

        await request {
            let installationId = try HealthKitInstallationId.current(using: keychain)
            let status = try await client.healthKitSettings(
                baseURL: connection.baseURL,
                accessToken: auth.accessToken,
                personId: personId
            )
            healthKit.apply(status: status)

            let syncStore = try HealthKitSyncStore()
            try syncStore.saveConfiguration(
                userId: auth.signedInUserId ?? "",
                personId: personId,
                installationId: installationId,
                healthTimezone: status.healthTimezone,
                timezoneVersion: status.healthTimezoneVersion,
                enabledGroups: status.enabledGroups.map(\.rawValue)
            )

            // Milestone 1: blood pressure only (vitals group).
            _ = try await client.startHealthKitImport(
                baseURL: connection.baseURL,
                accessToken: auth.accessToken,
                group: "vitals",
                installationId: installationId,
                personId: personId,
                timezoneVersion: status.healthTimezoneVersion
            )
            try syncStore.setGroupStatus("vitals", status: "syncing")

            try await healthKitClient.requestAuthorization(for: [.vitals])
            let samples = try await HealthKitBloodPressureSync.fetchBloodPressure()
            try HealthKitBloodPressureSync.enqueueSamples(samples, into: syncStore)

            let worker = HealthKitSyncWorker(store: syncStore) { batch in
                try await self.client.postHealthKitOpsBatch(
                    baseURL: self.connection.baseURL,
                    accessToken: self.auth.accessToken,
                    body: batch
                )
            }
            let applied = try await worker.drain()
            let remaining = try syncStore.pendingCount(group: "vitals")
            guard remaining == 0 else {
                throw HealthAPIError.badStatus(
                    409,
                    "Blood pressure queue still has \(remaining) pending ops after drain.",
                    code: "sync_incomplete"
                )
            }

            _ = try await client.markHealthKitGroupReady(
                baseURL: connection.baseURL,
                accessToken: auth.accessToken,
                group: "vitals",
                installationId: installationId,
                personId: personId,
                timezoneVersion: status.healthTimezoneVersion
            )
            try syncStore.setGroupStatus("vitals", status: "ready")

            let refreshed = try await client.healthKitSettings(
                baseURL: connection.baseURL,
                accessToken: auth.accessToken,
                personId: personId
            )
            healthKit.apply(status: refreshed)
            return "Synced \(samples.count) blood pressure reading(s); uploaded \(applied) op(s)."
        }
    }

    func changeHealthTimezone() async {
        guard healthKit.confirmTimezoneChange else {
            isError = true
            statusMessage = "Confirm the timezone change before saving."
            reportActionFailure(statusMessage)
            return
        }
        await saveHealthKitSettings(showsFeedback: true)
        healthKit.confirmTimezoneChange = false
    }
}
