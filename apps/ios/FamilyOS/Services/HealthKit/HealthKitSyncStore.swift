import Foundation
import GRDB

/// Single SQLite control plane for HealthKit sync (plan §5.4).
/// Not MainActor — safe for foreground worker / future BG drain.
///
/// Production code must use ``shared`` so foreground import, background drain,
/// and config persistence share one `DatabaseQueue`. Opening multiple queues on
/// the same file races commits and surfaces SQLite error 5 (database is locked).
final class HealthKitSyncStore: @unchecked Sendable {
    private let dbQueue: DatabaseQueue

    private static let sharedLock = NSLock()
    /// Guarded by ``sharedLock``.
    nonisolated(unsafe) private static var sharedInstance: HealthKitSyncStore?

    /// Process-wide store for Application Support `HealthKitSync/sync.sqlite`.
    static var shared: HealthKitSyncStore {
        get throws {
            sharedLock.lock()
            defer { sharedLock.unlock() }
            if let sharedInstance {
                return sharedInstance
            }
            let created = try HealthKitSyncStore(fileURL: defaultStoreURL())
            sharedInstance = created
            return created
        }
    }

    /// Test / explicit-path opener. Never registers as ``shared``.
    convenience init(path: String) throws {
        try self.init(fileURL: URL(fileURLWithPath: path))
    }

