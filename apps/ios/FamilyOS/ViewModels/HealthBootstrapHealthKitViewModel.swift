import Foundation
import HealthKit

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
            CrashReporting.healthKitNonFatal(
                .missingSelfProfile,
                stage: .settingsSaved,
                message: "settings_blocked_missing_self_profile"
            )
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
            // Only persist groups the app can surface in settings (syncable UI set).
            let enabled = healthKit.consentGranted
                ? Array(
                    healthKit.enabledMetrics
                        .intersection(HealthKitSyncStateViewModel.syncableMetrics)
                ).sorted { $0.rawValue < $1.rawValue }
                : []
            do {
                // One active install per person. Saving settings on this device claims it —
                // same as sync's auto-replace when another phone/sim holds the active slot
                // (common with shared local dev-token).
                var claimedInstall = replaceInstallation
                let status: HealthKitSyncStatus
                do {
                    status = try await client.putHealthKitSettings(
                        baseURL: connection.baseURL,
                        accessToken: auth.accessToken,
                        personId: personId,
                        consentVersion: consentVersion,
                        enabledGroups: enabled,
                        healthTimezone: healthKit.selectedTimezone,
                        installationId: installationId,
                        replaceActiveInstallation: claimedInstall
                    )
                } catch let HealthAPIError.badStatus(code, _, errorCode)
                    where code == 409 && errorCode == "installation_inactive" && !claimedInstall
                {
                    CrashReporting.healthKit(
                        .settingsSaved,
                        extra: ["install_replace_retry": "1"]
                    )
                    claimedInstall = true
                    status = try await client.putHealthKitSettings(
                        baseURL: connection.baseURL,
                        accessToken: auth.accessToken,
                        personId: personId,
                        consentVersion: consentVersion,
                        enabledGroups: enabled,
                        healthTimezone: healthKit.selectedTimezone,
                        installationId: installationId,
                        replaceActiveInstallation: true
                    )
                }
                healthKit.apply(status: status)
                // Soft auth must not block Save UI — Health permission sheets can hang forever
                // (or wait on user), which left the button stuck on "Saving...".
                // Fire-and-forget after settings are already persisted.
                if status.consentActive {
                    let implemented = Set(status.enabledMetrics)
                        .intersection(HealthKitSyncStateViewModel.implementedSyncMetrics)
                    if !implemented.isEmpty {
                        let client = healthKitClient
                        Task {
                            await client.requestAuthorizationSoft(for: implemented)
                        }
                    }
                }
                CrashReporting.healthKit(
                    .settingsSaved,
                    extra: [
                        "consent_active": status.consentActive ? "1" : "0",
                        "enabled_group_count": String(status.enabledGroups.count),
                        "replace_install": claimedInstall ? "1" : "0"
                    ]
                )
                return status.consentActive
                    ? (claimedInstall && !replaceInstallation
                        ? "HealthKit settings saved (this device is now the active sync source)."
                        : "HealthKit settings saved.")
                    : "HealthKit consent withdrawn."
            } catch {
                CrashReporting.healthKitNonFatal(
                    .settingsFailed,
                    stage: .settingsSaved,
                    message: "settings_put_failed",
                    underlying: error
                )
                throw error
            }
        }
    }

    func syncHealthKitNow() async {
        guard let personId = selfProfile?.id else {
            isError = true
            statusMessage = "Create your profile before syncing HealthKit."
            CrashReporting.healthKitNonFatal(
                .missingSelfProfile,
                stage: .syncFailed,
                message: "sync_blocked_missing_self_profile"
            )
            reportActionFailure(statusMessage)
            return
        }
        guard healthKit.linkedProfileId == nil || healthKit.linkedProfileId == personId else {
            isError = true
            statusMessage = "HealthKit sync must target your own profile."
            CrashReporting.healthKitNonFatal(
                .wrongProfileTarget,
                stage: .syncFailed,
                message: "sync_blocked_wrong_profile"
            )
            reportActionFailure(statusMessage)
            return
        }
        guard healthKitClient.isAvailable || healthKit.isAvailable else {
            isError = true
            statusMessage = "HealthKit is not available on this device."
            CrashReporting.healthKitNonFatal(
                .healthKitUnavailable,
                stage: .syncFailed,
                message: "sync_blocked_healthkit_unavailable"
            )
            reportActionFailure(statusMessage)
            return
        }

        let groupsToSync = HealthKitSyncCoordinator.orderedGroups(
            from: healthKit.enabledMetrics.intersection(HealthKitSyncStateViewModel.implementedSyncMetrics)
        )
        guard healthKit.consentGranted, !groupsToSync.isEmpty else {
            isError = true
            statusMessage = "Enable HealthKit consent and at least one supported metric before syncing."
            CrashReporting.healthKitNonFatal(
                .consentMissing,
                stage: .syncFailed,
                message: "sync_blocked_no_implemented_metrics"
            )
            reportActionFailure(statusMessage)
            return
        }

        healthKit.isSyncing = true
        defer { healthKit.isSyncing = false }
        CrashReporting.healthKit(
            .syncStarted,
            extra: ["groups": groupsToSync.map(\.rawValue).joined(separator: ",")]
        )

        // Progress toasts are driven by the coordinator; final success/partial toast is set here.
        // Failure alert is applied after `request` so we can still refresh metric rows first.
        await request(showsFeedback: false) {
            do {
                let installationId = try HealthKitInstallationId.current(using: keychain)
                var status = try await client.healthKitSettings(
                    baseURL: connection.baseURL,
                    accessToken: auth.accessToken,
                    personId: personId
                )
                // Personal single-writer: if another install is active (reinstall / new phone),
                // claim this device so ops:batch and start-import are not fenced out.
                if let active = status.activeInstallationId, active != installationId {
                    CrashReporting.healthKit(
                        .settingsLoaded,
                        extra: ["install_replace": "1"]
                    )
                    let enabled = status.enabledGroups.isEmpty
                        ? Array(healthKit.enabledMetrics)
                        : status.enabledGroups
                    status = try await client.putHealthKitSettings(
                        baseURL: connection.baseURL,
                        accessToken: auth.accessToken,
                        personId: personId,
                        consentVersion: status.consentVersion ?? HealthKitConsent.version,
                        enabledGroups: enabled,
                        healthTimezone: status.healthTimezone,
                        installationId: installationId,
                        replaceActiveInstallation: true
                    )
                }
                healthKit.apply(status: status)
                CrashReporting.healthKit(
                    .settingsLoaded,
                    extra: ["tz_version": String(status.healthTimezoneVersion)]
                )

                let syncStore: HealthKitSyncStore
                do {
                    syncStore = try HealthKitSyncStore()
                } catch {
                    CrashReporting.healthKitNonFatal(
                        .storeOpenFailed,
                        stage: .storeOpenFailed,
                        message: "sqlite_store_open_failed",
                        underlying: error
                    )
                    throw error
                }
                try syncStore.saveConfiguration(
                    userId: auth.signedInUserId ?? "",
                    personId: personId,
                    installationId: installationId,
                    healthTimezone: status.healthTimezone,
                    timezoneVersion: status.healthTimezoneVersion,
                    enabledGroups: status.enabledGroups.map(\.rawValue)
                )

                let baseURL = connection.baseURL
                let accessToken = auth.accessToken
                let apiClient = client
                let hkClient = healthKitClient
                let healthTimezone = status.healthTimezone
                let timezoneVersion = status.healthTimezoneVersion

                let deps = HealthKitSyncCoordinator.Dependencies(
                    startImport: { group in
                        _ = try await apiClient.startHealthKitImport(
                            baseURL: baseURL,
                            accessToken: accessToken,
                            group: group,
                            installationId: installationId,
                            personId: personId,
                            timezoneVersion: timezoneVersion
                        )
                    },
                    markReady: { group in
                        _ = try await apiClient.markHealthKitGroupReady(
                            baseURL: baseURL,
                            accessToken: accessToken,
                            group: group,
                            installationId: installationId,
                            personId: personId,
                            timezoneVersion: timezoneVersion
                        )
                    },
                    postBatch: { batch in
                        try await apiClient.postHealthKitOpsBatch(
                            baseURL: baseURL,
                            accessToken: accessToken,
                            body: batch
                        )
                    },
                    ensureAuth: { metrics in
                        try await hkClient.ensureReadAuthorization(for: metrics)
                    },
                    healthTimezone: healthTimezone,
                    onProgress: { [weak self] stage in
                        await MainActor.run {
                            guard let self else { return }
                            self.statusMessage = stage.toastMessage
                            self.reportActionResult(stage.toastMessage)
                        }
                    }
                )

                let outcome: HealthKitSyncCoordinator.SyncOutcome
                do {
                    outcome = try await HealthKitSyncCoordinator.run(
                        groups: groupsToSync,
                        syncStore: syncStore,
                        deps: deps
                    )
                } catch {
                    // Refresh metric rows so UI matches server after a total failure.
                    if let refreshed = try? await client.healthKitSettings(
                        baseURL: connection.baseURL,
                        accessToken: auth.accessToken,
                        personId: personId
                    ) {
                        healthKit.apply(status: refreshed)
                    }
                    throw error
                }

                let refreshed = try await client.healthKitSettings(
                    baseURL: connection.baseURL,
                    accessToken: auth.accessToken,
                    personId: personId
                )
                healthKit.apply(status: refreshed)

                // Register BG for groups that actually succeeded this run.
                let bgMetrics = Set(outcome.succeededGroups)
                if !bgMetrics.isEmpty {
                    await HealthKitBackgroundSync.enableDeliveryAndObservers(for: bgMetrics)
                    HealthKitBackgroundSync.scheduleBackgroundSync()
                }

                CrashReporting.healthKit(
                    .syncCompleted,
                    count: outcome.totalSamples,
                    extra: [
                        "applied": String(outcome.totalApplied),
                        "failures": String(outcome.failures.count)
                    ]
                )

                let successParts = outcome.groups.map { summary in
                    "\(summary.group.displayName): \(summary.sampleCount) sample(s), \(summary.applied) op(s)"
                }
                if outcome.failures.isEmpty {
                    let message = "Synced \(successParts.joined(separator: "; "))."
                    reportActionResult(message)
                    return message
                }
                let failParts = outcome.failures.map { failure in
                    "\(failure.group.displayName) failed (\(failure.error.errorCode ?? "error"))"
                }
                let message: String
                if successParts.isEmpty {
                    message = failParts.joined(separator: "; ") + "."
                } else {
                    message = "Synced \(successParts.joined(separator: "; ")). \(failParts.joined(separator: "; "))."
                }
                // Partial failure: alert so the user notices failed groups + UI status is Error.
                reportActionFailure(message)
                return message
            } catch {
                CrashReporting.healthKitNonFatal(
                    .syncFailed,
                    stage: .syncFailed,
                    message: "sync_healthkit_now_failed",
                    underlying: error
                )
                throw error
            }
        }
        if isError {
            reportActionFailure(statusMessage)
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
