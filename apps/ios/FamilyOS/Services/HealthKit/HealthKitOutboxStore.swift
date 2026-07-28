import Foundation
import GRDB
import UserNotifications

enum HealthKitSyncOrigin: String, Sendable, CaseIterable, Equatable {
    case manual
    case appLaunch = "app_launch"
    case healthKitObserver = "healthkit_observer"
    case backgroundTask = "background_task"
}

enum HealthKitSyncTracePhase: String, Sendable, Equatable {
    case started
    case queued
    case apiAcknowledged = "api_acknowledged"
    case retryScheduled = "retry_scheduled"
    case failed
}

/// Durable local SQLite outbox for HealthKit sync.
/// All sync-path writes throw on failure. DB uses complete-until-first-auth protection
/// and is excluded from iCloud backup.
final class HealthKitOutboxStore: Sendable {
    static let shared = HealthKitOutboxStore()

    private let dbQueue: DatabaseQueue

    struct Diagnostics: Sendable, Equatable {
        struct SyncTraceEntry: Identifiable, Sendable, Equatable {
            let id: Int
            let timestamp: Date
            let origin: HealthKitSyncOrigin
            let phase: HealthKitSyncTracePhase
            let eventCount: Int
        }

        struct BackfillProgress: Identifiable, Sendable, Equatable {
            var id: String { sessionId }
            let sessionId: String
            let groupKey: String
            let expectedEventCount: Int
            let acknowledgedEventCount: Int
            let pendingEventCount: Int
            let inFlightEventCount: Int
            let failedEventCount: Int
        }

        let pendingEventCount: Int
        let inFlightEventCount: Int
        let failedEventCount: Int
        let backfills: [BackfillProgress]
        let recentTraceEntries: [SyncTraceEntry]

        static let empty = Diagnostics(
            pendingEventCount: 0,
            inFlightEventCount: 0,
            failedEventCount: 0,
            backfills: [],
            recentTraceEntries: []
        )
    }

    init(directoryURL: URL? = nil) {
        let fm = FileManager.default
        let base = directoryURL ?? fm.urls(for: .applicationSupportDirectory, in: .userDomainMask).first!
        let dir = base.appendingPathComponent("HealthKitOutbox", isDirectory: true)
        try? fm.createDirectory(at: dir, withIntermediateDirectories: true)
        var values = URLResourceValues()
        values.isExcludedFromBackup = true
        var mutableDir = dir
        try? mutableDir.setResourceValues(values)

        let dbURL = dir.appendingPathComponent("outbox.sqlite")
        var config = Configuration()
        config.prepareDatabase { db in
            try db.execute(sql: "PRAGMA foreign_keys = ON")
        }
        dbQueue = try! DatabaseQueue(path: dbURL.path, configuration: config)
        try! dbQueue.write { db in
            try db.execute(sql: """
                CREATE TABLE IF NOT EXISTS outbox_events (
                  event_id TEXT PRIMARY KEY,
                  entity_key TEXT NOT NULL,
                  entity_version INTEGER NOT NULL,
                  group_key TEXT NOT NULL,
                  scope_key TEXT NOT NULL,
                  op TEXT NOT NULL,
                  session_id TEXT,
                  payload_json BLOB,
                  status TEXT NOT NULL DEFAULT 'pending',
                  attempt_count INTEGER NOT NULL DEFAULT 0,
                  next_attempt_at REAL NOT NULL DEFAULT 0,
                  created_at REAL NOT NULL,
                  updated_at REAL NOT NULL
                );
                CREATE INDEX IF NOT EXISTS outbox_drain ON outbox_events(status, next_attempt_at);

                CREATE TABLE IF NOT EXISTS dirty_buckets (
                  entity_key TEXT PRIMARY KEY,
                  group_key TEXT NOT NULL,
                  scope_key TEXT NOT NULL,
                  bucket_json BLOB NOT NULL,
                  allows_delete INTEGER NOT NULL DEFAULT 0,
                  dirty_generation INTEGER NOT NULL DEFAULT 1,
                  created_at REAL NOT NULL,
                  updated_at REAL NOT NULL
                );

                CREATE TABLE IF NOT EXISTS entity_versions (
                  entity_key TEXT PRIMARY KEY,
                  latest_version INTEGER NOT NULL
                );

                CREATE TABLE IF NOT EXISTS sync_cursors (
                  cursor_key TEXT PRIMARY KEY,
                  anchor BLOB,
                  updated_at REAL NOT NULL
                );

                CREATE TABLE IF NOT EXISTS sync_configuration (
                  id INTEGER PRIMARY KEY CHECK (id = 1),
                  user_id TEXT NOT NULL,
                  person_id TEXT NOT NULL,
                  installation_id TEXT NOT NULL,
                  health_timezone TEXT NOT NULL,
                  timezone_version INTEGER NOT NULL,
                  enabled_groups_json BLOB NOT NULL,
                  updated_at REAL NOT NULL
                );

                CREATE TABLE IF NOT EXISTS group_state (
                  group_key TEXT PRIMARY KEY,
                  status TEXT NOT NULL,
                  last_error_code TEXT,
                  last_success_at REAL
                );

                CREATE TABLE IF NOT EXISTS backfill_sessions (
                  session_id TEXT PRIMARY KEY,
                  group_key TEXT NOT NULL,
                  range_start REAL NOT NULL,
                  range_end REAL NOT NULL,
                  status TEXT NOT NULL
                );

                CREATE TABLE IF NOT EXISTS backfill_scope_manifests (
                  session_id TEXT NOT NULL,
                  scope_key TEXT NOT NULL,
                  event_count INTEGER NOT NULL,
                  manifest_hash TEXT NOT NULL,
                  event_ids_json TEXT,
                  status TEXT NOT NULL DEFAULT 'pending',
                  PRIMARY KEY (session_id, scope_key)
                );

                CREATE TABLE IF NOT EXISTS failed_events (
                  event_id TEXT PRIMARY KEY,
                  entity_key TEXT NOT NULL,
                  group_key TEXT NOT NULL,
                  error_code TEXT NOT NULL,
                  session_id TEXT,
                  failed_at REAL NOT NULL
                );

                CREATE TABLE IF NOT EXISTS sync_trace (
                  trace_id INTEGER PRIMARY KEY AUTOINCREMENT,
                  timestamp REAL NOT NULL,
                  origin TEXT NOT NULL CHECK (origin IN ('manual', 'app_launch', 'healthkit_observer', 'background_task')),
                  phase TEXT NOT NULL CHECK (phase IN ('started', 'queued', 'api_acknowledged', 'retry_scheduled', 'failed')),
                  event_count INTEGER NOT NULL
                );
                CREATE INDEX IF NOT EXISTS sync_trace_recent ON sync_trace(trace_id DESC);
                """)
            // Best-effort migrate older outbox DBs that predate newer columns.
            try? db.execute(sql: "ALTER TABLE backfill_scope_manifests ADD COLUMN event_ids_json TEXT")
            try? db.execute(sql: "ALTER TABLE failed_events ADD COLUMN session_id TEXT")
        }

        // File protection after create.
        try? (dbURL as NSURL).setResourceValue(
            URLFileProtection.completeUntilFirstUserAuthentication,
            forKey: .fileProtectionKey
        )
    }

