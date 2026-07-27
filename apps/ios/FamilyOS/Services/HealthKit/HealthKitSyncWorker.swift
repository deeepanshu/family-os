import CryptoKit
import Foundation

/// App-wide serialized worker that drains the local outbox to the Family OS API.
actor HealthKitSyncWorker {
    static let shared = HealthKitSyncWorker()

    private let api = HealthAPIClient()
    private let store = HealthKitOutboxStore.shared
    private var isDraining = false
    private var drainWaiters: [CheckedContinuation<Void, Never>] = []
    private var authRefreshInFlight: Task<String?, Never>?

    func start() {
        Task { try? store.resetInFlightToPending() }
    }

    /// Nudge the worker. Concurrent callers coalesce into one drain pass.
    func nudge(
        baseURL: String,
        accessTokenProvider: @escaping @Sendable () async -> String?
    ) async {
        if isDraining {
            await withCheckedContinuation { continuation in
                drainWaiters.append(continuation)
            }
            return
        }
        isDraining = true
        defer {
            isDraining = false
            let waiters = drainWaiters
            drainWaiters.removeAll()
            waiters.forEach { $0.resume() }
        }

        do {
            try store.resetInFlightToPending()
            while true {
                let batch = try store.claimPendingEvents(limit: 100)
                guard !batch.isEmpty else { break }
                guard let config = try store.loadConfiguration() else {
                    // Cannot upload without configuration; release claim.
                    for row in batch {
                        try store.scheduleRetry(eventId: row.eventId, attemptCount: row.attemptCount, delaySeconds: 60)
                    }
                    break
                }
                guard let token = await accessTokenProvider() else {
                    for row in batch {
                        try store.scheduleRetry(eventId: row.eventId, attemptCount: row.attemptCount, delaySeconds: 5)
                    }
                    break
                }

                var wireEvents: [HealthKitWireEvent] = []
                wireEvents.reserveCapacity(batch.count)

                for row in batch {
                    switch validateAndWire(row) {
                    case let .ok(event):
                        wireEvents.append(event)
                    case let .invalidNormal(code):
                        try store.failPermanent(
                            eventId: row.eventId,
                            entityKey: row.entityKey,
                            groupKey: row.groupKey,
                            errorCode: code
                        )
                    case let .invalidSession(code):
                        try await abortSessionTaggedEvent(
                            row: row,
                            config: config,
                            baseURL: baseURL,
                            token: token,
                            errorCode: code
                        )
                    }
                }

                guard !wireEvents.isEmpty else {
                    // Entire claim was invalid; continue claiming more pending work.
                    continue
                }

                do {
                    let result = try await api.applyHealthKitEvents(
                        baseURL: baseURL,
                        accessToken: token,
                        installationId: config.installationId,
                        personId: config.personId,
                        timezoneVersion: config.timezoneVersion,
                        events: wireEvents
                    )
                    try await handleBatchResults(
                        result.results,
                        original: batch,
                        wireEventIds: Set(wireEvents.map(\.eventId)),
                        config: config,
                        baseURL: baseURL,
                        token: token
                    )
                } catch let error as HealthAPIError {
                    let wireIds = Set(wireEvents.map(\.eventId))
                    let sentRows = batch.filter { wireIds.contains($0.eventId) }
                    try await handleTransportError(
                        error,
                        events: sentRows,
                        baseURL: baseURL,
                        accessTokenProvider: accessTokenProvider
                    )
                    break
                }
            }
        } catch {
            #if DEBUG
            print("FamilyOS HealthKit worker error: \(error)")
            #endif
        }
    }

    // MARK: - Validation

    private enum WireValidation {
        case ok(HealthKitWireEvent)
        case invalidNormal(String)
        case invalidSession(String)
    }

    private func validateAndWire(_ row: HealthKitOutboxStore.OutboxEvent) -> WireValidation {
        guard let group = HealthKitSyncMetric(rawValue: row.groupKey) else {
            return row.sessionId == nil ? .invalidNormal("payload_invalid") : .invalidSession("payload_invalid")
        }
        guard row.op == "upsert" || row.op == "delete" else {
            return row.sessionId == nil ? .invalidNormal("payload_invalid") : .invalidSession("payload_invalid")
        }

        let payload: HealthKitEventPayload?
        if row.op == "delete" {
            if row.payloadJson != nil {
                return row.sessionId == nil ? .invalidNormal("payload_invalid") : .invalidSession("payload_invalid")
            }
            payload = nil
        } else {
            guard let data = row.payloadJson,
                  let decoded = try? JSONDecoder().decode(HealthKitEventPayloadDTO.self, from: data).asPayload()
            else {
                return row.sessionId == nil ? .invalidNormal("payload_invalid") : .invalidSession("payload_invalid")
            }
            payload = decoded
        }

        return .ok(
            HealthKitWireEvent(
                eventId: row.eventId,
                entityKey: row.entityKey,
                entityVersion: row.entityVersion,
                group: group,
                scopeKey: row.scopeKey,
                op: row.op,
                sessionId: row.sessionId,
                payload: payload
            )
        )
    }

    private func handleBatchResults(
        _ results: [HealthKitEventApplyResult],
        original: [HealthKitOutboxStore.OutboxEvent],
        wireEventIds: Set<String>,
        config: HealthKitOutboxStore.ConfigurationRow,
        baseURL: String,
        token: String
    ) async throws {
        let byId = Dictionary(uniqueKeysWithValues: original.map { ($0.eventId, $0) })
        var handled = Set<String>()
        var deleteIds: [String] = []

        for item in results {
            handled.insert(item.eventId)
            guard let row = byId[item.eventId], wireEventIds.contains(item.eventId) else { continue }
            switch item.result {
            case "applied", "duplicate", "superseded":
                deleteIds.append(item.eventId)
            case "payload_invalid", "event_conflict":
                if row.sessionId != nil {
                    try await abortSessionTaggedEvent(
                        row: row,
                        config: config,
                        baseURL: baseURL,
                        token: token,
                        errorCode: item.result
                    )
                } else {
                    try store.failPermanent(
                        eventId: row.eventId,
                        entityKey: row.entityKey,
                        groupKey: row.groupKey,
                        errorCode: item.result
                    )
                }
            default:
                try store.scheduleRetry(
                    eventId: row.eventId,
                    attemptCount: row.attemptCount + 1,
                    delaySeconds: backoff(row.attemptCount)
                )
            }
        }

        // Every claimed wire event must receive a result; missing → retry.
        for eventId in wireEventIds where !handled.contains(eventId) {
            if let row = byId[eventId] {
                try store.scheduleRetry(
                    eventId: row.eventId,
                    attemptCount: row.attemptCount + 1,
                    delaySeconds: backoff(row.attemptCount)
                )
            }
        }

        try store.deleteEvents(eventIds: deleteIds)
    }

    /// Plan: permanent rejection of a session-tagged event aborts the server session
    /// and marks local group error; retain the event for diagnosis.
    private func abortSessionTaggedEvent(
        row: HealthKitOutboxStore.OutboxEvent,
        config: HealthKitOutboxStore.ConfigurationRow,
        baseURL: String,
        token: String,
        errorCode: String
    ) async throws {
        guard let sessionId = row.sessionId else { return }
        try store.setGroupStatus(groupKey: row.groupKey, status: "error", lastErrorCode: errorCode)
        try store.updateBackfillSessionStatus(sessionId: sessionId, status: "aborted")
        // Atomically retire all local events for this dead session; keep one redacted diagnostic row.
        try store.retireSessionEvents(sessionId: sessionId, keepEventId: row.eventId, errorCode: errorCode)

        do {
            _ = try await api.abortHealthKitBackfillSession(
                baseURL: baseURL,
                accessToken: token,
                sessionId: sessionId,
                installationId: config.installationId,
                personId: config.personId,
                timezoneVersion: config.timezoneVersion,
                reason: errorCode
            )
        } catch {
            #if DEBUG
            print("FamilyOS abort session failed: \(error)")
            #endif
        }
    }

    private func handleTransportError(
        _ error: HealthAPIError,
        events: [HealthKitOutboxStore.OutboxEvent],
        baseURL: String,
        accessTokenProvider: @escaping @Sendable () async -> String?
    ) async throws {
        switch error {
        case let .badStatus(status, _, code):
            if status == 401 {
                _ = await singleFlightToken(accessTokenProvider)
                for row in events {
                    try store.scheduleRetry(eventId: row.eventId, attemptCount: row.attemptCount, delaySeconds: 1)
                }
                return
            }
            if code == "installation_inactive" || (status == 403 && (code?.contains("installation") == true)) {
                for row in events {
                    try store.scheduleRetry(eventId: row.eventId, attemptCount: row.attemptCount + 1, delaySeconds: 3600)
                }
                return
            }
            let delay = backoff(events.first?.attemptCount ?? 0)
            for row in events {
                try store.scheduleRetry(eventId: row.eventId, attemptCount: row.attemptCount + 1, delaySeconds: delay)
            }
        default:
            let delay = backoff(events.first?.attemptCount ?? 0)
            for row in events {
                try store.scheduleRetry(eventId: row.eventId, attemptCount: row.attemptCount + 1, delaySeconds: delay)
            }
        }
    }

    private func singleFlightToken(_ provider: @escaping @Sendable () async -> String?) async -> String? {
        if let existing = authRefreshInFlight {
            return await existing.value
        }
        let task = Task { @Sendable in
            await provider()
        }
        authRefreshInFlight = task
        let value = await task.value
        authRefreshInFlight = nil
        return value
    }

    private func backoff(_ attempt: Int) -> TimeInterval {
        let base = min(pow(2.0, Double(attempt)), 300)
        let jitter = Double.random(in: 0...(base * 0.2))
        return base + jitter
    }
}

