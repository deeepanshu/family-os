# HealthKit Sync Implementation Plan

Status: implemented (server + iOS outbox path); remaining: dirty-bucket materialization polish, retention job, TestFlight soak

## Goal

HealthKit is only a data source. The app writes normalized health changes to a durable
local outbox, and a generic worker syncs that outbox to Family OS Postgres.

```text
HealthKit adapter -> SQLite outbox -> serialized sync worker -> API -> Postgres
```

The current repair protocol, ledgers, repair IDs, chunk indexes, and UserDefaults sync
state are removed. There is no compatibility path because this has not launched.

## Rules

1. The app has one sync coordinator and one worker. Foreground, observer, and BGTask
   work only enqueue or nudge it.
2. Every network event is immutable: permanent UUID, entity key, entity version,
   operation, and fixed payload.
3. Entity versions increase per `(installationId, entityKey)`. A new installation starts
   at version 1; version rows survive deletes so a re-add always gets a higher version.
4. The server applies only the newest version for an entity within an installation.
   Older events are acknowledged as `superseded`.
5. Source-keyed records use direct `upsert`/`delete` events. Bucketed records use a
   local dirty-bucket row, then materialize into an immutable `upsert` or `delete`
   event before upload.
6. Acknowledged events are deleted locally. Failed permanent events retain metadata,
   not health payloads.
7. Incomplete backfills never mark coverage ready or delete stale data.
8. Empty HealthKit reads never imply deletion during incremental sync. Incremental
   bucket deletes require an observed HealthKit deletion for that bucket. A backfill
   emits empty-bucket deletes as harmless coverage markers.

## Local SQLite Store

Use GRDB. All sync-path writes throw on failure. The database uses
`NSFileProtectionCompleteUntilFirstUserAuthentication` and is excluded from iCloud
backup.

```sql
CREATE TABLE outbox_events (
  event_id TEXT PRIMARY KEY,
  entity_key TEXT NOT NULL,
  entity_version INTEGER NOT NULL,
  group_key TEXT NOT NULL,
  scope_key TEXT NOT NULL,
  op TEXT NOT NULL,                    -- upsert | delete
  session_id TEXT,
  payload_json BLOB,                   -- NULL only for delete
  status TEXT NOT NULL DEFAULT 'pending', -- pending | in_flight
  attempt_count INTEGER NOT NULL DEFAULT 0,
  next_attempt_at REAL NOT NULL DEFAULT 0,
  created_at REAL NOT NULL,
  updated_at REAL NOT NULL
);
CREATE INDEX outbox_drain ON outbox_events(status, next_attempt_at);

CREATE TABLE dirty_buckets (
  entity_key TEXT PRIMARY KEY,
  group_key TEXT NOT NULL,
  scope_key TEXT NOT NULL,
  bucket_json BLOB NOT NULL,
  allows_delete INTEGER NOT NULL DEFAULT 0, -- set only by an observed HK deletion
  dirty_generation INTEGER NOT NULL DEFAULT 1,
  created_at REAL NOT NULL,
  updated_at REAL NOT NULL
);

CREATE TABLE entity_versions (
  entity_key TEXT PRIMARY KEY,
  latest_version INTEGER NOT NULL
);

CREATE TABLE sync_cursors (
  cursor_key TEXT PRIMARY KEY,
  anchor BLOB,
  updated_at REAL NOT NULL
);

CREATE TABLE sync_configuration (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  user_id TEXT NOT NULL,
  person_id TEXT NOT NULL,
  installation_id TEXT NOT NULL,
  health_timezone TEXT NOT NULL,
  timezone_version INTEGER NOT NULL,
  enabled_groups_json BLOB NOT NULL,
  updated_at REAL NOT NULL
);

CREATE TABLE group_state (
  group_key TEXT PRIMARY KEY,
  status TEXT NOT NULL,              -- never_synced | ready | backfilling | error | disabled
  last_error_code TEXT,
  last_success_at REAL
);

CREATE TABLE backfill_sessions (
  session_id TEXT PRIMARY KEY,
  group_key TEXT NOT NULL,
  range_start REAL NOT NULL,
  range_end REAL NOT NULL,
  status TEXT NOT NULL
);

CREATE TABLE backfill_scope_manifests (
  session_id TEXT NOT NULL,
  scope_key TEXT NOT NULL,
  event_count INTEGER NOT NULL,
  manifest_hash TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  PRIMARY KEY (session_id, scope_key)
);

CREATE TABLE failed_events (
  event_id TEXT PRIMARY KEY,
  entity_key TEXT NOT NULL,
  group_key TEXT NOT NULL,
  error_code TEXT NOT NULL,
  failed_at REAL NOT NULL
);
```