    // MARK: - Redacted sync trace

    func recordSyncTrace(
        origin: HealthKitSyncOrigin,
        phase: HealthKitSyncTracePhase,
        eventCount: Int,
        timestamp: Date = Date()
    ) throws {
        try dbQueue.write { db in
            try db.execute(
                sql: "INSERT INTO sync_trace (timestamp, origin, phase, event_count) VALUES (?, ?, ?, ?)",
                arguments: [timestamp.timeIntervalSince1970, origin.rawValue, phase.rawValue, eventCount]
            )
            try db.execute(sql: "DELETE FROM sync_trace WHERE trace_id NOT IN (SELECT trace_id FROM sync_trace ORDER BY trace_id DESC LIMIT 30)")
        }
    }

    // MARK: - Configuration

    struct ConfigurationRow: Codable, FetchableRecord, PersistableRecord {
        static let databaseTableName = "sync_configuration"
        var id: Int = 1
        var userId: String
        var personId: String
        var installationId: String
        var healthTimezone: String
        var timezoneVersion: Int
        var enabledGroupsJson: Data
        var updatedAt: Double

        enum CodingKeys: String, CodingKey {
            case id
            case userId = "user_id"
            case personId = "person_id"
            case installationId = "installation_id"
            case healthTimezone = "health_timezone"
            case timezoneVersion = "timezone_version"
            case enabledGroupsJson = "enabled_groups_json"
            case updatedAt = "updated_at"
        }
    }

    func saveConfiguration(
        userId: String,
        personId: String,
        installationId: String,
        healthTimezone: String,
        timezoneVersion: Int,
        enabledGroups: [String]
    ) throws {
        let groupsData = try JSONEncoder().encode(enabledGroups)
        let now = Date().timeIntervalSince1970
        try dbQueue.write { db in
            try db.execute(
                sql: """
                INSERT INTO sync_configuration (
                  id, user_id, person_id, installation_id, health_timezone,
                  timezone_version, enabled_groups_json, updated_at
                ) VALUES (1, ?, ?, ?, ?, ?, ?, ?)
                ON CONFLICT(id) DO UPDATE SET
                  user_id = excluded.user_id,
                  person_id = excluded.person_id,
                  installation_id = excluded.installation_id,
                  health_timezone = excluded.health_timezone,
                  timezone_version = excluded.timezone_version,
                  enabled_groups_json = excluded.enabled_groups_json,
                  updated_at = excluded.updated_at
                """,
                arguments: [
                    userId, personId, installationId, healthTimezone,
                    timezoneVersion, groupsData, now
                ]
            )
        }
    }