// MARK: - Payload DTO for local JSON storage

struct HealthKitEventPayloadDTO: Codable {
    var kind: String
    var hourStartUtc: String?
    var count: Int?
    var sleepDay: String?
    var totalMinutes: Int?
    var coreMinutes: Int?
    var deepMinutes: Int?
    var remMinutes: Int?
    var unspecifiedAsleepMinutes: Int?
    var awakeMinutes: Int?
    var inBedMinutes: Int?
    var wristTemperatureCelsius: Double?
    var breathingDisturbanceCount: Int?
    var healthMetric: String?
    var localDay: String?
    var sumValue: Double?
    var averageValue: Double?
    var minimumValue: Double?
    var maximumValue: Double?
    var latestValue: Double?
    var sampleCount: Int?
    var sourceSampleKey: String?
    var sourceObjectKey: String?
    var measuredAtUtc: String?
    var systolic: Int?
    var diastolic: Int?
    var pulse: Int?
    var valueMgDl: Double?
    var workoutType: String?
    var startedAtUtc: String?
    var endedAtUtc: String?
    var durationSeconds: Int?
    var activeEnergyKcal: Double?
    var distanceMeters: Double?
    var averageHeartRateBpm: Double?
    var maximumHeartRateBpm: Double?

    func asPayload() -> HealthKitEventPayload? {
        switch kind {
        case "steps_hour":
            guard let hourStartUtc, let count else { return nil }
            return .stepsHour(hourStartUtc: hourStartUtc, count: count)
        case "sleep_day":
            guard let sleepDay, let totalMinutes, let coreMinutes, let deepMinutes, let remMinutes,
                  let unspecifiedAsleepMinutes, let awakeMinutes, let inBedMinutes else { return nil }
            return .sleepDay(
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
        case "daily_metric":
            guard let healthMetric, let metric = HealthKitDataMetric(rawValue: healthMetric),
                  let localDay, let sampleCount else { return nil }
            return .dailyMetric(
                healthMetric: metric,
                localDay: localDay,
                sumValue: sumValue,
                averageValue: averageValue,
                minimumValue: minimumValue,
                maximumValue: maximumValue,
                latestValue: latestValue,
                sampleCount: sampleCount
            )
        case "blood_pressure":
            guard let sourceObjectKey, let measuredAtUtc, let systolic, let diastolic else { return nil }
            return .bloodPressure(
                sourceObjectKey: sourceObjectKey,
                measuredAtUtc: measuredAtUtc,
                systolic: systolic,
                diastolic: diastolic,
                pulse: pulse
            )
        case "blood_glucose":
            guard let sourceSampleKey, let measuredAtUtc, let valueMgDl else { return nil }
            return .bloodGlucose(sourceSampleKey: sourceSampleKey, measuredAtUtc: measuredAtUtc, valueMgDl: valueMgDl)
        case "workout":
            guard let sourceSampleKey, let workoutType, let startedAtUtc, let endedAtUtc, let durationSeconds else { return nil }
            return .workout(
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
        default:
            return nil
        }
    }
}

enum HealthKitScopeManifest {
    static let us = "\u{001f}"
    static let prefix = "familyos.healthkit.scope"

    static func hash(sessionId: String, scopeKey: String, eventIds: [String]) -> String {
        let ids = Array(Set(eventIds.map { $0.lowercased() })).sorted()
        let parts = [prefix, sessionId.lowercased(), scopeKey.precomposedStringWithCanonicalMapping, String(ids.count)] + ids
        let joined = parts.joined(separator: us)
        let digest = SHA256.hash(data: Data(joined.utf8))
        return digest.map { String(format: "%02x", $0) }.joined()
    }
}
