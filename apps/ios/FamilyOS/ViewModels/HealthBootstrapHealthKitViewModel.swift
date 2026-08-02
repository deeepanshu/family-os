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
            let enabled = healthKit.consentGranted
                ? Array(healthKit.enabledMetrics).sorted { $0.rawValue < $1.rawValue }
                : []
            do {
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
                // Soft auth: never let HK NSException abort after a successful settings PUT.
                if status.consentActive {
                    await healthKitClient.requestAuthorizationSoft(for: Set(status.enabledMetrics))
                }
                CrashReporting.healthKit(
                    .settingsSaved,
                    extra: [
                        "consent_active": status.consentActive ? "1" : "0",
                        "enabled_group_count": String(status.enabledGroups.count),
                        "replace_install": replaceInstallation ? "1" : "0"
                    ]
                )
                return status.consentActive
                    ? "HealthKit settings saved."
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
                message: "sync_blocked_missing_self_profile",
                group: "vitals",
                metric: "blood_pressure"
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
                message: "sync_blocked_wrong_profile",
                group: "vitals"
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
                message: "sync_blocked_healthkit_unavailable",
                group: "vitals"
            )
            reportActionFailure(statusMessage)
            return
        }
        guard healthKit.consentGranted, healthKit.enabledMetrics.contains(.vitals) else {
            isError = true
            statusMessage = "Enable vitals consent before blood pressure sync."
            CrashReporting.healthKitNonFatal(
                .consentMissing,
                stage: .syncFailed,
                message: "sync_blocked_vitals_consent",
                group: "vitals",
                metric: "blood_pressure"
            )
            reportActionFailure(statusMessage)
            return
        }

        healthKit.isSyncing = true
        defer { healthKit.isSyncing = false }
        CrashReporting.healthKit(.syncStarted, group: "vitals", metric: "blood_pressure")

        await request {
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
                        group: "vitals",
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
                    group: "vitals",
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
                        group: "vitals",
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
                CrashReporting.healthKit(.importStarted, group: "vitals", metric: "blood_pressure")

                // Hard auth on sync: must succeed before we mark the group ready.
                // (Settings save still uses soft auth so a PUT is never rolled back by HK.)
                do {
                    try await healthKitClient.requestAuthorization(for: [.vitals])
                    CrashReporting.healthKit(.authRequested, group: "vitals", metric: "blood_pressure")
                } catch {
                    CrashReporting.healthKitNonFatal(
                        .fetchFailed,
                        stage: .authRequested,
                        message: "healthkit_auth_sync_failed",
                        group: "vitals",
                        metric: "blood_pressure",
                        underlying: error
                    )
                    throw HealthAPIError.badStatus(
                        403,
                        "Health access for blood pressure was not granted. Open Settings → Health → Data Access and enable Blood Pressure for this app, then try Sync again.",
                        code: "healthkit_auth_failed"
                    )
                }

                let samples: [HealthKitBloodPressureSync.BPSample]
                do {
                    samples = try await HealthKitBloodPressureSync.fetchBloodPressure()
                } catch {
                    CrashReporting.healthKitNonFatal(
                        .fetchFailed,
                        stage: .samplesFetched,
                        message: "bp_fetch_failed",
                        group: "vitals",
                        metric: "blood_pressure",
                        underlying: error
                    )
                    throw error
                }
                CrashReporting.healthKit(
                    .samplesFetched,
                    group: "vitals",
                    metric: "blood_pressure",
                    count: samples.count
                )
                try HealthKitBloodPressureSync.enqueueSamples(samples, into: syncStore)
                CrashReporting.healthKit(
                    .samplesEnqueued,
                    group: "vitals",
                    metric: "blood_pressure",
                    count: samples.count
                )

                let worker = HealthKitSyncWorker(store: syncStore) { batch in
                    try await self.client.postHealthKitOpsBatch(
                        baseURL: self.connection.baseURL,
                        accessToken: self.auth.accessToken,
                        body: batch
                    )
                }
                CrashReporting.healthKit(.drainStarted, group: "vitals", count: try syncStore.pendingCount())
                let applied: Int
                do {
                    applied = try await worker.drain()
                } catch {
                    CrashReporting.healthKitNonFatal(
                        .batchFailed,
                        stage: .drainFinished,
                        message: "ops_batch_drain_failed",
                        group: "vitals",
                        metric: "blood_pressure",
                        underlying: error
                    )
                    throw error
                }
                let remaining = try syncStore.pendingCount(group: "vitals")
                CrashReporting.healthKit(
                    .drainFinished,
                    group: "vitals",
                    count: applied,
                    extra: ["pending_remaining": String(remaining)]
                )
                guard remaining == 0 else {
                    CrashReporting.healthKitNonFatal(
                        .queueIncomplete,
                        stage: .drainFinished,
                        message: "pending_ops_remain_after_drain",
                        group: "vitals",
                        metric: "blood_pressure"
                    )
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
                CrashReporting.healthKit(.groupReady, group: "vitals", metric: "blood_pressure")

                let refreshed = try await client.healthKitSettings(
                    baseURL: connection.baseURL,
                    accessToken: auth.accessToken,
                    personId: personId
                )
                healthKit.apply(status: refreshed)
                CrashReporting.healthKit(
                    .syncCompleted,
                    group: "vitals",
                    metric: "blood_pressure",
                    count: samples.count,
                    extra: ["applied": String(applied)]
                )
                if samples.isEmpty {
                    return "Vitals marked ready, but 0 blood pressure readings were found in Health for the last 90 days. If you expected data, check Settings → Health → Data Access for Blood Pressure (systolic/diastolic)."
                }
                return "Synced \(samples.count) blood pressure reading(s); uploaded \(applied) op(s)."
            } catch {
                CrashReporting.healthKitNonFatal(
                    .syncFailed,
                    stage: .syncFailed,
                    message: "sync_healthkit_now_failed",
                    group: "vitals",
                    metric: "blood_pressure",
                    underlying: error
                )
                throw error
            }
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