    func loadConfiguration() throws -> ConfigurationRow? {
        try dbQueue.read { db in
            try ConfigurationRow.fetchOne(db, sql: "SELECT * FROM sync_configuration WHERE id = 1")
        }
    }

    // MARK: - Entity versions

    func nextEntityVersion(entityKey: String) throws -> Int {
        try dbQueue.write { db in
            let current = try Int.fetchOne(
                db,
                sql: "SELECT latest_version FROM entity_versions WHERE entity_key = ?",
                arguments: [entityKey]
            ) ?? 0
            let next = current + 1
            try db.execute(
                sql: """
                INSERT INTO entity_versions (entity_key, latest_version) VALUES (?, ?)
                ON CONFLICT(entity_key) DO UPDATE SET latest_version = excluded.latest_version
                """,
                arguments: [entityKey, next]
            )
            return next
        }
    }

    // MARK: - Outbox events

    struct OutboxEvent: Codable, FetchableRecord, PersistableRecord, Sendable {
        static let databaseTableName = "outbox_events"
        var eventId: String
        var entityKey: String
        var entityVersion: Int
        var groupKey: String
        var scopeKey: String
        var op: String
        var sessionId: String?
        var payloadJson: Data?
        var status: String
        var attemptCount: Int
        var nextAttemptAt: Double
        var createdAt: Double
        var updatedAt: Double

        enum CodingKeys: String, CodingKey {
            case eventId = "event_id"
            case entityKey = "entity_key"
            case entityVersion = "entity_version"
            case groupKey = "group_key"
            case scopeKey = "scope_key"
            case op
            case sessionId = "session_id"
            case payloadJson = "payload_json"
            case status
            case attemptCount = "attempt_count"
            case nextAttemptAt = "next_attempt_at"
            case createdAt = "created_at"
            case updatedAt = "updated_at"
        }
    }

    /// Insert an immutable event; for session-less work, compact older pending rows for the same entity.
    func enqueueEvent(
        eventId: String = UUID().uuidString.lowercased(),
        entityKey: String,
        entityVersion: Int,
        groupKey: String,
        scopeKey: String,
        op: String,
        sessionId: String?,
        payloadJson: Data?
    ) throws {
        let now = Date().timeIntervalSince1970
        try dbQueue.write { db in
            if sessionId == nil {
                try db.execute(
                    sql: """
                    DELETE FROM outbox_events
                    WHERE entity_key = ? AND status = 'pending' AND session_id IS NULL
                    """,
                    arguments: [entityKey]
                )
            }
            try db.execute(
                sql: """
                INSERT INTO outbox_events (
                  event_id, entity_key, entity_version, group_key, scope_key, op,
                  session_id, payload_json, status, attempt_count, next_attempt_at,
                  created_at, updated_at
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'pending', 0, 0, ?, ?)
                """,
                arguments: [
                    eventId, entityKey, entityVersion, groupKey, scopeKey, op,
                    sessionId, payloadJson, now, now
                ]
            )
        }
    }

    func resetInFlightToPending() throws {
        try dbQueue.write { db in
            // A terminal session is never valid for another upload. Its replacement
            // session re-materializes the same coverage, so stale rows must not
            // block the outbox with a server-side session_expired response.
            try db.execute(sql: """
                DELETE FROM outbox_events
                WHERE session_id IN (
                  SELECT session_id FROM backfill_sessions WHERE status != 'open'
                )
                """)
            try db.execute(sql: "UPDATE outbox_events SET status = 'pending', updated_at = ? WHERE status = 'in_flight'", arguments: [Date().timeIntervalSince1970])
        }
    }

    func claimPendingEvents(limit: Int = 100) throws -> [OutboxEvent] {
        let now = Date().timeIntervalSince1970
        return try dbQueue.write { db in
            let rows = try OutboxEvent.fetchAll(
                db,
                sql: """
                SELECT * FROM outbox_events
                WHERE status = 'pending' AND next_attempt_at <= ?
                ORDER BY created_at ASC
                LIMIT ?
                """,
                arguments: [now, limit]
            )
            for row in rows {
                try db.execute(
                    sql: "UPDATE outbox_events SET status = 'in_flight', updated_at = ? WHERE event_id = ?",
                    arguments: [now, row.eventId]
                )
            }
            return rows
        }
    }

