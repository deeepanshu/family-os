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
            persistServerGroupStates(status)
            return "Loaded HealthKit status."
        }
    }

    func refreshHealthKitOutboxDiagnostics() {
        // Outbox removed with the old sync stack.
    }

    // MARK: - Save

    /// Save-button path: wraps the throwing save with user feedback.
    func saveHealthKitSettings(
        replaceInstallation: Bool = false,
        showsFeedback: Bool = true
    ) async {
        healthKit.isSavingSettings = true
        defer { healthKit.isSavingSettings = false }
        do {
            let status = try await performHealthKitSettingsSave(replaceInstallation: replaceInstallation)
            let message = status.consentActive
                ? "HealthKit settings saved."
                : "HealthKit consent withdrawn."
            statusMessage = message
            isError = false
            if showsFeedback {
                reportActionResult(message)
            }
        } catch {
            CrashReporting.healthKitNonFatal(
                .settingsFailed,
                stage: .settingsSaved,
                message: "settings_put_failed",
                underlying: error
            )
            isError = true
            statusMessage = error.localizedDescription
            if showsFeedback {
                reportActionFailure(statusMessage)
            }
        }
    }

    /// Throwing settings save suitable for save-before-run command composition
    /// (plan §6.3): returns the canonical server settings or throws. It never
    /// swallows an error into shared status text.
    ///
    /// On success it also persists the canonical set to the local sync store
    /// and reconciles background observers/delivery — a server-only save is not
    /// sufficient proof that local execution state matches the UI.
    @discardableResult
    func performHealthKitSettingsSave(replaceInstallation: Bool = false) async throws -> HealthKitSyncStatus {
        guard let personId = selfProfile?.id else {
            throw HealthAPIError.badStatus(
                409,
                "Create your profile before enabling HealthKit.",
                code: "healthkit_self_profile_required"
            )
        }
        if healthKit.consentGranted && healthKit.enabledMetrics.isEmpty {
            throw HealthAPIError.badStatus(
                409,
                "Select at least one HealthKit metric, or turn off consent.",
                code: "consent_missing"
            )
        }

        try await refreshSessionForHealthKitCommand()
        let installationId = try HealthKitInstallationId.current(using: keychain)
        let consentVersion = healthKit.consentGranted ? HealthKitConsent.version : nil
        // The installation replacement request uses the saved UI selection —
        // never a broader server group list (plan §6.4).
        let enabled = healthKit.consentGranted
            ? Array(
                healthKit.enabledMetrics
                    .intersection(HealthKitSyncStateViewModel.syncableMetrics)
            ).sorted { $0.rawValue < $1.rawValue }
            : []

        let status: HealthKitSyncStatus
        do {
            // One active install per person. Saving settings on this device claims it —
            // same as before (shared local dev-token / reinstall flows).
            status = try await client.putHealthKitSettings(
                baseURL: connection.baseURL,
                accessToken: auth.accessToken,
                personId: personId,
                consentVersion: consentVersion,
                enabledGroups: enabled,
                healthTimezone: healthKit.selectedTimezone,
                installationId: installationId,
                replaceActiveInstallation: replaceInstallation
            )
        } catch let HealthAPIError.badStatus(code, _, errorCode)
            where code == 409 && errorCode == "installation_inactive" && !replaceInstallation
        {
            CrashReporting.healthKit(
                .settingsSaved,
                extra: ["install_replace_retry": "1"]
            )
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

        // Local configuration must match the canonical response before any run.
        try persistHealthKitConfiguration(status)

        // Reconcile background observers and delivery with the canonical set.
        let enabledSet = Set(status.enabledGroups).intersection(HealthKitSyncMetric.productMetrics)
        await HealthKitBackgroundSync.reconcileDeliveryAndObservers(for: enabledSet)

        // Soft auth must not block Save UI — Health permission sheets can hang.
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
                "enabled_group_count": String(status.enabledGroups.count)
            ]
        )
        return status
    }

    // MARK: - Run commands (save-before-run, plan §6.3)

    /// Primary action before first fill: non-deleting 90-day import.
    func importHealthKitHistory(metric: HealthKitSyncMetric) async {
        await runHealthKitMetricCommand(metric: metric, kind: .initialImport)
    }

    /// Routine incremental sync for one metric.
    func syncHealthKitMetric(metric: HealthKitSyncMetric) async {
        await runHealthKitMetricCommand(metric: metric, kind: .sync)
    }

    /// Manual repair: 90-day re-import with missing-key reconciliation. The
    /// view must show the deletion confirmation before calling this.
    func repairHealthKitMetric(metric: HealthKitSyncMetric) async {
        await runHealthKitMetricCommand(metric: metric, kind: .repairImport)
    }

    /// Sequential Blood pressure -> Sleep -> Workouts over the immutable saved
    /// enabled snapshot; metrics needing Import history are skipped, never
    /// silently imported (plan §4.4).
    func syncAllEnabledHealthMetrics() async {
        guard preflightHealthKitCommand() else { return }

        do {
            let status = try await saveBeforeRun()
            let enabledSnapshot = Set(status.enabledGroups).intersection(HealthKitSyncMetric.productMetrics)
            guard !enabledSnapshot.isEmpty else {
                throw HealthAPIError.badStatus(
                    409,
                    "Enable at least one supported metric before syncing.",
                    code: "consent_missing"
                )
            }

            let engine = try makeHealthKitRunEngine(status: status, enabledSnapshot: enabledSnapshot)
            CrashReporting.healthKit(
                .syncStarted,
                extra: ["mode": "foreground_all", "groups": enabledSnapshot.map(\.rawValue).sorted().joined(separator: ",")]
            )

            // Wait briefly if background work still holds the gate.
            let outcome = try await HealthKitRunGate.shared.withExclusiveRun(waitSeconds: 45) {
                await HealthKitSyncAllRunner.runAll(
                    enabledSnapshot: enabledSnapshot,
                    engine: engine,
                    onMetricStarted: { [weak self] metric in
                        await MainActor.run {
                            self?.healthKit.beginRun(metric: metric, kind: .sync)
                        }
                    },
                    onMetricFinished: { [weak self] metric, error in
                        await MainActor.run {
                            self?.healthKit.recordRunResult(metric: metric, error: error)
                        }
                    }
                )
            }
            healthKit.clearActiveRun()

            await refreshHealthKitStatusAfterRun()
            await reconcileBackgroundAfterRun(enabledSnapshot: enabledSnapshot, succeeded: Set(outcome.synced.map(\.metric)))

            CrashReporting.healthKit(
                .syncCompleted,
                count: outcome.synced.reduce(0) { $0 + $1.fetchedCount },
                extra: ["failures": String(outcome.failures.count), "skipped": String(outcome.skipped.count)]
            )

            let message = Self.syncAllSummaryMessage(outcome: outcome)
            statusMessage = message
            if outcome.failures.isEmpty {
                isError = false
                reportActionResult(message)
            } else {
                isError = true
                reportActionFailure(message)
            }
        } catch {
            healthKit.clearActiveRun()
            await refreshHealthKitStatusAfterRun()
            isError = true
            statusMessage = error.localizedDescription
            reportActionFailure(statusMessage)
        }
    }

    private func runHealthKitMetricCommand(metric: HealthKitSyncMetric, kind: HealthKitRunKind) async {
        guard preflightHealthKitCommand() else { return }

        do {
            // Step 1: save draft settings; a failure aborts before HealthKit
            // authorization and leaves the draft visible (plan §6.3).
            let status = try await saveBeforeRun()

            // Step 2: immutable snapshot of the canonical saved enabled set.
            let enabledSnapshot = Set(status.enabledGroups).intersection(HealthKitSyncMetric.productMetrics)
            guard enabledSnapshot.contains(metric) else {
                throw HealthKitRunError.metricDisabled(metric)
            }

            // Step 3: run through the process-wide gate.
            let engine = try makeHealthKitRunEngine(status: status, enabledSnapshot: enabledSnapshot)
            CrashReporting.healthKit(
                .syncStarted,
                extra: ["mode": "foreground", "run_kind": kind.rawValue, "group": metric.rawValue]
            )
            healthKit.beginRun(metric: metric, kind: kind)
            let result: HealthKitRunResult
            do {
                // Foreground waits for a short-lived background holder so rapid
                // per-metric Import/Sync is not rejected as "already in progress".
                result = try await HealthKitRunGate.shared.withExclusiveRun(waitSeconds: 45) {
                    try await engine.run(HealthKitRunRequest(metric: metric, kind: kind))
                }
            } catch {
                healthKit.endRun(metric: metric, error: error.localizedDescription)
                throw error
            }
            healthKit.endRun(metric: metric)

            await refreshHealthKitStatusAfterRun()
            await reconcileBackgroundAfterRun(enabledSnapshot: enabledSnapshot, succeeded: [result.metric])

            CrashReporting.healthKit(
                .syncCompleted,
                count: result.fetchedCount,
                extra: ["run_kind": kind.rawValue, "deleted": String(result.deletedCount)]
            )
            let message = Self.runSummaryMessage(result: result)
            statusMessage = message
            isError = false
            reportActionResult(message)
        } catch {
            await refreshHealthKitStatusAfterRun()
            isError = true
            statusMessage = error.localizedDescription
            reportActionFailure(statusMessage)
        }
    }

    /// Save step shared by all user-triggered runs: sets shared busy state and
    /// throws on failure (callers abort before HealthKit authorization).
    private func saveBeforeRun() async throws -> HealthKitSyncStatus {
        healthKit.isSavingSettings = true
        defer { healthKit.isSavingSettings = false }
        return try await performHealthKitSettingsSave()
    }

    private func preflightHealthKitCommand() -> Bool {
        guard let personId = selfProfile?.id else {
            isError = true
            statusMessage = "Create your profile before syncing HealthKit."
            CrashReporting.healthKitNonFatal(
                .missingSelfProfile,
                stage: .syncFailed,
                message: "sync_blocked_missing_self_profile"
            )
            reportActionFailure(statusMessage)
            return false
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
            return false
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
            return false
        }
        guard healthKit.consentGranted else {
            isError = true
            statusMessage = "Enable HealthKit consent and at least one supported metric before syncing."
            CrashReporting.healthKitNonFatal(
                .consentMissing,
                stage: .syncFailed,
                message: "sync_blocked_no_consent"
            )
            reportActionFailure(statusMessage)
            return false
        }
        return true
    }

    /// Builds the run engine over the canonical saved settings. The selection
    /// snapshot is immutable for the whole command (plan §6.4).
    private func makeHealthKitRunEngine(
        status: HealthKitSyncStatus,
        enabledSnapshot: Set<HealthKitSyncMetric>
    ) throws -> HealthKitRunEngine {
        let personId = status.personId
        let installationId = status.activeInstallationId ?? ""
        let healthTimezone = status.healthTimezone
        let timezoneVersion = status.healthTimezoneVersion
        let baseURL = connection.baseURL
        let accessToken = auth.accessToken
        let apiClient = client
        let hkClient = healthKitClient
        let needsImportByMetric: [HealthKitSyncMetric: Bool] = Dictionary(
            uniqueKeysWithValues: status.groups.map { ($0.metric, $0.needsImport) }
        )

        let syncStore: HealthKitSyncStore
        do {
            syncStore = try HealthKitSyncStore.shared
        } catch {
            CrashReporting.healthKitNonFatal(
                .storeOpenFailed,
                stage: .storeOpenFailed,
                message: "sqlite_store_open_failed",
                underlying: error
            )
            throw error
        }

        let deps = HealthKitRunDependencies(
            beginRun: { metric, kind in
                try await apiClient.beginHealthKitRun(
                    baseURL: baseURL,
                    accessToken: accessToken,
                    group: metric.rawValue,
                    installationId: installationId,
                    personId: personId,
                    timezoneVersion: timezoneVersion,
                    kind: kind.rawValue
                )
            },
            completeRun: { metric, kind, descriptor, presentNaturalKeys in
                try await apiClient.completeHealthKitRun(
                    baseURL: baseURL,
                    accessToken: accessToken,
                    group: metric.rawValue,
                    installationId: installationId,
                    personId: personId,
                    timezoneVersion: timezoneVersion,
                    kind: kind.rawValue,
                    rangeStartAt: descriptor.rangeStartAt,
                    rangeEndAt: descriptor.rangeEndAt,
                    presentNaturalKeys: presentNaturalKeys
                )
            },
            postBatch: { batch in
                try await apiClient.postHealthKitOpsBatch(
                    baseURL: baseURL,
                    accessToken: accessToken,
                    body: batch
                )
            },
            ensureAuth: { metric in
                try await hkClient.ensureReadAuthorization(for: [metric])
            },
            fetchAndEnqueue: HealthKitRunEngine.makeFetchAndEnqueue(
                syncStore: syncStore,
                healthTimezone: healthTimezone
            ),
            isEnabled: { metric in enabledSnapshot.contains(metric) },
            needsInitialImport: { metric in needsImportByMetric[metric] ?? true },
            onProgress: { [weak self] _, stage in
                await MainActor.run {
                    self?.healthKit.updateActiveRunStage(stage)
                }
            }
        )
        return HealthKitRunEngine(syncStore: syncStore, deps: deps)
    }

    private func refreshHealthKitStatusAfterRun() async {
        if let refreshed = try? await client.healthKitSettings(
            baseURL: connection.baseURL,
            accessToken: auth.accessToken,
            personId: selfProfile?.id
        ) {
            healthKit.apply(status: refreshed)
            persistServerGroupStates(refreshed)
        }
    }

    private func reconcileBackgroundAfterRun(
        enabledSnapshot: Set<HealthKitSyncMetric>,
        succeeded: Set<HealthKitSyncMetric>
    ) async {
        guard !succeeded.isEmpty else { return }
        await HealthKitBackgroundSync.reconcileDeliveryAndObservers(for: enabledSnapshot)
        HealthKitBackgroundSync.scheduleBackgroundSync()
    }

    // MARK: - Local persistence

    /// Persist the canonical settings to the local sync store so background
    /// execution uses the same enabled set, installation, and import gates.
    private func persistHealthKitConfiguration(_ status: HealthKitSyncStatus) throws {
        let syncStore = try HealthKitSyncStore.shared
        try syncStore.saveConfiguration(
            userId: auth.signedInUserId ?? "",
            personId: status.personId,
            installationId: status.activeInstallationId ?? "",
            healthTimezone: status.healthTimezone,
            timezoneVersion: status.healthTimezoneVersion,
            enabledGroups: status.enabledGroups.map(\.rawValue)
        )
        try persistServerGroupStates(status, into: syncStore)
    }

    private func persistServerGroupStates(_ status: HealthKitSyncStatus) {
        guard let store = try? HealthKitSyncStore.shared else { return }
        try? persistServerGroupStates(status, into: store)
    }

    private func persistServerGroupStates(_ status: HealthKitSyncStatus, into store: HealthKitSyncStore) throws {
        try store.applyServerGroupStates(
            status.groups.map { group in
                ServerGroupStateInput(
                    groupKey: group.group.rawValue,
                    serverStatus: group.status.rawValue,
                    needsInitialImport: group.needsImport,
                    coverageStartAt: group.coverageStartAt.flatMap(HealthKitRunEngine.parseISODate)?.timeIntervalSince1970,
                    coverageEndAt: group.coverageEndAt.flatMap(HealthKitRunEngine.parseISODate)?.timeIntervalSince1970,
                    lastSuccessfulAt: group.lastSuccessfulAt.flatMap(HealthKitRunEngine.parseISODate)?.timeIntervalSince1970
                )
            }
        )
    }

    private func refreshSessionForHealthKitCommand() async throws {
        // Match the request(...) wrapper behavior: refresh the Supabase token first.
        try await refreshSessionIfNeeded()
    }

    // MARK: - Feedback text

    static func runSummaryMessage(result: HealthKitRunResult) -> String {
        let name = result.metric.displayName
        switch result.kind {
        case .initialImport:
            return "Imported \(name) history (\(result.fetchedCount) record(s))."
        case .sync:
            return "Synced \(name) (\(result.fetchedCount) record(s))."
        case .repairImport:
            return "Re-imported \(name) history (\(result.fetchedCount) record(s), \(result.deletedCount) removed)."
        }
    }

    static func syncAllSummaryMessage(outcome: HealthKitSyncAllOutcome) -> String {
        var parts: [String] = []
        if !outcome.synced.isEmpty {
            let names = outcome.synced.map { $0.metric.displayName }.joined(separator: " and ")
            parts.append("Synced \(names).")
        }
        for failure in outcome.failures {
            parts.append("\(failure.metric.displayName) failed (\(failure.error.errorCode ?? "error")).")
        }
        for metric in outcome.skipped {
            parts.append("\(metric.displayName) needs Import history first.")
        }
        if parts.isEmpty {
            return "Nothing to sync."
        }
        return parts.joined(separator: " ")
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
