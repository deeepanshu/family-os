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
                ? "HealthKit settings saved. Device sync will return after the rewrite."
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

        isError = true
        statusMessage = "HealthKit device sync was removed for rewrite. Settings still save; upload pipeline is coming back simple and correct."
        reportActionFailure(statusMessage)
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