    func deleteEvents(eventIds: [String]) throws {
        guard !eventIds.isEmpty else { return }
        try dbQueue.write { db in
            for id in eventIds {
                try db.execute(sql: "DELETE FROM outbox_events WHERE event_id = ?", arguments: [id])
            }
        }
    }

    func failPermanent(eventId: String, entityKey: String, groupKey: String, errorCode: String, sessionId: String? = nil) throws {
        let now = Date().timeIntervalSince1970
        try dbQueue.write { db in
            try db.execute(
                sql: """
                INSERT OR REPLACE INTO failed_events (event_id, entity_key, group_key, error_code, session_id, failed_at)
                VALUES (?, ?, ?, ?, ?, ?)
                """,
                arguments: [eventId, entityKey, groupKey, errorCode, sessionId, now]
            )
            try db.execute(sql: "DELETE FROM outbox_events WHERE event_id = ?", arguments: [eventId])
        }
    }

    func clearFailedEvents(groupKey: String) throws {
        try dbQueue.write { db in
            try db.execute(sql: "DELETE FROM failed_events WHERE group_key = ?", arguments: [groupKey])
        }
    }

    func scheduleRetry(eventId: String, attemptCount: Int, delaySeconds: TimeInterval) throws {
        let now = Date().timeIntervalSince1970
        try dbQueue.write { db in
            try db.execute(
                sql: """
                UPDATE outbox_events
                SET status = 'pending', attempt_count = ?, next_attempt_at = ?, updated_at = ?
                WHERE event_id = ?
                """,
                arguments: [attemptCount, now + delaySeconds, now, eventId]
            )
        }
    }

    func pendingCount() throws -> Int {
        try dbQueue.read { db in
            try Int.fetchOne(db, sql: "SELECT COUNT(*) FROM outbox_events WHERE status IN ('pending', 'in_flight')") ?? 0
        }
    }

    func pendingCount(sessionId: String) throws -> Int {
        try dbQueue.read { db in
            try Int.fetchOne(
                db,
                sql: "SELECT COUNT(*) FROM outbox_events WHERE session_id = ? AND status IN ('pending', 'in_flight')",
                arguments: [sessionId]
            ) ?? 0
        }
    }

    /// Redacted operational state for the temporary in-app sync activity panel.
    func diagnostics() throws -> Diagnostics {
        try dbQueue.read { db in
            let pending = try Int.fetchOne(
                db,
                sql: "SELECT COUNT(*) FROM outbox_events WHERE status = 'pending'"
            ) ?? 0
            let inFlight = try Int.fetchOne(
                db,
                sql: "SELECT COUNT(*) FROM outbox_events WHERE status = 'in_flight'"
            ) ?? 0
            let failed = try Int.fetchOne(
                db,
                sql: """
                SELECT COUNT(*)
                FROM failed_events AS failures
                WHERE failures.error_code NOT LIKE '%_session_mate'
                  AND (
                    failures.session_id IS NULL
                    OR EXISTS (
                      SELECT 1
                      FROM backfill_sessions AS sessions
                      WHERE sessions.session_id = failures.session_id
                        AND sessions.status = 'open'
                    )
                  )
                """
            ) ?? 0
            let rows = try Row.fetchAll(
                db,
                sql: """
                SELECT
                  sessions.session_id,
                  sessions.group_key,
                  COALESCE(SUM(CASE WHEN events.status = 'pending' THEN 1 ELSE 0 END), 0) AS pending_count,
                  COALESCE(SUM(CASE WHEN events.status = 'in_flight' THEN 1 ELSE 0 END), 0) AS in_flight_count,
                  COALESCE((
                    SELECT SUM(manifests.event_count)
                    FROM backfill_scope_manifests AS manifests
                    WHERE manifests.session_id = sessions.session_id
                  ), 0) AS expected_count,
                  COALESCE((
                    SELECT COUNT(*)
                    FROM failed_events AS failures
                    WHERE failures.session_id = sessions.session_id
                      AND failures.error_code NOT LIKE '%_session_mate'
                  ), 0) AS failed_count
                FROM backfill_sessions AS sessions
                LEFT JOIN outbox_events AS events ON events.session_id = sessions.session_id
                WHERE sessions.status = 'open'
                GROUP BY sessions.session_id, sessions.group_key
                ORDER BY sessions.group_key
                """
            )
            let backfills = rows.map { row in
                let expected = row["expected_count"] as Int
                let pendingCount = row["pending_count"] as Int
                let inFlightCount = row["in_flight_count"] as Int
                let failedCount = row["failed_count"] as Int
                return Diagnostics.BackfillProgress(
                    sessionId: row["session_id"],
                    groupKey: row["group_key"],
                    expectedEventCount: expected,
                    acknowledgedEventCount: max(0, expected - pendingCount - inFlightCount - failedCount),
                    pendingEventCount: pendingCount,
                    inFlightEventCount: inFlightCount,
                    failedEventCount: failedCount
                )
            }
            let traceRows = try Row.fetchAll(
                db,
                sql: "SELECT trace_id, timestamp, origin, phase, event_count FROM sync_trace ORDER BY trace_id DESC LIMIT 30"
            )
            let trace = traceRows.compactMap { row -> Diagnostics.SyncTraceEntry? in
                guard let origin = HealthKitSyncOrigin(rawValue: row["origin"]),
                      let phase = HealthKitSyncTracePhase(rawValue: row["phase"])
                else { return nil }
                return Diagnostics.SyncTraceEntry(
                    id: row["trace_id"],
                    timestamp: Date(timeIntervalSince1970: row["timestamp"]),
                    origin: origin,
                    phase: phase,
                    eventCount: row["event_count"]
                )
            }
            return Diagnostics(
                pendingEventCount: pending,
                inFlightEventCount: inFlight,
                failedEventCount: failed,
                backfills: backfills,
                recentTraceEntries: trace
            )
        }
    }