    private static func defaultStoreURL() throws -> URL {
        let base = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask).first!
        let dir = base.appendingPathComponent("HealthKitSync", isDirectory: true)
        try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        let fileURL = dir.appendingPathComponent("sync.sqlite")
        try? FileManager.default.setAttributes(
            [.protectionKey: FileProtectionType.completeUntilFirstUserAuthentication],
            ofItemAtPath: fileURL.path
        )
        var values = URLResourceValues()
        values.isExcludedFromBackup = true
        var mutable = fileURL
        try? mutable.setResourceValues(values)
        return fileURL
    }

    private init(fileURL: URL) throws {
        var config = Configuration()
        // Wait out short writer races instead of failing with SQLITE_BUSY.
        config.busyMode = .timeout(5)
        config.prepareDatabase { db in
            try db.execute(sql: "PRAGMA foreign_keys = ON")
            // Concurrent readers while a writer holds a transaction (import + drain).
            try db.execute(sql: "PRAGMA journal_mode = WAL")
        }
        do {
            dbQueue = try DatabaseQueue(path: fileURL.path, configuration: config)
            try migrator.migrate(dbQueue)
            try resetInFlightToPending()
            CrashReporting.log("healthkit_store_opened path=\(fileURL.lastPathComponent)")
        } catch {
            CrashReporting.healthKitNonFatal(
                .storeOpenFailed,
                stage: .storeOpenFailed,
                message: "healthkit_sync_store_init_failed",
                underlying: error
            )
            throw error
        }
    }

    private var migrator: DatabaseMigrator {
        var migrator = DatabaseMigrator()
        migrator.registerMigration("v1_pending_ops") { db in
            try db.execute(sql: """
                CREATE TABLE sync_configuration (
                  id INTEGER PRIMARY KEY CHECK (id = 1),
                  user_id TEXT NOT NULL,
                  person_id TEXT NOT NULL,
                  installation_id TEXT NOT NULL,
                  health_timezone TEXT NOT NULL,
                  timezone_version INTEGER NOT NULL,
                  enabled_groups_json TEXT NOT NULL,
                  updated_at REAL NOT NULL
                );

                CREATE TABLE group_state (
                  group_key TEXT PRIMARY KEY,
                  status TEXT NOT NULL,
                  coverage_start REAL,
                  coverage_end REAL,
                  last_error_code TEXT,
                  last_success_at REAL
                );

                CREATE TABLE pending_ops (
                  op_id TEXT PRIMARY KEY,
                  natural_key TEXT NOT NULL,
                  group_key TEXT NOT NULL,
                  scope_key TEXT NOT NULL,
                  op TEXT NOT NULL,
                  payload_json BLOB,
                  status TEXT NOT NULL,
                  attempt_count INTEGER NOT NULL DEFAULT 0,
                  next_attempt_at REAL NOT NULL DEFAULT 0,
                  created_at REAL NOT NULL,
                  updated_at REAL NOT NULL
                );
                CREATE INDEX pending_ops_drain ON pending_ops(status, next_attempt_at);
                CREATE INDEX pending_ops_natural ON pending_ops(natural_key, status);
                """)
        }
        migrator.registerMigration("v2_group_server_state") { db in
            // Server-reported per-group state so background runs honor the
            // initial-import gate without a settings round-trip (plan §6.6).
            try db.execute(sql: """
                ALTER TABLE group_state ADD COLUMN needs_initial_import INTEGER NOT NULL DEFAULT 1;
                ALTER TABLE group_state ADD COLUMN server_status TEXT;
                """)
        }
        return migrator
    }

    func saveConfiguration(
        userId: String,
        personId: String,
        installationId: String,
        healthTimezone: String,
        timezoneVersion: Int,
        enabledGroups: [String]
    ) throws {
        let now = Date().timeIntervalSince1970
        let groupsJSON = try JSONEncoder().encode(enabledGroups)
        let groupsString = String(data: groupsJSON, encoding: .utf8) ?? "[]"
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
                    timezoneVersion, groupsString, now
                ]
            )
        }
    }

    func configuration() throws -> SyncConfigurationRow? {
        try dbQueue.read { db in
            try Row.fetchOne(db, sql: "SELECT * FROM sync_configuration WHERE id = 1").map { row in
                SyncConfigurationRow(
                    userId: row["user_id"],
                    personId: row["person_id"],
                    installationId: row["installation_id"],
                    healthTimezone: row["health_timezone"],
                    timezoneVersion: row["timezone_version"],
                    enabledGroupsJSON: row["enabled_groups_json"]
                )
            }
        }
    }

    func setGroupStatus(_ group: String, status: String) throws {
        try dbQueue.write { db in
            try db.execute(
                sql: """
                    INSERT INTO group_state (group_key, status, last_success_at)
                    VALUES (?, ?, NULL)
                    ON CONFLICT(group_key) DO UPDATE SET status = excluded.status
                    """,
                arguments: [group, status]
            )
        }
    }

    func groupStatus(_ group: String) throws -> String? {
        try dbQueue.read { db in
            try String.fetchOne(db, sql: "SELECT status FROM group_state WHERE group_key = ?", arguments: [group])
        }
    }

    // MARK: - Server group state (canonical enabled/import-completion cache)

    /// Persist the server-reported per-group state after a settings load/save.
    /// Rows for groups absent from `states` are left untouched.
    func applyServerGroupStates(_ states: [ServerGroupStateInput]) throws {
        try dbQueue.write { db in
            for state in states {
                try db.execute(
                    sql: """
                        INSERT INTO group_state (
                          group_key, status, server_status, needs_initial_import,
                          coverage_start, coverage_end, last_success_at
                        ) VALUES (?, ?, ?, ?, ?, ?, ?)
                        ON CONFLICT(group_key) DO UPDATE SET
                          server_status = excluded.server_status,
                          needs_initial_import = excluded.needs_initial_import,
                          coverage_start = excluded.coverage_start,
                          coverage_end = excluded.coverage_end,
                          last_success_at = excluded.last_success_at
                        """,
                    arguments: [
                        state.groupKey,
                        state.serverStatus,
                        state.serverStatus,
                        state.needsInitialImport ? 1 : 0,
                        state.coverageStartAt,
                        state.coverageEndAt,
                        state.lastSuccessfulAt
                    ]
                )
            }
        }
    }

    /// Groups the server says still need Import history (background must skip them).
    func groupsNeedingInitialImport() throws -> Set<String> {
        try dbQueue.read { db in
            let rows = try Row.fetchAll(
                db,
                sql: "SELECT group_key FROM group_state WHERE needs_initial_import = 1"
            )
            return Set(rows.map { $0["group_key"] as String })
        }
    }

    /// Record a locally completed run (diagnostics; server state stays authoritative).
    func recordLocalRunSuccess(group: String, at date: Date) throws {
        try dbQueue.write { db in
            try db.execute(
                sql: """
                    INSERT INTO group_state (group_key, status, last_success_at)
                    VALUES (?, 'ready', ?)
                    ON CONFLICT(group_key) DO UPDATE SET
                      status = 'ready', last_success_at = excluded.last_success_at
                    """,
                arguments: [group, date.timeIntervalSince1970]
            )
        }
    }

    /// Enqueue upsert/delete. Coalesces pending ops for the same natural key.
    func enqueue(op: PendingOpRecord) throws {
        try enqueue(ops: [op])
    }

    /// Batch enqueue in one write transaction (sleep/workout 90-day imports).
    func enqueue(ops: [PendingOpRecord]) throws {
        guard !ops.isEmpty else { return }
        let now = Date().timeIntervalSince1970
        try dbQueue.write { db in
            for op in ops {
                try db.execute(
                    sql: "DELETE FROM pending_ops WHERE natural_key = ? AND status = 'pending'",
                    arguments: [op.naturalKey]
                )
                try db.execute(
                    sql: """
                        INSERT INTO pending_ops (
                          op_id, natural_key, group_key, scope_key, op, payload_json,
                          status, attempt_count, next_attempt_at, created_at, updated_at
                        ) VALUES (?, ?, ?, ?, ?, ?, 'pending', 0, 0, ?, ?)
                        """,
                    arguments: [
                        op.opId, op.naturalKey, op.groupKey, op.scopeKey, op.op,
                        op.payloadJSON.map { Data($0.utf8) }, now, now
                    ]
                )
            }
        }
    }

    func pendingCount(group: String? = nil) throws -> Int {
        try dbQueue.read { db in
            if let group {
                return try Int.fetchOne(
                    db,
                    sql: "SELECT COUNT(*) FROM pending_ops WHERE group_key = ?",
                    arguments: [group]
                ) ?? 0
            }
            return try Int.fetchOne(db, sql: "SELECT COUNT(*) FROM pending_ops") ?? 0
        }
    }

    /// Claim up to `limit` pending ops for upload (serialized drain).
    func claimBatch(limit: Int = 50) throws -> [PendingOpRecord] {
        let now = Date().timeIntervalSince1970
        return try dbQueue.write { db in
            let rows = try Row.fetchAll(
                db,
                sql: """
                    SELECT * FROM pending_ops
                    WHERE status = 'pending' AND next_attempt_at <= ?
                    ORDER BY created_at ASC
                    LIMIT ?
                    """,
                arguments: [now, limit]
            )
            var claimed: [PendingOpRecord] = []
            for row in rows {
                let opId: String = row["op_id"]
                try db.execute(
                    sql: """
                        UPDATE pending_ops
                        SET status = 'in_flight', attempt_count = attempt_count + 1, updated_at = ?
                        WHERE op_id = ? AND status = 'pending'
                        """,
                    arguments: [now, opId]
                )
                claimed.append(PendingOpRecord(row: row))
            }
            return claimed
        }
    }

    func markApplied(opIds: [String]) throws {
        guard !opIds.isEmpty else { return }
        try dbQueue.write { db in
            for id in opIds {
                try db.execute(sql: "DELETE FROM pending_ops WHERE op_id = ?", arguments: [id])
            }
        }
    }

    func markBackoff(opIds: [String], delaySeconds: TimeInterval) throws {
        let next = Date().timeIntervalSince1970 + delaySeconds
        let now = Date().timeIntervalSince1970
        try dbQueue.write { db in
            for id in opIds {
                try db.execute(
                    sql: """
                        UPDATE pending_ops
                        SET status = 'pending', next_attempt_at = ?, updated_at = ?
                        WHERE op_id = ?
                        """,
                    arguments: [next, now, id]
                )
            }
        }
    }

    func markRejected(opId: String, errorCode: String) throws {
        let now = Date().timeIntervalSince1970
        try dbQueue.write { db in
            // Lookup group before delete so sleep/vitals rejections surface correctly.
            let groupKey = try String.fetchOne(
                db,
                sql: "SELECT group_key FROM pending_ops WHERE op_id = ?",
                arguments: [opId]
            ) ?? "vitals"
            try db.execute(sql: "DELETE FROM pending_ops WHERE op_id = ?", arguments: [opId])
            try db.execute(
                sql: """
                    INSERT INTO group_state (group_key, status, last_error_code)
                    VALUES (?, 'error', ?)
                    ON CONFLICT(group_key) DO UPDATE SET
                      status = 'error', last_error_code = excluded.last_error_code
                    """,
                arguments: [groupKey, errorCode]
            )
            _ = now
        }
    }

    private func resetInFlightToPending() throws {
        let now = Date().timeIntervalSince1970
        try dbQueue.write { db in
            try db.execute(
                sql: """
                    UPDATE pending_ops
                    SET status = 'pending', updated_at = ?
                    WHERE status = 'in_flight'
                    """,
                arguments: [now]
            )
        }
    }
}