Normal source changes write an immutable outbox event and advance the HealthKit cursor
in one SQLite transaction. Bucketed changes coalesce a dirty row and advance the cursor
in one transaction.

The worker claims a dirty bucket, recomputes it from HealthKit, then creates an immutable
event only if the row's `dirty_generation` is unchanged. If a newer HealthKit change
incremented that generation during recompute, the dirty row remains for another pass.

For an incremental dirty bucket, an empty recompute becomes a delete only when
`allows_delete = 1`; otherwise the worker clears the dirty row without emitting an
event. Coalescing an observed HealthKit deletion sets `allows_delete = 1` permanently
on that dirty row.

For normal, session-less work, a new event may remove older `pending` events for the
same entity. Never compact `in_flight` or backfill-session events.

## API

Base path: `/health/api/v1/healthkit`.

| Endpoint | Purpose |
|---|---|
| `POST /events:batch` | Apply up to 500 immutable events. |
| `POST /sessions` | Create a 90-day backfill session for one group. |
| `PUT /sessions/:id/scopes/:scopeKey/manifest` | Prove one source scope was scanned. |
| `POST /sessions/:id/complete` | Mark the group ready after all scope manifests validate. |
| `POST /sessions/:id/abort` | Abort a session. |
| `GET /sessions/:id` | Return status and `pendingCount`. |
| `GET /sessions/:id/pending?cursor=&limit=100` | Paginated diagnostics only. |
| `GET /groups/:group/manifest` | Reconciliation backstop. |
| `GET/PUT /settings` | Consent, groups, timezone, active installation. |

Every request includes `installationId`, `personId`, and `timezoneVersion`.

```jsonc
{
  "eventId": "uuid",
  "entityKey": "steps_hour:2026-07-25T14:00:00Z",
  "entityVersion": 7,
  "group": "activity",
  "scopeKey": "steps",
  "op": "upsert | delete",
  "sessionId": "uuid | null",
  "payload": {}
}
```

The API validates the payload, then computes its own immutable fingerprint using the
shared, append-only `canonicalHealthEvent` serializer. The client never supplies the
fingerprint. A reused event ID or entity version with a different fingerprint is an
`event_conflict`.

## Server Storage and Apply Rules

Migration: `0009_healthkit_sync_rewrite.sql`.

- Delete current HealthKit-imported data and current repair state.
- Drop `healthkit_repairs`, `healthkit_repair_chunks`, and `healthkit_sync_receipts`.
- Keep the canonical tables: `health_step_hours`, `health_daily_metrics`,
  `health_sleep_days`, `health_blood_pressure_readings`,
  `health_blood_glucose_readings`, `health_workouts`, HealthKit settings,
  installations, and `healthkit_sync_state`. Replace `repairing` with
  `backfilling` in sync-state transitions.
- Create:
  - `healthkit_sync_events`: event ID dedup, session/scope, server fingerprint, and
    `apply_result` (`applied` or `superseded`).
  - `healthkit_sync_entities`: latest fingerprint/version keyed by
    `(person_id, installation_id, entity_key)`.
  - `healthkit_backfill_sessions` and `healthkit_backfill_scope_manifests`.

`events:batch` uses one outer transaction with a savepoint per event:

1. Existing event ID with the same fingerprint returns `duplicate`.
2. Existing event ID with a different fingerprint returns `event_conflict`.
3. A lower entity version is stored as received and returns `superseded`.
4. The same entity version requires the same fingerprint or returns `event_conflict`.
5. A higher entity version updates the canonical health row and entity-version row in
   the same transaction.

Events can arrive out of order. The entity-version rule prevents stale writes from
overwriting newer data. Installation fencing guarantees only one active writer for a
person; a new device has its own version stream and can apply a fresh backfill.

Event dedup rows may be purged after 30 days only when no active session references
them. Entity-version rows make an old replay harmless. Retain or purge entity-version
rows together with their canonical records; `health_step_hours` and its version rows
have the same growth profile.

Keep the existing server validation and add: sleep-stage coherence, workout start/end
and heart-rate ordering, statistics min/average/max ordering, systolic greater than
diastolic, a date sanity window, and non-empty batches.