    func nextRetryDate() throws -> Date? {
        try dbQueue.read { db in
            guard let ts = try Double.fetchOne(
                db,
                sql: "SELECT MIN(next_attempt_at) FROM outbox_events WHERE status = 'pending' AND next_attempt_at > 0"
            ) else { return nil }
            return Date(timeIntervalSince1970: ts)
        }
    }

    // MARK: - Dirty buckets

    struct DirtyBucket: Codable, FetchableRecord, Sendable {
        static let databaseTableName = "dirty_buckets"
        var entityKey: String
        var groupKey: String
        var scopeKey: String
        var bucketJson: Data
        var allowsDelete: Int
        var dirtyGeneration: Int
        var createdAt: Double
        var updatedAt: Double

        enum CodingKeys: String, CodingKey {
            case entityKey = "entity_key"
            case groupKey = "group_key"
            case scopeKey = "scope_key"
            case bucketJson = "bucket_json"
            case allowsDelete = "allows_delete"
            case dirtyGeneration = "dirty_generation"
            case createdAt = "created_at"
            case updatedAt = "updated_at"
        }

        var allowsDeleteFlag: Bool { allowsDelete != 0 }
    }

    struct BucketDescriptor: Codable, Sendable {
        var kind: String
        var hourStartUtc: String?
        var localDay: String?
        var healthMetric: String?
    }

    func markDirtyBucket(
        entityKey: String,
        groupKey: String,
        scopeKey: String,
        bucketJson: Data,
        allowsDelete: Bool
    ) throws {
        let now = Date().timeIntervalSince1970
        try dbQueue.write { db in
            try db.execute(
                sql: """
                INSERT INTO dirty_buckets (
                  entity_key, group_key, scope_key, bucket_json, allows_delete,
                  dirty_generation, created_at, updated_at
                ) VALUES (?, ?, ?, ?, ?, 1, ?, ?)
                ON CONFLICT(entity_key) DO UPDATE SET
                  bucket_json = excluded.bucket_json,
                  allows_delete = CASE
                    WHEN dirty_buckets.allows_delete = 1 OR excluded.allows_delete = 1 THEN 1
                    ELSE 0
                  END,
                  dirty_generation = dirty_buckets.dirty_generation + 1,
                  updated_at = excluded.updated_at
                """,
                arguments: [entityKey, groupKey, scopeKey, bucketJson, allowsDelete ? 1 : 0, now, now]
            )
        }
    }

    func claimDirtyBuckets(limit: Int = 50) throws -> [DirtyBucket] {
        try dbQueue.read { db in
            try DirtyBucket.fetchAll(
                db,
                sql: "SELECT * FROM dirty_buckets ORDER BY updated_at ASC LIMIT ?",
                arguments: [limit]
            )
        }
    }

    /// Clear a dirty row only if generation is unchanged (no newer HealthKit change during recompute).
    func clearDirtyBucket(entityKey: String, expectedGeneration: Int) throws -> Bool {
        try dbQueue.write { db in
            try db.execute(
                sql: "DELETE FROM dirty_buckets WHERE entity_key = ? AND dirty_generation = ?",
                arguments: [entityKey, expectedGeneration]
            )
            return db.changesCount > 0
        }
    }