struct SyncConfigurationRow: Sendable {
    let userId: String
    let personId: String
    let installationId: String
    let healthTimezone: String
    let timezoneVersion: Int
    let enabledGroupsJSON: String
}

/// Server-reported group state persisted into the local store (plan §6.6).
struct ServerGroupStateInput: Sendable {
    let groupKey: String
    let serverStatus: String
    let needsInitialImport: Bool
    let coverageStartAt: Double?
    let coverageEndAt: Double?
    let lastSuccessfulAt: Double?

    init(
        groupKey: String,
        serverStatus: String,
        needsInitialImport: Bool,
        coverageStartAt: Double? = nil,
        coverageEndAt: Double? = nil,
        lastSuccessfulAt: Double? = nil
    ) {
        self.groupKey = groupKey
        self.serverStatus = serverStatus
        self.needsInitialImport = needsInitialImport
        self.coverageStartAt = coverageStartAt
        self.coverageEndAt = coverageEndAt
        self.lastSuccessfulAt = lastSuccessfulAt
    }
}

struct PendingOpRecord: Sendable {
    let opId: String
    let naturalKey: String
    let groupKey: String
    let scopeKey: String
    let op: String
    let payloadJSON: String?

    init(opId: String, naturalKey: String, groupKey: String, scopeKey: String, op: String, payloadJSON: String?) {
        self.opId = opId
        self.naturalKey = naturalKey
        self.groupKey = groupKey
        self.scopeKey = scopeKey
        self.op = op
        self.payloadJSON = payloadJSON
    }

    init(row: Row) {
        opId = row["op_id"]
        naturalKey = row["natural_key"]
        groupKey = row["group_key"]
        scopeKey = row["scope_key"]
        op = row["op"]
        if let data = row["payload_json"] as Data? {
            payloadJSON = String(data: data, encoding: .utf8)
        } else {
            payloadJSON = nil
        }
    }
}
