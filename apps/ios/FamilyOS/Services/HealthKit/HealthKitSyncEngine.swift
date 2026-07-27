import Foundation
import HealthKit

enum HealthKitSyncEngineError: LocalizedError {
    case missingSession
    case missingConfiguration
    case backfillRequired(String)
    case backfillEventsPending

    var errorDescription: String? {
        switch self {
        case .missingSession:
            return "Sign in required for HealthKit sync."
        case .missingConfiguration:
            return "HealthKit sync is not configured."
        case .backfillRequired:
            return "A foreground HealthKit backfill is required."
        case .backfillEventsPending:
            return "HealthKit backfill events are waiting to upload."
        }
    }
}

/// Testable non-UI engine: queries HealthKit, updates local ledger, uploads, advances anchors after ack.
actor HealthKitSyncEngine {
    private let healthKit: HealthKitClient
    private let api: HealthAPIClient
    private let stateStore: HealthKitSyncStateStore
    private let outbox: HealthKitOutboxStore
    private let maxOperations = 500
    private let anchoredPageLimit = 1_000

    init(
        healthKit: HealthKitClient = HealthKitClient(),
        api: HealthAPIClient = HealthAPIClient(),
        stateStore: HealthKitSyncStateStore = HealthKitSyncStateStore(),
        outbox: HealthKitOutboxStore = .shared
    ) {
        self.healthKit = healthKit
        self.api = api
        self.stateStore = stateStore
        self.outbox = outbox
    }

    struct SessionContext {
        var baseURL: String
        var accessToken: String
        var userId: String
        var personId: String
        var timezone: String
        var timezoneVersion: Int
        var installationId: String
        var enabledGroups: [HealthKitSyncMetric]
    }

    func enableAndRepair(context: SessionContext) async throws {
        let metricSummary = context.enabledGroups.map(\.rawValue).sorted().joined(separator: ",")
        CrashReporting.setCustomValues([
            "healthkit_stage": "sync_started",
            "healthkit_metrics": metricSummary
        ])
        CrashReporting.log("healthkit.sync_started metrics=\(metricSummary)")
        try outbox.saveConfiguration(
            userId: context.userId,
            personId: context.personId,
            installationId: context.installationId,
            healthTimezone: context.timezone,
            timezoneVersion: context.timezoneVersion,
            enabledGroups: context.enabledGroups.map(\.rawValue)
        )
        try await healthKit.requestAuthorization(for: Set(context.enabledGroups))
        try await healthKit.enableBackgroundDelivery(for: Set(context.enabledGroups))
        for metric in context.enabledGroups {
            try await processMetric(metric, context: context)
        }
        await HealthKitSyncWorker.shared.nudge(baseURL: context.baseURL) { context.accessToken }
        CrashReporting.setCustomValues(["healthkit_stage": "sync_completed"])
        CrashReporting.log("healthkit.sync_completed")
    }

    func processPendingWork(context: SessionContext) async throws {
        try outbox.saveConfiguration(
            userId: context.userId,
            personId: context.personId,
            installationId: context.installationId,
            healthTimezone: context.timezone,
            timezoneVersion: context.timezoneVersion,
            enabledGroups: context.enabledGroups.map(\.rawValue)
        )
        for metric in context.enabledGroups {
            try await processMetric(metric, context: context)
        }
        try await materializeDirtyBuckets(context: context)
        await HealthKitSyncWorker.shared.nudge(baseURL: context.baseURL) { context.accessToken }
    }

    func processMetric(_ metric: HealthKitSyncMetric, context: SessionContext) async throws {
        guard context.enabledGroups.contains(metric) else { return }
        try outbox.saveConfiguration(
            userId: context.userId,
            personId: context.personId,
            installationId: context.installationId,
            healthTimezone: context.timezone,
            timezoneVersion: context.timezoneVersion,
            enabledGroups: context.enabledGroups.map(\.rawValue)
        )
        let groupStatus = try outbox.groupStatus(groupKey: metric.rawValue)
        let hasCursor = try outbox.loadCursor(key: cursorKey(for: metric, context: context)) != nil
        let openSession = try outbox.openBackfillSession(groupKey: metric.rawValue)
        // Prefer SQLite group_state + cursors over UserDefaults repairId/anchors.
        // Transient backfill failures leave status "backfilling" with an open session —
        // resume that session rather than creating a new 90-day scan.
        if groupStatus == "backfilling", openSession != nil {
            try await resumeOpenBackfill(metric: metric, context: context)
        } else if groupStatus == "error" || groupStatus == nil || groupStatus == "never_synced" || !hasCursor {
            try await runBackfill(metric: metric, context: context)
        } else {
            try await processAnchoredChanges(metric: metric, context: context)
            try await materializeDirtyBuckets(context: context)
        }
    }

    /// Incremental path for each aggregate-backed HealthKit type. Group repair
    /// establishes these anchors; an unknown deletion deliberately forces a
    /// repair instead of silently retaining stale daily data.
    func processDataMetric(_ dataMetric: HealthKitDataMetric, context: SessionContext) async throws {
        guard context.enabledGroups.contains(dataMetric.group), isIncrementalDataMetric(dataMetric) else { return }
        guard let type = dataMetric.sampleType else { return }

        // Never start a second backfill while the consent group already has an open session.
        let groupStatus = try outbox.groupStatus(groupKey: dataMetric.group.rawValue)
        let openSession = try outbox.openBackfillSession(groupKey: dataMetric.group.rawValue)
        if groupStatus == "backfilling" || openSession != nil {
            try await resumeOpenBackfill(metric: dataMetric.group, context: context)
            return
        }

        let cursor = try outbox.loadCursor(key: dataMetricCursorKey(for: dataMetric, context: context))
        let anchor: HKQueryAnchor?
        if let cursor {
            anchor = try? NSKeyedUnarchiver.unarchivedObject(ofClass: HKQueryAnchor.self, from: cursor)
        } else if let legacy = await stateStore.loadDataMetricAnchor(userId: context.userId, personId: context.personId, metric: dataMetric) {
            anchor = legacy
        } else {
            try await runBackfill(metric: dataMetric.group, context: context)
            return
        }

        var currentAnchor: HKQueryAnchor? = anchor
        var guardCount = 0
        while guardCount < 10_000 {
            guardCount += 1
            let page = try await healthKit.anchoredQuery(type: type, anchor: currentAnchor, limit: anchoredPageLimit)
            let empty = page.added.isEmpty && page.deletedObjectUUIDs.isEmpty
            if !empty {
                try await applyDataMetricPage(dataMetric, context: context, page: page)
            }
            try await saveAnchorCursor(page.newAnchor, key: dataMetricCursorKey(for: dataMetric, context: context), context: context, dataMetric: dataMetric)
            currentAnchor = page.newAnchor
            if empty || page.added.count + page.deletedObjectUUIDs.count < anchoredPageLimit { break }
        }
    }

    func runBackfill(metric: HealthKitSyncMetric, context: SessionContext) async throws {
        // Clear any stale local open session bookkeeping before starting a new one.
        try outbox.clearOpenBackfillSession(groupKey: metric.rawValue)
        try outbox.setGroupStatus(groupKey: metric.rawValue, status: "backfilling")

        let session: HealthKitBackfillSession
        do {
            session = try await api.createHealthKitBackfillSession(
                baseURL: context.baseURL,
                accessToken: context.accessToken,
                installationId: context.installationId,
                personId: context.personId,
                metric: metric,
                timezoneVersion: context.timezoneVersion
            )
        } catch {
            // Session create failed: leave group as backfilling if we never got a session id,
            // but mark error only for permanent fencing — network stays retryable as never_synced.
            if let apiError = error as? HealthAPIError, isTransientAPIError(apiError) {
                try outbox.setGroupStatus(groupKey: metric.rawValue, status: "never_synced", lastErrorCode: "session_create_retry")
            } else {
                try outbox.setGroupStatus(groupKey: metric.rawValue, status: "error", lastErrorCode: "session_create_failed")
            }
            throw error
        }
        guard let rangeStart = parseInstant(session.rangeStart),
              let rangeEnd = parseInstant(session.rangeEnd) else {
            throw HealthKitSyncEngineError.missingConfiguration
        }

        // Dual-write lightweight UI state; SQLite group_state is authoritative for control flow.
        var local = await stateStore.loadMetricState(userId: context.userId, personId: context.personId, metric: metric)
        local.repairId = nil
        local.pendingSync = true
        local.redactedStatus = "backfilling"
        local.lastErrorCode = nil
        await stateStore.saveMetricState(userId: context.userId, personId: context.personId, metric: metric, state: local)

        try outbox.saveBackfillSession(
            sessionId: session.sessionId,
            groupKey: metric.rawValue,
            rangeStart: rangeStart,
            rangeEnd: rangeEnd,
            status: "open"
        )

        let operations = try await buildRepairOperations(
            metric: metric,
            rangeStart: rangeStart,
            rangeEnd: rangeEnd,
            rangeStartDay: session.rangeStartDay,
            rangeEndDay: session.rangeEndDay,
            context: context
        )
        var eventsByScope: [String: [String]] = [:]
        for op in operations {
            let eventId = try enqueueOperation(op, sessionId: session.sessionId, context: context)
            eventsByScope[scopeKey(for: op), default: []].append(eventId)
        }
        for scope in session.requiredScopeKeys {
            let ids = eventsByScope[scope] ?? []
            let hash = HealthKitScopeManifest.hash(sessionId: session.sessionId, scopeKey: scope, eventIds: ids)
            try outbox.saveScopeManifest(
                sessionId: session.sessionId,
                scopeKey: scope,
                eventCount: ids.count,
                manifestHash: hash,
                eventIds: ids
            )
        }

        try await finishBackfillSession(
            metric: metric,
            session: session,
            eventsByScope: eventsByScope,
            rangeStart: rangeStart,
            rangeEnd: rangeEnd,
            context: context
        )
    }

    /// Resume an open local/server backfill after a transient failure without re-scanning 90 days.
    private func resumeOpenBackfill(metric: HealthKitSyncMetric, context: SessionContext) async throws {
        guard let open = try outbox.openBackfillSession(groupKey: metric.rawValue) else {
            try await runBackfill(metric: metric, context: context)
            return
        }

        // Prefer durable event ID lists stored with scope manifests (survives outbox drain).
        let storedManifests = try outbox.allScopeManifests(sessionId: open.sessionId)
        var eventsByScope: [String: [String]] = [:]
        for entry in storedManifests {
            eventsByScope[entry.scopeKey] = entry.eventIds
        }

        // Fetch session details from server for complete() identity.
        let session: HealthKitBackfillSession
        do {
            session = try await api.getHealthKitBackfillSession(
                baseURL: context.baseURL,
                accessToken: context.accessToken,
                sessionId: open.sessionId
            )
        } catch {
            if let apiError = error as? HealthAPIError, isTransientAPIError(apiError) {
                try outbox.setGroupStatus(groupKey: metric.rawValue, status: "backfilling", lastErrorCode: apiError.errorCode ?? "transient")
                throw error
            }
            // Session gone permanently → full re-scan.
            try await runBackfill(metric: metric, context: context)
            return
        }
        guard let rangeStart = parseInstant(session.rangeStart),
              let rangeEnd = parseInstant(session.rangeEnd) else {
            try await runBackfill(metric: metric, context: context)
            return
        }

        for scope in session.requiredScopeKeys {
            if eventsByScope[scope] == nil {
                eventsByScope[scope] = try outbox.eventIdsForSessionScope(sessionId: open.sessionId, scopeKey: scope)
            }
        }

        try await finishBackfillSession(
            metric: metric,
            session: session,
            eventsByScope: eventsByScope,
            rangeStart: rangeStart,
            rangeEnd: rangeEnd,
            context: context
        )
    }

    private func finishBackfillSession(
        metric: HealthKitSyncMetric,
        session: HealthKitBackfillSession,
        eventsByScope: [String: [String]],
        rangeStart: Date,
        rangeEnd: Date,
        context: SessionContext
    ) async throws {
        // Drain session events before manifests.
        await HealthKitSyncWorker.shared.nudge(baseURL: context.baseURL) { context.accessToken }
        try requireDrainedSessionEvents(session.sessionId)

        do {
            try await uploadManifestsAndComplete(
                session: session,
                eventsByScope: eventsByScope,
                context: context
            )
        } catch let error as HealthAPIError {
            let code = error.errorCode
            if code == "session_incomplete" {
                // Drain pending session events, then re-upload manifests (duplicates allowed) and complete.
                await HealthKitSyncWorker.shared.nudge(baseURL: context.baseURL) { context.accessToken }
                try await uploadManifestsAndComplete(
                    session: session,
                    eventsByScope: eventsByScope,
                    context: context
                )
            } else if code == "manifest_incomplete" || code == "session_expired" || code == "event_conflict" {
                _ = try? await api.abortHealthKitBackfillSession(
                    baseURL: context.baseURL,
                    accessToken: context.accessToken,
                    sessionId: session.sessionId,
                    installationId: context.installationId,
                    personId: context.personId,
                    timezoneVersion: context.timezoneVersion,
                    reason: code
                )
                try outbox.updateBackfillSessionStatus(sessionId: session.sessionId, status: "aborted")
                try outbox.retireSessionEvents(sessionId: session.sessionId, keepEventId: nil, errorCode: code ?? "session_aborted")
                try outbox.setGroupStatus(groupKey: metric.rawValue, status: "error", lastErrorCode: code)
                throw error
            } else if isTransientAPIError(error) {
                // Keep open session / backfilling status for retry with backoff.
                try outbox.setGroupStatus(groupKey: metric.rawValue, status: "backfilling", lastErrorCode: code ?? "transient")
                throw error
            } else {
                try outbox.setGroupStatus(groupKey: metric.rawValue, status: "error", lastErrorCode: code ?? "backfill_failed")
                throw error
            }
        }

        try await seedLedgerAfterRepair(
            metric: metric,
            rangeStart: rangeStart,
            rangeEnd: rangeEnd,
            rangeStartDay: session.rangeStartDay,
            rangeEndDay: session.rangeEndDay,
            context: context
        )
        try await establishBaselineAnchor(metric: metric, context: context)
        try await establishAdditionalBaselines(group: metric, rangeStart: rangeStart, rangeEnd: rangeEnd, context: context)

        var local = await stateStore.loadMetricState(userId: context.userId, personId: context.personId, metric: metric)
        local.repairId = nil
        local.pendingSync = false
        local.lastSuccessfulAt = Date()
        local.lastErrorCode = nil
        local.redactedStatus = "ready"
        await stateStore.saveMetricState(userId: context.userId, personId: context.personId, metric: metric, state: local)
        try outbox.setGroupStatus(groupKey: metric.rawValue, status: "ready")
        try outbox.updateBackfillSessionStatus(sessionId: session.sessionId, status: "completed")
    }

    private func uploadManifestsAndComplete(
        session: HealthKitBackfillSession,
        eventsByScope: [String: [String]],
        context: SessionContext
    ) async throws {
        // Always (re)upload manifests; server accepts duplicate identical hashes.
        for scope in session.requiredScopeKeys {
            let ids = eventsByScope[scope] ?? []
            let hash = HealthKitScopeManifest.hash(sessionId: session.sessionId, scopeKey: scope, eventIds: ids)
            _ = try await api.putHealthKitScopeManifest(
                baseURL: context.baseURL,
                accessToken: context.accessToken,
                sessionId: session.sessionId,
                scopeKey: scope,
                installationId: context.installationId,
                personId: context.personId,
                timezoneVersion: context.timezoneVersion,
                eventCount: ids.count,
                manifestHash: hash
            )
            try outbox.markScopeManifestUploaded(sessionId: session.sessionId, scopeKey: scope)
        }
        await HealthKitSyncWorker.shared.nudge(baseURL: context.baseURL) { context.accessToken }
        try requireDrainedSessionEvents(session.sessionId)
        _ = try await api.completeHealthKitBackfillSession(
            baseURL: context.baseURL,
            accessToken: context.accessToken,
            sessionId: session.sessionId,
            installationId: context.installationId,
            personId: context.personId,
            timezoneVersion: context.timezoneVersion
        )
    }

    private func requireDrainedSessionEvents(_ sessionId: String) throws {
        guard try outbox.pendingCount(sessionId: sessionId) == 0 else {
            throw HealthKitSyncEngineError.backfillEventsPending
        }
    }

    private func isTransientAPIError(_ error: HealthAPIError) -> Bool {
        switch error {
        case let .badStatus(status, _, code):
            if status == 429 || status >= 500 { return true }
            if status == -1 { return true } // transport
            // Permanent fencing codes are not transient.
            if let code, ["payload_invalid", "event_conflict", "manifest_incomplete", "session_expired",
                          "installation_inactive", "consent_withdrawn", "group_disabled", "timezone_stale"].contains(code) {
                return false
            }
            // 409 session_incomplete is handled explicitly; other 4xx default permanent.
            return false
        case .invalidURL, .missingToken:
            return false
        }
    }

    private func processAnchoredChanges(metric: HealthKitSyncMetric, context: SessionContext) async throws {
        let starting = try await loadAnchorCursor(key: cursorKey(for: metric, context: context), context: context, metric: metric)
        try await drainAnchoredFeed(metric: metric, context: context, startingAnchor: starting)
        // The primary type (steps, sleep, BP, or the first available type) is
        // anchored above. Other group members are daily aggregates, so refresh
        // their recent calendar window whenever that group receives a change.
        let rollingStart = Date().addingTimeInterval(-2 * 24 * 3600)
        let now = Date()
        let additional: [HealthKitSyncOperation]
        if metric == .sleep {
            additional = try await buildRepairOperations(
                metric: metric,
                rangeStart: rollingStart,
                rangeEnd: now,
                rangeStartDay: localDay(for: rollingStart, timeZone: context.timezone),
                rangeEndDay: localDay(for: now, timeZone: context.timezone),
                context: context
            )
        } else {
            additional = try await additionalRepairOperations(
                group: metric,
                rangeStart: rollingStart,
                rangeEnd: now,
                timeZone: context.timezone
            )
        }
        if !additional.isEmpty {
            for chunk in chunkOperations(additional.sorted { $0.stableKey < $1.stableKey }) {
                try await enqueueAndDrain(operations: chunk, context: context)
            }
        }
        var local = await stateStore.loadMetricState(userId: context.userId, personId: context.personId, metric: metric)
        local.pendingSync = false
        local.lastSuccessfulAt = Date()
        local.lastErrorCode = nil
        local.redactedStatus = "ready"
        await stateStore.saveMetricState(userId: context.userId, personId: context.personId, metric: metric, state: local)
    }

    /// Drain all anchored pages, uploading after each page, advancing the anchor only after ack.
    private func drainAnchoredFeed(
        metric: HealthKitSyncMetric,
        context: SessionContext,
        startingAnchor: HKQueryAnchor?
    ) async throws {
        let type = try healthKit.sampleType(for: metric)
        var anchor = startingAnchor
        var guardCount = 0
        while guardCount < 10_000 {
            guardCount += 1
            let page = try await healthKit.anchoredQuery(type: type, anchor: anchor, limit: anchoredPageLimit)
            let empty = page.added.isEmpty && page.deletedObjectUUIDs.isEmpty
            if !empty {
                try await applyAnchoredPage(metric: metric, context: context, page: page)
            }
            // Advance anchor only after successful local enqueue (or empty page).
            try await saveAnchorCursor(page.newAnchor, key: cursorKey(for: metric, context: context), context: context, metric: metric)
            anchor = page.newAnchor
            if empty || (page.added.count + page.deletedObjectUUIDs.count) < anchoredPageLimit {
                break
            }
        }
    }

    /// After a completed backfill, page the full change feed only to reach the terminal anchor (no re-upload).
    private func establishBaselineAnchor(metric: HealthKitSyncMetric, context: SessionContext) async throws {
        let type = try healthKit.sampleType(for: metric)
        var anchor: HKQueryAnchor?
        var guardCount = 0
        while guardCount < 10_000 {
            guardCount += 1
            let page = try await healthKit.anchoredQuery(type: type, anchor: anchor, limit: anchoredPageLimit)
            try await saveAnchorCursor(page.newAnchor, key: cursorKey(for: metric, context: context), context: context, metric: metric)
            anchor = page.newAnchor
            let pageSize = page.added.count + page.deletedObjectUUIDs.count
            if pageSize == 0 || pageSize < anchoredPageLimit {
                break
            }
        }
    }

    private func establishAdditionalBaselines(
        group: HealthKitSyncMetric,
        rangeStart: Date,
        rangeEnd: Date,
        context: SessionContext
    ) async throws {
        let expiry = Date().addingTimeInterval(90 * 24 * 3600)
        for dataMetric in HealthKitDataMetric.metrics(for: group) where isIncrementalDataMetric(dataMetric) {
            guard let type = dataMetric.sampleType else { continue }
            let samples = try await healthKit.samples(for: dataMetric, from: rangeStart, to: rangeEnd)
            var ledger: [String: HealthKitLedgerEntry] = [:]
            for sample in samples {
                let key = sample.uuid.uuidString.lowercased()
                ledger[key] = HealthKitLedgerEntry(
                    sourceUUID: key,
                    metric: dataMetric.rawValue,
                    bucketKeys: dataMetric.storage == .dailyNumeric ? [localDay(for: sample.endDate, timeZone: context.timezone)] : [key],
                    measuredAt: sample.endDate,
                    expiresAt: expiry
                )
            }
            await stateStore.saveDataMetricLedger(ledger, userId: context.userId, personId: context.personId, metric: dataMetric)

            var anchor: HKQueryAnchor?
            var guardCount = 0
            while guardCount < 10_000 {
                guardCount += 1
                let page = try await healthKit.anchoredQuery(type: type, anchor: anchor, limit: anchoredPageLimit)
                anchor = page.newAnchor
                if page.added.count + page.deletedObjectUUIDs.count < anchoredPageLimit { break }
            }
            try await saveAnchorCursor(
                anchor,
                key: dataMetricCursorKey(for: dataMetric, context: context),
                context: context,
                dataMetric: dataMetric
            )
        }
    }

    private func applyDataMetricPage(
        _ dataMetric: HealthKitDataMetric,
        context: SessionContext,
        page: HealthKitAnchoredChangePage
    ) async throws {
        var ledger = await stateStore.loadDataMetricLedger(userId: context.userId, personId: context.personId, metric: dataMetric)
        let expiry = Date().addingTimeInterval(90 * 24 * 3600)
        var operations: [HealthKitSyncOperation] = []

        switch dataMetric.storage {
        case .dailyNumeric:
            var affectedDays = Set<String>()
            for sample in page.added {
                let key = sample.uuid.uuidString.lowercased()
                let day = localDay(for: sample.endDate, timeZone: context.timezone)
                affectedDays.insert(day)
                ledger[key] = HealthKitLedgerEntry(sourceUUID: key, metric: dataMetric.rawValue, bucketKeys: [day], measuredAt: sample.endDate, expiresAt: expiry)
            }
            for deleted in page.deletedObjectUUIDs {
                let key = deleted.uuidString.lowercased()
                guard let entry = ledger.removeValue(forKey: key) else {
                    // Cannot map sample→day without ledger; start a real backfill (not a permanent throw).
                    try await runBackfill(metric: dataMetric.group, context: context)
                    return
                }
                affectedDays.formUnion(entry.bucketKeys)
                for day in entry.bucketKeys {
                    try markDayDirty(dataMetric: dataMetric, localDay: day, context: context, allowsDelete: true)
                }
            }
            for day in affectedDays {
                guard let start = parseDayStart(day, timeZone: context.timezone) else { continue }
                var calendar = Calendar(identifier: .gregorian)
                calendar.timeZone = TimeZone(identifier: context.timezone) ?? TimeZone(secondsFromGMT: 0)!
                guard let end = calendar.date(byAdding: .day, value: 1, to: start) else { continue }
                let replacements = try await dailyMetricOperations(metric: dataMetric, from: start, to: end, timeZone: context.timezone)
                if replacements.isEmpty {
                    operations.append(.dailyMetricDelete(healthMetric: dataMetric, localDay: day))
                } else {
                    operations += replacements.filter { $0.stableKey.hasSuffix(":" + day) }
                }
            }
        case .bloodGlucose:
            guard let unit = dataMetric.unit else { return }
            for sample in page.added.compactMap({ $0 as? HKQuantitySample }) {
                let key = sample.uuid.uuidString.lowercased()
                ledger[key] = HealthKitLedgerEntry(sourceUUID: key, metric: dataMetric.rawValue, bucketKeys: [key], measuredAt: sample.startDate, expiresAt: expiry)
                operations.append(.bloodGlucoseUpsert(sourceSampleKey: key, measuredAtUtc: isoInstant(sample.startDate), valueMgDl: sample.quantity.doubleValue(for: unit)))
            }
            for deleted in page.deletedObjectUUIDs {
                let key = deleted.uuidString.lowercased()
                ledger.removeValue(forKey: key)
                // Source-keyed: HK deletion UUID is sufficient; no ledger mapping required.
                operations.append(.bloodGlucoseDelete(sourceSampleKey: key))
            }
        case .workout:
            for workout in page.added.compactMap({ $0 as? HKWorkout }) {
                let key = workout.uuid.uuidString.lowercased()
                ledger[key] = HealthKitLedgerEntry(sourceUUID: key, metric: dataMetric.rawValue, bucketKeys: [key], measuredAt: workout.startDate, expiresAt: expiry)
                operations.append(workoutUpsert(workout))
            }
            for deleted in page.deletedObjectUUIDs {
                let key = deleted.uuidString.lowercased()
                ledger.removeValue(forKey: key)
                operations.append(.workoutDelete(sourceSampleKey: key))
            }
        case .hourly, .sleepDay, .bloodPressure:
            return
        }

        for chunk in chunkOperations(operations.sorted { $0.stableKey < $1.stableKey }) {
            try await enqueueAndDrain(operations: chunk, context: context)
        }
        await stateStore.saveDataMetricLedger(ledger, userId: context.userId, personId: context.personId, metric: dataMetric)
    }

    private func isIncrementalDataMetric(_ dataMetric: HealthKitDataMetric) -> Bool {
        switch dataMetric.storage {
        case .dailyNumeric, .bloodGlucose, .workout:
            return true
        case .hourly, .sleepDay, .bloodPressure:
            return false
        }
    }

    private func applyAnchoredPage(
        metric: HealthKitSyncMetric,
        context: SessionContext,
        page: HealthKitAnchoredChangePage
    ) async throws {
        var ledger = await stateStore.loadLedger(userId: context.userId, personId: context.personId, metric: metric)
        var operations: [HealthKitSyncOperation] = []
        var affectedBuckets = Set<String>()
        let expiry = Date().addingTimeInterval(90 * 24 * 3600)

        switch metric {
        case .activity:
            for sample in page.added {
                guard let quantity = sample as? HKQuantitySample else { continue }
                let hours = try await healthKit.hourlyStepCounts(from: quantity.startDate, to: quantity.endDate)
                var bucketKeys: [String] = []
                for hour in hours {
                    let key = isoHour(hour.hourStartUtc)
                    bucketKeys.append(key)
                    affectedBuckets.insert(key)
                }
                if bucketKeys.isEmpty {
                    // Instantaneous sample: still map to containing UTC hour.
                    let key = isoHour(quantity.startDate)
                    bucketKeys = [key]
                    affectedBuckets.insert(key)
                }
                ledger[quantity.uuid.uuidString] = HealthKitLedgerEntry(
                    sourceUUID: quantity.uuid.uuidString,
                    metric: metric.rawValue,
                    bucketKeys: Array(Set(bucketKeys)).sorted(),
                    measuredAt: quantity.startDate,
                    expiresAt: expiry
                )
            }
            for deleted in page.deletedObjectUUIDs {
                guard let entry = ledger[deleted.uuidString] else {
                    try await runBackfill(metric: metric, context: context)
                    return
                }
                affectedBuckets.formUnion(entry.bucketKeys)
                ledger.removeValue(forKey: deleted.uuidString)
                for bucket in entry.bucketKeys {
                    try markHourDirty(hourStartUtc: bucket, context: context, allowsDelete: true)
                }
            }
            for bucket in affectedBuckets {
                guard let hourDate = parseHour(bucket) else { continue }
                let hours = try await healthKit.hourlyStepCounts(
                    from: hourDate,
                    to: hourDate.addingTimeInterval(3600)
                )
                let count = hours.first?.count ?? 0
                operations.append(.stepsHourUpsert(hourStartUtc: bucket, count: count))
            }

        case .sleep:
            for sample in page.added {
                guard let category = sample as? HKCategorySample else { continue }
                let days = healthKit.sleepDayTotals(samples: [category], timeZoneIdentifier: context.timezone)
                let bucketKeys = Array(days.keys).sorted()
                affectedBuckets.formUnion(bucketKeys)
                ledger[category.uuid.uuidString] = HealthKitLedgerEntry(
                    sourceUUID: category.uuid.uuidString,
                    metric: metric.rawValue,
                    bucketKeys: bucketKeys,
                    measuredAt: category.endDate,
                    expiresAt: expiry
                )
            }
            for deleted in page.deletedObjectUUIDs {
                guard let entry = ledger[deleted.uuidString] else {
                    try await runBackfill(metric: metric, context: context)
                    return
                }
                affectedBuckets.formUnion(entry.bucketKeys)
                ledger.removeValue(forKey: deleted.uuidString)
                // Sleep ledger bucket keys are profile-local calendar days, not UTC hours.
                for day in entry.bucketKeys {
                    try markSleepDayDirty(sleepDay: day, context: context, allowsDelete: true)
                }
            }
            for day in affectedBuckets {
                guard let dayStart = parseDayStart(day, timeZone: context.timezone) else { continue }
                var calendar = Calendar(identifier: .gregorian)
                calendar.timeZone = TimeZone(identifier: context.timezone) ?? TimeZone(secondsFromGMT: 0)!
                guard let dayEnd = calendar.date(byAdding: .day, value: 1, to: dayStart) else { continue }
                let samples = try await healthKit.sleepSamples(
                    from: dayStart.addingTimeInterval(-12 * 3600),
                    to: dayEnd.addingTimeInterval(12 * 3600)
                )
                let totals = healthKit.sleepDayTotals(samples: samples, timeZoneIdentifier: context.timezone)
                operations.append(sleepUpsert(sleepDay: day, totals: totals[day] ?? HealthKitSleepDayTotals()))
            }

        case .vitals:
            for sample in page.added {
                guard let correlation = sample as? HKCorrelation,
                      let parsed = healthKit.parseBloodPressure(correlation)
                else { continue }
                let key = correlation.uuid.uuidString.lowercased()
                ledger[key] = HealthKitLedgerEntry(
                    sourceUUID: key,
                    metric: metric.rawValue,
                    bucketKeys: [key],
                    measuredAt: parsed.measuredAt,
                    expiresAt: expiry
                )
                operations.append(
                    .bloodPressureUpsert(sourceObjectKey: key,
                        measuredAtUtc: isoInstant(parsed.measuredAt),
                        systolic: parsed.systolic,
                        diastolic: parsed.diastolic,
                        pulse: parsed.pulse
                    )
                )
            }
            for deleted in page.deletedObjectUUIDs {
                let key = deleted.uuidString.lowercased()
                ledger.removeValue(forKey: key)
                operations.append(.bloodPressureDelete(sourceObjectKey: key))
            }
        case .body, .mobility, .workouts, .mindfulnessEnvironment, .nutrition:
            break
        }

        if !operations.isEmpty {
            let sorted = operations.sorted { $0.stableKey < $1.stableKey }
            for chunk in chunkOperations(sorted) {
                try await enqueueAndDrain(operations: chunk, context: context)
            }
        }

        await stateStore.saveLedger(ledger, userId: context.userId, personId: context.personId, metric: metric)
    }


    @discardableResult
    private func enqueueOperation(_ op: HealthKitSyncOperation, sessionId: String?, context: SessionContext) throws -> String {
        let eventId = UUID().uuidString.lowercased()
        let entityKey = op.stableKey
        // stableKey for upserts used as entity key after normalizing:
        let key = entityKeyFor(op)
        let version = try outbox.nextEntityVersion(entityKey: key)
        let payloadData = try payloadJSON(for: op)
        try outbox.enqueueEvent(
            eventId: eventId,
            entityKey: key,
            entityVersion: version,
            groupKey: op.metric.rawValue,
            scopeKey: scopeKey(for: op),
            op: isDelete(op) ? "delete" : "upsert",
            sessionId: sessionId,
            payloadJson: isDelete(op) ? nil : payloadData
        )
        return eventId
    }

    private func enqueueAndDrain(operations: [HealthKitSyncOperation], context: SessionContext, sessionId: String? = nil) async throws {
        for op in operations {
            _ = try enqueueOperation(op, sessionId: sessionId, context: context)
        }
        await HealthKitSyncWorker.shared.nudge(baseURL: context.baseURL) { context.accessToken }
    }

    private func isDelete(_ op: HealthKitSyncOperation) -> Bool {
        switch op {
        case .stepsHourDelete, .sleepDayDelete, .dailyMetricDelete, .bloodPressureDelete, .bloodGlucoseDelete, .workoutDelete:
            return true
        default:
            return false
        }
    }

    private func scopeKey(for op: HealthKitSyncOperation) -> String {
        switch op {
        case .stepsHourUpsert, .stepsHourDelete:
            return "steps"
        case .sleepDayUpsert, .sleepDayDelete:
            return "sleep"
        case let .dailyMetricUpsert(healthMetric, _, _, _, _, _, _, _):
            return healthMetric.rawValue
        case let .dailyMetricDelete(healthMetric, _):
            return healthMetric.rawValue
        case .bloodPressureUpsert, .bloodPressureDelete:
            return "blood_pressure"
        case .bloodGlucoseUpsert, .bloodGlucoseDelete:
            return "blood_glucose"
        case .workoutUpsert, .workoutDelete:
            return "workout"
        }
    }

    private func entityKeyFor(_ op: HealthKitSyncOperation) -> String {
        switch op {
        case let .stepsHourUpsert(hourStartUtc, _):
            return "steps_hour:\(hourStartUtc)"
        case let .stepsHourDelete(hourStartUtc):
            return "steps_hour:\(hourStartUtc)"
        case let .sleepDayUpsert(sleepDay, _, _, _, _, _, _, _, _, _):
            return "sleep_day:\(sleepDay)"
        case let .sleepDayDelete(sleepDay):
            return "sleep_day:\(sleepDay)"
        case let .dailyMetricUpsert(healthMetric, localDay, _, _, _, _, _, _):
            return "daily_metric:\(healthMetric.rawValue):\(localDay)"
        case let .dailyMetricDelete(healthMetric, localDay):
            return "daily_metric:\(healthMetric.rawValue):\(localDay)"
        case let .bloodPressureUpsert(sourceObjectKey, _, _, _, _):
            return "blood_pressure:\(sourceObjectKey)"
        case let .bloodPressureDelete(sourceObjectKey):
            return "blood_pressure:\(sourceObjectKey)"
        case let .bloodGlucoseUpsert(sourceSampleKey, _, _):
            return "blood_glucose:\(sourceSampleKey)"
        case let .bloodGlucoseDelete(sourceSampleKey):
            return "blood_glucose:\(sourceSampleKey)"
        case let .workoutUpsert(sourceSampleKey, _, _, _, _, _, _, _, _):
            return "workout:\(sourceSampleKey)"
        case let .workoutDelete(sourceSampleKey):
            return "workout:\(sourceSampleKey)"
        }
    }

    private func payloadJSON(for op: HealthKitSyncOperation) throws -> Data {
        let payload: HealthKitEventPayload
        switch op {
        case let .stepsHourUpsert(hourStartUtc, count):
            payload = .stepsHour(hourStartUtc: hourStartUtc, count: count)
        case let .sleepDayUpsert(sleepDay, totalMinutes, coreMinutes, deepMinutes, remMinutes, unspecifiedAsleepMinutes, awakeMinutes, inBedMinutes, wristTemperatureCelsius, breathingDisturbanceCount):
            payload = .sleepDay(
                sleepDay: sleepDay,
                totalMinutes: totalMinutes,
                coreMinutes: coreMinutes,
                deepMinutes: deepMinutes,
                remMinutes: remMinutes,
                unspecifiedAsleepMinutes: unspecifiedAsleepMinutes,
                awakeMinutes: awakeMinutes,
                inBedMinutes: inBedMinutes,
                wristTemperatureCelsius: wristTemperatureCelsius,
                breathingDisturbanceCount: breathingDisturbanceCount
            )
        case let .dailyMetricUpsert(healthMetric, localDay, sumValue, averageValue, minimumValue, maximumValue, latestValue, sampleCount):
            payload = .dailyMetric(
                healthMetric: healthMetric,
                localDay: localDay,
                sumValue: sumValue,
                averageValue: averageValue,
                minimumValue: minimumValue,
                maximumValue: maximumValue,
                latestValue: latestValue,
                sampleCount: sampleCount
            )
        case let .bloodPressureUpsert(sourceObjectKey, measuredAtUtc, systolic, diastolic, pulse):
            payload = .bloodPressure(
                sourceObjectKey: sourceObjectKey,
                measuredAtUtc: measuredAtUtc,
                systolic: systolic,
                diastolic: diastolic,
                pulse: pulse
            )
        case let .bloodGlucoseUpsert(sourceSampleKey, measuredAtUtc, valueMgDl):
            payload = .bloodGlucose(sourceSampleKey: sourceSampleKey, measuredAtUtc: measuredAtUtc, valueMgDl: valueMgDl)
        case let .workoutUpsert(sourceSampleKey, workoutType, startedAtUtc, endedAtUtc, durationSeconds, activeEnergyKcal, distanceMeters, averageHeartRateBpm, maximumHeartRateBpm):
            payload = .workout(
                sourceSampleKey: sourceSampleKey,
                workoutType: workoutType,
                startedAtUtc: startedAtUtc,
                endedAtUtc: endedAtUtc,
                durationSeconds: durationSeconds,
                activeEnergyKcal: activeEnergyKcal,
                distanceMeters: distanceMeters,
                averageHeartRateBpm: averageHeartRateBpm,
                maximumHeartRateBpm: maximumHeartRateBpm
            )
        case .stepsHourDelete, .sleepDayDelete, .dailyMetricDelete, .bloodPressureDelete, .bloodGlucoseDelete, .workoutDelete:
            throw HealthKitSyncEngineError.missingConfiguration
        }
        return try JSONEncoder().encode(payload)
    }

    private func chunkOperations(_ operations: [HealthKitSyncOperation]) -> [[HealthKitSyncOperation]] {
        guard !operations.isEmpty else { return [] }
        return stride(from: 0, to: operations.count, by: maxOperations).map { start in
            let end = min(start + maxOperations, operations.count)
            return Array(operations[start..<end])
        }
    }

    private func buildRepairOperations(
        metric: HealthKitSyncMetric,
        rangeStart: Date,
        rangeEnd: Date,
        rangeStartDay: String,
        rangeEndDay: String,
        context: SessionContext
    ) async throws -> [HealthKitSyncOperation] {
        let primaryOperations: [HealthKitSyncOperation]
        switch metric {
        case .activity:
            let firstHour = firstStepHourInsideRepairRange(rangeStart)
            if firstHour > rangeEnd {
                primaryOperations = []
            } else {
                let hours = try await healthKit.hourlyStepCounts(from: firstHour, to: rangeEnd)
                primaryOperations = hours
                    .filter { $0.hourStartUtc >= firstHour && $0.hourStartUtc <= rangeEnd }
                    .map { .stepsHourUpsert(hourStartUtc: isoHour($0.hourStartUtc), count: $0.count) }
            }
        case .sleep:
            let samples = try await sleepSamplesForRepair(
                rangeStartDay: rangeStartDay,
                rangeEndDay: rangeEndDay,
                timeZone: context.timezone
            )
            var days = healthKit.sleepDayTotals(samples: samples, timeZoneIdentifier: context.timezone)
            for dataMetric in [HealthKitDataMetric.sleepingWristTemperature, .sleepBreathingDisturbanceEvents] {
                guard let unit = dataMetric.unit else { continue }
                let values = try await healthKit.quantitySamples(for: dataMetric, from: rangeStart, to: rangeEnd)
                for sample in values {
                    let day = localDay(for: sample.endDate, timeZone: context.timezone)
                    var totals = days[day, default: HealthKitSleepDayTotals()]
                    if dataMetric == .sleepingWristTemperature {
                        totals.wristTemperatureCelsius = sample.quantity.doubleValue(for: unit)
                    } else {
                        totals.breathingDisturbanceCount = (totals.breathingDisturbanceCount ?? 0) + Int(sample.quantity.doubleValue(for: unit).rounded())
                    }
                    days[day] = totals
                }
            }
            primaryOperations = days
                .filter { $0.key >= rangeStartDay && $0.key <= rangeEndDay }
                .map { sleepUpsert(sleepDay: $0.key, totals: $0.value) }
        case .vitals:
            let correlations = try await healthKit.bloodPressureCorrelations(from: rangeStart, to: rangeEnd)
            primaryOperations = correlations.compactMap { correlation in
                guard let parsed = healthKit.parseBloodPressure(correlation) else { return nil }
                return .bloodPressureUpsert(sourceObjectKey: correlation.uuid.uuidString.lowercased(),
                    measuredAtUtc: isoInstant(parsed.measuredAt),
                    systolic: parsed.systolic,
                    diastolic: parsed.diastolic,
                    pulse: parsed.pulse
                )
            }
        case .body, .mobility, .workouts, .mindfulnessEnvironment, .nutrition:
            primaryOperations = []
        }
        let operations = primaryOperations + (try await additionalRepairOperations(
            group: metric,
            rangeStart: rangeStart,
            rangeEnd: rangeEnd,
            timeZone: context.timezone
        ))
        // A repair is authorized for one consent group only. Keep the boundary
        // client-side as well, so a registry or aggregation regression cannot
        // send a mixed chunk that the API correctly rejects.
        return operations.filter { $0.metric == metric }
    }

    private func seedLedgerAfterRepair(
        metric: HealthKitSyncMetric,
        rangeStart: Date,
        rangeEnd: Date,
        rangeStartDay: String,
        rangeEndDay: String,
        context: SessionContext
    ) async throws {
        var ledger: [String: HealthKitLedgerEntry] = [:]
        let expiry = Date().addingTimeInterval(90 * 24 * 3600)
        switch metric {
        case .activity:
            let firstHour = firstStepHourInsideRepairRange(rangeStart)
            guard firstHour <= rangeEnd else { break }
            let samples = try await healthKit.stepQuantitySamples(from: firstHour, to: rangeEnd)
            for sample in samples {
                let hours = try await healthKit.hourlyStepCounts(from: sample.startDate, to: sample.endDate)
                let bucketKeys = hours
                    .filter { $0.hourStartUtc >= firstHour && $0.hourStartUtc <= rangeEnd }
                    .map { isoHour($0.hourStartUtc) }
                guard !bucketKeys.isEmpty else { continue }
                ledger[sample.uuid.uuidString] = HealthKitLedgerEntry(
                    sourceUUID: sample.uuid.uuidString,
                    metric: metric.rawValue,
                    bucketKeys: Array(Set(bucketKeys)).sorted(),
                    measuredAt: sample.startDate,
                    expiresAt: expiry
                )
            }
        case .sleep:
            let samples = try await sleepSamplesForRepair(
                rangeStartDay: rangeStartDay,
                rangeEndDay: rangeEndDay,
                timeZone: context.timezone
            )
            for sample in samples {
                let days = healthKit.sleepDayTotals(samples: [sample], timeZoneIdentifier: context.timezone)
                let keys = days.keys.filter { $0 >= rangeStartDay && $0 <= rangeEndDay }.sorted()
                guard !keys.isEmpty else { continue }
                ledger[sample.uuid.uuidString] = HealthKitLedgerEntry(
                    sourceUUID: sample.uuid.uuidString,
                    metric: metric.rawValue,
                    bucketKeys: keys,
                    measuredAt: sample.endDate,
                    expiresAt: expiry
                )
            }
        case .vitals:
            let correlations = try await healthKit.bloodPressureCorrelations(from: rangeStart, to: rangeEnd)
            for correlation in correlations {
                let key = correlation.uuid.uuidString.lowercased()
                ledger[key] = HealthKitLedgerEntry(
                    sourceUUID: key,
                    metric: metric.rawValue,
                    bucketKeys: [key],
                    measuredAt: correlation.startDate,
                    expiresAt: expiry
                )
            }
        case .body, .mobility, .workouts, .mindfulnessEnvironment, .nutrition:
            break
        }
        await stateStore.saveLedger(ledger, userId: context.userId, personId: context.personId, metric: metric)
    }

    private func firstStepHourInsideRepairRange(_ rangeStart: Date) -> Date {
        var calendar = Calendar(identifier: .gregorian)
        calendar.timeZone = TimeZone(secondsFromGMT: 0)!
        let hour = calendar.dateComponents([.year, .month, .day, .hour], from: rangeStart)
        guard let roundedDown = calendar.date(from: hour) else { return rangeStart }
        return roundedDown < rangeStart ? roundedDown.addingTimeInterval(3600) : roundedDown
    }

    private func sleepSamplesForRepair(
        rangeStartDay: String,
        rangeEndDay: String,
        timeZone: String
    ) async throws -> [HKCategorySample] {
        guard let start = parseDayStart(rangeStartDay, timeZone: timeZone),
              let endDayStart = parseDayStart(rangeEndDay, timeZone: timeZone),
              let zone = TimeZone(identifier: timeZone)
        else {
            throw HealthKitSyncEngineError.missingConfiguration
        }
        var calendar = Calendar(identifier: .gregorian)
        calendar.timeZone = zone
        guard let end = calendar.date(byAdding: .day, value: 1, to: endDayStart) else {
            throw HealthKitSyncEngineError.missingConfiguration
        }
        return try await healthKit.sleepSamples(from: start, to: end)
    }

    private func sleepUpsert(sleepDay: String, totals: HealthKitSleepDayTotals) -> HealthKitSyncOperation {
        .sleepDayUpsert(
            sleepDay: sleepDay,
            totalMinutes: totals.totalMinutes,
            coreMinutes: totals.coreMinutes,
            deepMinutes: totals.deepMinutes,
            remMinutes: totals.remMinutes,
            unspecifiedAsleepMinutes: totals.unspecifiedAsleepMinutes,
            awakeMinutes: totals.awakeMinutes,
            inBedMinutes: totals.inBedMinutes,
            wristTemperatureCelsius: totals.wristTemperatureCelsius,
            breathingDisturbanceCount: totals.breathingDisturbanceCount
        )
    }

    /// Produces canonical records for every non-specialized type in a consent group.
    /// Daily values are recomputed from HealthKit for the repair window, so multiple
    /// sources do not produce duplicate backend rows.
    private func additionalRepairOperations(
        group: HealthKitSyncMetric,
        rangeStart: Date,
        rangeEnd: Date,
        timeZone: String
    ) async throws -> [HealthKitSyncOperation] {
        var operations: [HealthKitSyncOperation] = []
        for dataMetric in HealthKitDataMetric.metrics(for: group) {
            switch dataMetric.storage {
            case .hourly, .sleepDay, .bloodPressure:
                continue
            case .dailyNumeric:
                operations += try await dailyMetricOperations(
                    metric: dataMetric,
                    from: rangeStart,
                    to: rangeEnd,
                    timeZone: timeZone
                )
            case .bloodGlucose:
                let samples = try await healthKit.quantitySamples(for: dataMetric, from: rangeStart, to: rangeEnd)
                guard let unit = dataMetric.unit else { continue }
                operations += samples.map {
                    .bloodGlucoseUpsert(
                        sourceSampleKey: $0.uuid.uuidString.lowercased(),
                        measuredAtUtc: isoInstant($0.startDate),
                        valueMgDl: $0.quantity.doubleValue(for: unit)
                    )
                }
            case .workout:
                let workouts = try await healthKit.workouts(from: rangeStart, to: rangeEnd)
                operations += workouts.map { workoutUpsert($0) }
            }
        }
        return operations
    }

    private func dailyMetricOperations(
        metric: HealthKitDataMetric,
        from start: Date,
        to end: Date,
        timeZone: String
    ) async throws -> [HealthKitSyncOperation] {
        if metric == .mindfulMinutes {
            let sessions = try await healthKit.mindfulSessions(from: start, to: end)
            let grouped = Dictionary(grouping: sessions, by: { localDay(for: $0.endDate, timeZone: timeZone) })
            return grouped.map { day, values in
                .dailyMetricUpsert(
                    healthMetric: metric,
                    localDay: day,
                    sumValue: values.reduce(0) { $0 + $1.endDate.timeIntervalSince($1.startDate) / 60 },
                    averageValue: nil,
                    minimumValue: nil,
                    maximumValue: nil,
                    latestValue: nil,
                    sampleCount: values.count
                )
            }
        }
        guard let unit = metric.unit else { return [] }
        let samples = try await healthKit.quantitySamples(for: metric, from: start, to: end)
        let grouped = Dictionary(grouping: samples, by: { localDay(for: $0.endDate, timeZone: timeZone) })
        return grouped.compactMap { day, values in
            let quantities = values.map { $0.quantity.doubleValue(for: unit) }
            guard !quantities.isEmpty else { return nil }
            switch metric.aggregation {
            case .sum:
                return .dailyMetricUpsert(healthMetric: metric, localDay: day, sumValue: quantities.reduce(0, +), averageValue: nil, minimumValue: nil, maximumValue: nil, latestValue: nil, sampleCount: quantities.count)
            case .statistics:
                guard let latest = values.max(by: { $0.endDate < $1.endDate }) else { return nil }
                return .dailyMetricUpsert(healthMetric: metric, localDay: day, sumValue: nil, averageValue: quantities.reduce(0, +) / Double(quantities.count), minimumValue: quantities.min(), maximumValue: quantities.max(), latestValue: latest.quantity.doubleValue(for: unit), sampleCount: quantities.count)
            case .latest:
                guard let latest = values.max(by: { $0.endDate < $1.endDate }) else { return nil }
                return .dailyMetricUpsert(healthMetric: metric, localDay: day, sumValue: nil, averageValue: nil, minimumValue: nil, maximumValue: nil, latestValue: latest.quantity.doubleValue(for: unit), sampleCount: quantities.count)
            }
        }
    }

    private func workoutUpsert(_ workout: HKWorkout) -> HealthKitSyncOperation {
        let distance = workout.totalDistance?.doubleValue(for: .meter())
        let activeEnergy = HKQuantityType.quantityType(forIdentifier: .activeEnergyBurned)
        let energy = activeEnergy.flatMap { workout.statistics(for: $0)?.sumQuantity()?.doubleValue(for: .kilocalorie()) }
        let heartRate = HKQuantityType.quantityType(forIdentifier: .heartRate)
        let averageHeartRate = heartRate.flatMap { workout.statistics(for: $0)?.averageQuantity()?.doubleValue(for: HKUnit.count().unitDivided(by: .minute())) }
        let maximumHeartRate = heartRate.flatMap { workout.statistics(for: $0)?.maximumQuantity()?.doubleValue(for: HKUnit.count().unitDivided(by: .minute())) }
        return .workoutUpsert(
            sourceSampleKey: workout.uuid.uuidString.lowercased(),
            workoutType: "\(workout.workoutActivityType.rawValue)",
            startedAtUtc: isoInstant(workout.startDate),
            endedAtUtc: isoInstant(workout.endDate),
            durationSeconds: max(0, Int(workout.duration.rounded())),
            activeEnergyKcal: energy,
            distanceMeters: distance,
            averageHeartRateBpm: averageHeartRate,
            maximumHeartRateBpm: maximumHeartRate
        )
    }

    private func localDay(for date: Date, timeZone: String) -> String {
        let formatter = DateFormatter()
        formatter.calendar = Calendar(identifier: .gregorian)
        formatter.locale = Locale(identifier: "en_US_POSIX")
        formatter.timeZone = TimeZone(identifier: timeZone) ?? TimeZone(secondsFromGMT: 0)
        formatter.dateFormat = "yyyy-MM-dd"
        return formatter.string(from: date)
    }

    private func isoHour(_ date: Date) -> String {
        var calendar = Calendar(identifier: .gregorian)
        calendar.timeZone = TimeZone(secondsFromGMT: 0)!
        let comps = calendar.dateComponents([.year, .month, .day, .hour], from: date)
        let hourDate = calendar.date(from: comps) ?? date
        let basic = ISO8601DateFormatter()
        basic.formatOptions = [.withInternetDateTime]
        return basic.string(from: hourDate)
    }

    private func isoInstant(_ date: Date) -> String {
        let formatter = ISO8601DateFormatter()
        formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return formatter.string(from: date)
    }

    private func parseInstant(_ value: String) -> Date? {
        let formatter = ISO8601DateFormatter()
        formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        if let date = formatter.date(from: value) { return date }
        formatter.formatOptions = [.withInternetDateTime]
        return formatter.date(from: value)
    }

    private func parseHour(_ value: String) -> Date? {
        parseInstant(value)
    }

    private func parseDayStart(_ day: String, timeZone: String) -> Date? {
        let formatter = DateFormatter()
        formatter.calendar = Calendar(identifier: .gregorian)
        formatter.locale = Locale(identifier: "en_US_POSIX")
        formatter.timeZone = TimeZone(identifier: timeZone) ?? TimeZone(secondsFromGMT: 0)
        formatter.dateFormat = "yyyy-MM-dd"
        return formatter.date(from: day)
    }

    // MARK: - SQLite cursors + dirty buckets

    private func cursorKey(for metric: HealthKitSyncMetric, context: SessionContext) -> String {
        "anchor:\(context.userId):\(context.personId):\(metric.rawValue)"
    }

    private func dataMetricCursorKey(for dataMetric: HealthKitDataMetric, context: SessionContext) -> String {
        "anchor:\(context.userId):\(context.personId):metric:\(dataMetric.rawValue)"
    }

    private func loadAnchorCursor(
        key: String,
        context: SessionContext,
        metric: HealthKitSyncMetric? = nil,
        dataMetric: HealthKitDataMetric? = nil
    ) async throws -> HKQueryAnchor? {
        if let data = try outbox.loadCursor(key: key),
           let anchor = try? NSKeyedUnarchiver.unarchivedObject(ofClass: HKQueryAnchor.self, from: data) {
            return anchor
        }
        // Legacy UserDefaults fallback during migration off the fragile path.
        if let metric {
            return await stateStore.loadAnchor(userId: context.userId, personId: context.personId, metric: metric)
        }
        if let dataMetric {
            return await stateStore.loadDataMetricAnchor(userId: context.userId, personId: context.personId, metric: dataMetric)
        }
        return nil
    }

    private func saveAnchorCursor(
        _ anchor: HKQueryAnchor?,
        key: String,
        context: SessionContext,
        metric: HealthKitSyncMetric? = nil,
        dataMetric: HealthKitDataMetric? = nil
    ) async throws {
        let data = try anchor.flatMap { try NSKeyedArchiver.archivedData(withRootObject: $0, requiringSecureCoding: true) }
        try outbox.saveCursor(key: key, anchor: data)
        // Dual-write legacy store for UI until fully removed.
        if let metric {
            await stateStore.saveAnchor(anchor, userId: context.userId, personId: context.personId, metric: metric)
        }
        if let dataMetric {
            await stateStore.saveDataMetricAnchor(anchor, userId: context.userId, personId: context.personId, metric: dataMetric)
        }
    }

    private func markHourDirty(hourStartUtc: String, context: SessionContext, allowsDelete: Bool) throws {
        let descriptor = HealthKitOutboxStore.BucketDescriptor(kind: "steps_hour", hourStartUtc: hourStartUtc, localDay: nil, healthMetric: nil)
        let json = try JSONEncoder().encode(descriptor)
        try outbox.markDirtyBucket(
            entityKey: "steps_hour:\(hourStartUtc)",
            groupKey: HealthKitSyncMetric.activity.rawValue,
            scopeKey: "steps",
            bucketJson: json,
            allowsDelete: allowsDelete
        )
    }

    private func markSleepDayDirty(sleepDay: String, context: SessionContext, allowsDelete: Bool) throws {
        let descriptor = HealthKitOutboxStore.BucketDescriptor(kind: "sleep_day", hourStartUtc: nil, localDay: sleepDay, healthMetric: nil)
        let json = try JSONEncoder().encode(descriptor)
        try outbox.markDirtyBucket(
            entityKey: "sleep_day:\(sleepDay)",
            groupKey: HealthKitSyncMetric.sleep.rawValue,
            scopeKey: "sleep",
            bucketJson: json,
            allowsDelete: allowsDelete
        )
    }

    private func markDayDirty(
        dataMetric: HealthKitDataMetric,
        localDay: String,
        context: SessionContext,
        allowsDelete: Bool
    ) throws {
        let descriptor = HealthKitOutboxStore.BucketDescriptor(
            kind: "daily_metric",
            hourStartUtc: nil,
            localDay: localDay,
            healthMetric: dataMetric.rawValue
        )
        let json = try JSONEncoder().encode(descriptor)
        try outbox.markDirtyBucket(
            entityKey: "daily_metric:\(dataMetric.rawValue):\(localDay)",
            groupKey: dataMetric.group.rawValue,
            scopeKey: dataMetric.rawValue,
            bucketJson: json,
            allowsDelete: allowsDelete
        )
    }

    /// Recompute dirty buckets from HealthKit and emit immutable events only when generation is unchanged.
    /// Outbox insert + dirty delete happen in one SQLite transaction.
    private func materializeDirtyBuckets(context: SessionContext) async throws {
        let dirty = try outbox.claimDirtyBuckets(limit: 50)
        for row in dirty {
            let generation = row.dirtyGeneration
            let descriptor = try JSONDecoder().decode(HealthKitOutboxStore.BucketDescriptor.self, from: row.bucketJson)
            var operations: [HealthKitSyncOperation] = []
            switch descriptor.kind {
            case "steps_hour":
                guard let hour = descriptor.hourStartUtc, let hourDate = parseHour(hour) else { continue }
                let hours = try await healthKit.hourlyStepCounts(from: hourDate, to: hourDate.addingTimeInterval(3600))
                let count = hours.first?.count ?? 0
                if count == 0 {
                    if row.allowsDeleteFlag {
                        operations.append(.stepsHourDelete(hourStartUtc: hour))
                    }
                    // else: clear dirty without event (empty incremental recompute without observed delete)
                } else {
                    operations.append(.stepsHourUpsert(hourStartUtc: hour, count: count))
                }
            case "sleep_day":
                guard let day = descriptor.localDay,
                      let dayStart = parseDayStart(day, timeZone: context.timezone)
                else { continue }
                var calendar = Calendar(identifier: .gregorian)
                calendar.timeZone = TimeZone(identifier: context.timezone) ?? TimeZone(secondsFromGMT: 0)!
                guard let dayEnd = calendar.date(byAdding: .day, value: 1, to: dayStart) else { continue }
                let samples = try await healthKit.sleepSamples(
                    from: dayStart.addingTimeInterval(-12 * 3600),
                    to: dayEnd.addingTimeInterval(12 * 3600)
                )
                let totals = healthKit.sleepDayTotals(samples: samples, timeZoneIdentifier: context.timezone)
                if let dayTotals = totals[day] {
                    operations.append(sleepUpsert(sleepDay: day, totals: dayTotals))
                } else if row.allowsDeleteFlag {
                    operations.append(.sleepDayDelete(sleepDay: day))
                }
            case "daily_metric":
                guard let day = descriptor.localDay,
                      let metricRaw = descriptor.healthMetric,
                      let dataMetric = HealthKitDataMetric(rawValue: metricRaw),
                      let start = parseDayStart(day, timeZone: context.timezone)
                else { continue }
                var calendar = Calendar(identifier: .gregorian)
                calendar.timeZone = TimeZone(identifier: context.timezone) ?? TimeZone(secondsFromGMT: 0)!
                guard let end = calendar.date(byAdding: .day, value: 1, to: start) else { continue }
                let replacements = try await dailyMetricOperations(
                    metric: dataMetric,
                    from: start,
                    to: end,
                    timeZone: context.timezone
                )
                if replacements.isEmpty {
                    if row.allowsDeleteFlag {
                        operations.append(.dailyMetricDelete(healthMetric: dataMetric, localDay: day))
                    }
                } else {
                    operations += replacements.filter { $0.stableKey.hasSuffix(":" + day) }
                }
            default:
                continue
            }

            let eventSpecs: [(
                eventId: String,
                entityKey: String,
                entityVersion: Int?,
                groupKey: String,
                scopeKey: String,
                op: String,
                sessionId: String?,
                payloadJson: Data?
            )] = try operations.map { op in
                let key = entityKeyFor(op)
                let payload: Data? = isDelete(op) ? nil : (try payloadJSON(for: op))
                return (
                    eventId: UUID().uuidString.lowercased(),
                    entityKey: key,
                    entityVersion: nil,
                    groupKey: op.metric.rawValue,
                    scopeKey: scopeKey(for: op),
                    op: isDelete(op) ? "delete" : "upsert",
                    sessionId: nil,
                    payloadJson: payload
                )
            }

            // Empty ops still clear dirty atomically (no event) when generation matches.
            let committed = try outbox.materializeDirtyBucketAtomically(
                entityKey: row.entityKey,
                expectedGeneration: generation,
                events: eventSpecs
            )
            if committed, !eventSpecs.isEmpty {
                // Upload only after durable local write of replacement event(s).
                await HealthKitSyncWorker.shared.nudge(baseURL: context.baseURL) { context.accessToken }
            }
            // If generation changed during recompute, leave dirty for another pass.
        }
    }
}