    /**
     Atomically:
     1. verify dirty generation is unchanged
     2. advance entity version
     3. insert immutable outbox event(s)
     4. delete the dirty row
     If generation advanced during recompute, returns false and writes nothing.
     */
    func materializeDirtyBucketAtomically(
        entityKey: String,
        expectedGeneration: Int,
        events: [(
            eventId: String,
            entityKey: String,
            entityVersion: Int?,
            groupKey: String,
            scopeKey: String,
            op: String,
            sessionId: String?,
            payloadJson: Data?
        )]
    ) throws -> Bool {
        let now = Date().timeIntervalSince1970
        return try dbQueue.write { db in
            let currentGen = try Int.fetchOne(
                db,
                sql: "SELECT dirty_generation FROM dirty_buckets WHERE entity_key = ?",
                arguments: [entityKey]
            )
            guard currentGen == expectedGeneration else { return false }

            for event in events {
                var version = event.entityVersion
                if version == nil {
                    let current = try Int.fetchOne(
                        db,
                        sql: "SELECT latest_version FROM entity_versions WHERE entity_key = ?",
                        arguments: [event.entityKey]
                    ) ?? 0
                    version = current + 1
                    try db.execute(
                        sql: """
                        INSERT INTO entity_versions (entity_key, latest_version) VALUES (?, ?)
                        ON CONFLICT(entity_key) DO UPDATE SET latest_version = excluded.latest_version
                        """,
                        arguments: [event.entityKey, version!]
                    )
                }
                if event.sessionId == nil {
                    try db.execute(
                        sql: """
                        DELETE FROM outbox_events
                        WHERE entity_key = ? AND status = 'pending' AND session_id IS NULL
                        """,
                        arguments: [event.entityKey]
                    )
                }
                try db.execute(
                    sql: """
                    INSERT INTO outbox_events (
                      event_id, entity_key, entity_version, group_key, scope_key, op,
                      session_id, payload_json, status, attempt_count, next_attempt_at,
                      created_at, updated_at
                    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'pending', 0, 0, ?, ?)
                    """,
                    arguments: [
                        event.eventId, event.entityKey, version!, event.groupKey, event.scopeKey, event.op,
                        event.sessionId, event.payloadJson, now, now
                    ]
                )
            }

            try db.execute(
                sql: "DELETE FROM dirty_buckets WHERE entity_key = ? AND dirty_generation = ?",
                arguments: [entityKey, expectedGeneration]
            )
            return db.changesCount > 0
        }
    }

    /// Retire all local events for a dead sessionId into failed_events (metadata only, no payloads).
    /// The rejected diagnostic row is also moved to failed_events so it cannot re-enter the drain loop.
    func retireSessionEvents(sessionId: String, keepEventId: String?, errorCode: String) throws {
        let now = Date().timeIntervalSince1970
        try dbQueue.write { db in
            let rows = try OutboxEvent.fetchAll(
                db,
                sql: "SELECT * FROM outbox_events WHERE session_id = ?",
                arguments: [sessionId]
            )
            for row in rows {
                let code = (keepEventId == row.eventId) ? errorCode : "\(errorCode)_session_mate"
                try db.execute(
                    sql: """
                    INSERT OR REPLACE INTO failed_events (event_id, entity_key, group_key, error_code, session_id, failed_at)
                    VALUES (?, ?, ?, ?, ?, ?)
                    """,
                    arguments: [row.eventId, row.entityKey, row.groupKey, code, sessionId, now]
                )
                try db.execute(sql: "DELETE FROM outbox_events WHERE event_id = ?", arguments: [row.eventId])
            }
        }
    }

    func dirtyBucketCount() throws -> Int {
        try dbQueue.read { db in
            try Int.fetchOne(db, sql: "SELECT COUNT(*) FROM dirty_buckets") ?? 0
        }
    }

    /// True when the outbox has work that is not due yet (future retry).
    func hasFutureRetries() throws -> Bool {
        let now = Date().timeIntervalSince1970
        return try dbQueue.read { db in
            let count = try Int.fetchOne(
                db,
                sql: "SELECT COUNT(*) FROM outbox_events WHERE status = 'pending' AND next_attempt_at > ?",
                arguments: [now]
            ) ?? 0
            return count > 0
        }
    }

    func openBackfillSession(groupKey: String) throws -> (sessionId: String, status: String)? {
        try dbQueue.read { db in
            guard let row = try Row.fetchOne(
                db,
                sql: "SELECT session_id, status FROM backfill_sessions WHERE group_key = ? AND status = 'open' ORDER BY range_end DESC LIMIT 1",
                arguments: [groupKey]
            ) else { return nil }
            return (row["session_id"], row["status"])
        }
    }

    func updateBackfillSessionStatus(sessionId: String, status: String) throws {
        try dbQueue.write { db in
            try db.execute(
                sql: "UPDATE backfill_sessions SET status = ? WHERE session_id = ?",
                arguments: [status, sessionId]
            )
        }
    }