## Backfill

A backfill is a 90-day snapshot for one group.

1. Create a server session. It freezes range and required scope keys.
2. Scan every scope in the range.
3. Materialize every source and bucket result into immutable events tagged with the
   session, including deletes for empty bucketed records.
4. In the same SQLite transaction, store the scope manifest.
5. Drain events, then upload each scope manifest.
6. Complete the session.

A permanent rejection (`payload_invalid` or `event_conflict`) for a session-tagged
event aborts the session and marks its group `error`. The client must not remove that
event from the manifest or rewrite the manifest to hide it. After the defect is fixed,
start a new session and re-scan the group.

The manifest is a proof of received event IDs, not payload JSON:

```text
SHA-256(UTF-8(
  "familyos.healthkit.scope" + US + sessionId + US + scopeKey + US +
  eventCountDecimal + US + join(US, sortedEventIds)
))
```

`US` is byte `0x1f`; UUIDs are lowercase canonical ASCII; `scopeKey` is NFC UTF-8;
the count is ASCII decimal with no leading zeros; IDs are distinct and sorted by ASCII
bytes. The server computes the same digest from all received event IDs for that session
and scope, including superseded events. A session completes only after every frozen
scope manifest validates.

HealthKit changes during backfill generate normal, session-less events. Their later
entity versions prevent the backfill snapshot from overwriting them.

## Worker and Errors

The worker is one app-wide actor. On launch, reset `in_flight` rows to `pending`.

| Result | Action |
|---|---|
| `applied`, `duplicate`, `superseded` | Delete local event. |
| `payload_invalid`, `event_conflict` (normal event) | Move metadata to `failed_events`; delete payload. |
| `payload_invalid`, `event_conflict` (session-tagged event) | Abort the session and mark its group `error`; retain the event locally for diagnosis. Start a new session only after the defect is fixed. |
| `consent_withdrawn`, `group_disabled` | Stop the group and observers. |
| `installation_inactive` | Halt sync; require explicit replacement. |
| `timezone_stale` | Refresh settings, mark affected buckets for a new backfill. |
| `session_expired` | Create a new session. |
| `session_incomplete` | Drain pending events, then retry complete. |
| `401` | Single-flight token refresh once, then retry once. |
| Network, `5xx`, `429` | Keep events and use exponential backoff with jitter. |

For a session-tagged permanent rejection, replace the normal failed-event action with
`abort_session`: preserve redacted diagnostics, abort the server session, mark local
`group_state` as `error`, and require a new full session after the cause is resolved.
If a scope-manifest upload returns `incomplete`, abort that session and start a new
session; never rewrite a manifest to exclude missing events.

Schedule a BG task only when the outbox is non-empty and the next retry is in the
future. Do not schedule retries after successful observer work.

## HealthKit Adapter Rules

- Anchored query additions create source events or dirty buckets.
- Anchored query deletions create source deletes or dirty buckets.
- Do not use a UUID ledger.
- Do not infer deletion from an empty query.
- Use `Calendar.date(byAdding: .day)` in the health timezone for all day boundaries.
- The adapter and worker never advance a cursor after a failed SQLite transaction.

## Acceptance Tests

Before TestFlight, prove all of these against local Postgres and a fake HealthKit source:

- Kill after local transaction, before upload.
- Kill after upload reaches server, before response reaches phone.
- Duplicate and concurrent delivery of the same batch.
- Older event after a newer event.
- Retry after event-dedup retention expires.
- New installation/reinstall full backfill.
- Corrupted cursor and corrupted local database.
- Timezone change mid-backfill.
- DST spring-forward and fall-back days.
- HealthKit changes during backfill.
- Empty incremental bucket recompute with and without an observed deletion.
- Permanent rejection and scope-manifest-incomplete session recovery.
- Permission revoked, consent withdrawn, installation replaced, 401 refresh, 429, 5xx,
  and network loss.

Success means every retry path converges to the same Postgres state as one uninterrupted
sync, and incomplete backfills never become `ready`.

## Implementation Order

1. Shared event schemas, error actions, canonical server fingerprint fixtures.
2. Postgres migration and API batch/session implementation.
3. GRDB store, HealthKit adapter, and unit tests.
4. Worker, auth serialization, coordinator, and integration tests.
5. Reconciliation, retention job, TestFlight soak.