    /// Returns true only for the first transition from an open session to an
    /// aborted session. This gates the corresponding remote abort request.
    func abortBackfillSessionIfOpen(sessionId: String) throws -> Bool {
        try dbQueue.write { db in
            try db.execute(
                sql: "UPDATE backfill_sessions SET status = 'aborted' WHERE session_id = ? AND status = 'open'",
                arguments: [sessionId]
            )
            return db.changesCount > 0
        }
    }

    /// Replacing a backfill session makes its local events and manifests obsolete.
    /// The API expires the old server session when it creates the replacement.
    func discardOpenBackfillSessions(groupKey: String) throws {
        try dbQueue.write { db in
            let sessionIds = try String.fetchAll(
                db,
                sql: "SELECT session_id FROM backfill_sessions WHERE group_key = ? AND status = 'open'",
                arguments: [groupKey]
            )
            guard !sessionIds.isEmpty else { return }
            try db.execute(
                sql: "UPDATE backfill_sessions SET status = 'aborted' WHERE group_key = ? AND status = 'open'",
                arguments: [groupKey]
            )
            for sessionId in sessionIds {
                try db.execute(sql: "DELETE FROM outbox_events WHERE session_id = ?", arguments: [sessionId])
                try db.execute(sql: "DELETE FROM backfill_scope_manifests WHERE session_id = ?", arguments: [sessionId])
            }
        }
    }

    /// Drops a session the server has declared terminal and returns its group so
    /// the caller can schedule a clean replacement backfill.
    func discardBackfillSession(sessionId: String) throws -> String? {
        try dbQueue.write { db in
            let groupKey = try String.fetchOne(
                db,
                sql: "SELECT group_key FROM backfill_sessions WHERE session_id = ?",
                arguments: [sessionId]
            )
            try db.execute(
                sql: "UPDATE backfill_sessions SET status = 'aborted' WHERE session_id = ? AND status = 'open'",
                arguments: [sessionId]
            )
            try db.execute(sql: "DELETE FROM outbox_events WHERE session_id = ?", arguments: [sessionId])
            try db.execute(sql: "DELETE FROM backfill_scope_manifests WHERE session_id = ?", arguments: [sessionId])
            return groupKey
        }
    }

    func eventIdsForSessionScope(sessionId: String, scopeKey: String) throws -> [String] {
        try dbQueue.read { db in
            try String.fetchAll(
                db,
                sql: """
                SELECT event_id FROM outbox_events
                WHERE session_id = ? AND scope_key = ?
                ORDER BY event_id ASC
                """,
                arguments: [sessionId, scopeKey]
            )
        }
    }

    // MARK: - Cursors

    func loadCursor(key: String) throws -> Data? {
        try dbQueue.read { db in
            try Data.fetchOne(db, sql: "SELECT anchor FROM sync_cursors WHERE cursor_key = ?", arguments: [key])
        }
    }

    func saveCursor(key: String, anchor: Data?) throws {
        let now = Date().timeIntervalSince1970
        try dbQueue.write { db in
            try db.execute(
                sql: """
                INSERT INTO sync_cursors (cursor_key, anchor, updated_at) VALUES (?, ?, ?)
                ON CONFLICT(cursor_key) DO UPDATE SET anchor = excluded.anchor, updated_at = excluded.updated_at
                """,
                arguments: [key, anchor, now]
            )
        }
    }

    // MARK: - Group state

    func setGroupStatus(groupKey: String, status: String, lastErrorCode: String? = nil) throws {
        try dbQueue.write { db in
            let successAt: Double? = status == "ready" ? Date().timeIntervalSince1970 : nil
            try db.execute(
                sql: """
                INSERT INTO group_state (group_key, status, last_error_code, last_success_at)
                VALUES (?, ?, ?, ?)
                ON CONFLICT(group_key) DO UPDATE SET
                  status = excluded.status,
                  last_error_code = excluded.last_error_code,
                  last_success_at = COALESCE(excluded.last_success_at, group_state.last_success_at)
                """,
                arguments: [groupKey, status, lastErrorCode, successAt]
            )
        }
    }

    func groupStatus(groupKey: String) throws -> String? {
        try dbQueue.read { db in
            try String.fetchOne(db, sql: "SELECT status FROM group_state WHERE group_key = ?", arguments: [groupKey])
        }
    }

    // MARK: - Backfill sessions

    func saveBackfillSession(sessionId: String, groupKey: String, rangeStart: Date, rangeEnd: Date, status: String) throws {
        try dbQueue.write { db in
            try db.execute(
                sql: """
                INSERT OR REPLACE INTO backfill_sessions (session_id, group_key, range_start, range_end, status)
                VALUES (?, ?, ?, ?, ?)
                """,
                arguments: [sessionId, groupKey, rangeStart.timeIntervalSince1970, rangeEnd.timeIntervalSince1970, status]
            )
        }
    }

    func saveScopeManifest(sessionId: String, scopeKey: String, eventCount: Int, manifestHash: String, eventIds: [String] = []) throws {
        let idsJSON = (try? JSONEncoder().encode(eventIds)).flatMap { String(data: $0, encoding: .utf8) } ?? "[]"
        try dbQueue.write { db in
            try db.execute(
                sql: """
                INSERT OR REPLACE INTO backfill_scope_manifests (
                  session_id, scope_key, event_count, manifest_hash, event_ids_json, status
                ) VALUES (?, ?, ?, ?, ?, 'pending')
                """,
                arguments: [sessionId, scopeKey, eventCount, manifestHash, idsJSON]
            )
        }
    }

    func pendingScopeManifests(sessionId: String) throws -> [(scopeKey: String, eventCount: Int, manifestHash: String, eventIds: [String])] {
        try dbQueue.read { db in
            let rows = try Row.fetchAll(
                db,
                sql: "SELECT scope_key, event_count, manifest_hash, event_ids_json FROM backfill_scope_manifests WHERE session_id = ?",
                arguments: [sessionId]
            )
            return rows.map { row in
                let idsJSON: String = row["event_ids_json"] ?? "[]"
                let ids = (try? JSONDecoder().decode([String].self, from: Data(idsJSON.utf8))) ?? []
                return (row["scope_key"], row["event_count"], row["manifest_hash"], ids)
            }
        }
    }

    func allScopeManifests(sessionId: String) throws -> [(scopeKey: String, eventCount: Int, manifestHash: String, eventIds: [String])] {
        try pendingScopeManifests(sessionId: sessionId)
    }

    func markScopeManifestUploaded(sessionId: String, scopeKey: String) throws {
        try dbQueue.write { db in
            try db.execute(
                sql: "UPDATE backfill_scope_manifests SET status = 'uploaded' WHERE session_id = ? AND scope_key = ?",
                arguments: [sessionId, scopeKey]
            )
        }
    }
}

struct HealthKitBackgroundSyncAlertThrottle {
    static let interval: TimeInterval = 15 * 60

    static func consumeIfAllowed(defaults: UserDefaults, now: Date = Date()) -> Bool {
        let last = defaults.double(forKey: HealthKitBackgroundSyncAlerts.lastAlertDateKey)
        guard last == 0 || now.timeIntervalSince1970 - last >= interval else { return false }
        defaults.set(now.timeIntervalSince1970, forKey: HealthKitBackgroundSyncAlerts.lastAlertDateKey)
        return true
    }
}

enum HealthKitBackgroundSyncAlerts {
    static let enabledKey = "familyOS.healthKit.backgroundSyncAlertsEnabled"
    static let lastAlertDateKey = "familyOS.healthKit.lastBackgroundSyncAlertAt"

    static func isEnabled(defaults: UserDefaults = .standard) -> Bool {
        defaults.bool(forKey: enabledKey)
    }

    static func setEnabled(_ enabled: Bool, defaults: UserDefaults = .standard) async -> Bool {
        guard enabled else {
            defaults.set(false, forKey: enabledKey)
            return false
        }

        let granted = (try? await UNUserNotificationCenter.current().requestAuthorization(options: [.alert, .sound])) ?? false
        defaults.set(granted, forKey: enabledKey)
        return granted
    }

    static func notifyAfterAcknowledgement(
        origin: HealthKitSyncOrigin,
        eventCount: Int,
        defaults: UserDefaults = .standard
    ) {
        guard eventCount > 0,
              origin == .healthKitObserver || origin == .backgroundTask,
              isEnabled(defaults: defaults),
              HealthKitBackgroundSyncAlertThrottle.consumeIfAllowed(defaults: defaults)
        else { return }

        let content = UNMutableNotificationContent()
        content.title = "Health sync complete"
        content.body = "Background HealthKit updates were synced."
        content.sound = .default
        let request = UNNotificationRequest(
            identifier: "familyOS.healthKit.backgroundSync",
            content: content,
            trigger: nil
        )
        UNUserNotificationCenter.current().add(request) { _ in }
    }
}

extension HealthKitSyncOrigin {
    var displayName: String {
        switch self {
        case .manual: return "Manual"
        case .appLaunch: return "App launch"
        case .healthKitObserver: return "HealthKit"
        case .backgroundTask: return "Background task"
        }
    }
}

extension HealthKitSyncTracePhase {
    var displayName: String {
        switch self {
        case .started: return "Started"
        case .queued: return "Queued"
        case .apiAcknowledged: return "Acknowledged"
        case .retryScheduled: return "Retry scheduled"
        case .failed: return "Failed"
        }
    }
}
