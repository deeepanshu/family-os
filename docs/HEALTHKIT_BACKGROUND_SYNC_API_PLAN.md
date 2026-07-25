# Family OS HealthKit Background Sync API Plan

**Status:** Implementation-ready plan

## 1. Outcome and Boundary

Provide the one authenticated, idempotent ingestion path for the Family OS iPhone HealthKit companion. The API stores final, metric-specific Family OS records, enforces sync authority, and gives MCP truthful per-metric freshness.

The API is not a HealthKit client. Raspberry Pi services, ChatGPT, and MCP OAuth clients never receive HealthKit credentials and never have a write-capable MCP tool. The only writer is a normal Family OS user session from the active iPhone installation for that person's linked Self profile.

## 2. Locked Storage Model

### 2.1 Clean cutover

healthkit_samples, the legacy raw importer, and all legacy imported HealthKit records are removed. No legacy sample value is copied, transformed, or exposed through MCP. The new tables begin with a clean, direct 90-day import from the iPhone, then accumulate new HealthKit changes over time.

The API does not store a generic sample feed, HealthKit exports, device/source metadata, locations, raw sleep stages, notes, or an on-server source ledger. The only HealthKit source UUID retained is the correlation UUID on the actual blood-pressure record, required to update/delete that clinical reading.

### 2.2 Canonical records

| Metric | Canonical record | Key | Correction behavior |
| --- | --- | --- | --- |
| Steps | UTC hourly count | person, hour_start_utc | Replace from an explicit affected-bucket calculation |
| Sleep | profile-timezone sleep-day duration | person, sleep day, timezone version | Replace from an explicit affected-day calculation |
| Blood pressure | HealthKit clinical reading | person, correlation UUID | Upsert or hard-delete after an explicit HealthKit deletion |

All instants are UTC. Each person has a server-owned health_timezone and monotonic health_timezone_version. It defines sleep-day boundaries and health-calendar presentation. Device travel never changes it automatically.

An explicit timezone change creates a new version and requires a 90-day repair. The API retires overlapping prior-version sleep records before exposing the new version. Earlier history remains in its original grouping, so a timezone change does not create duplicate or double-counted records.

### 2.3 Required tables

~~~
health_step_hours
  person_id, family_id, hour_start_utc, count, created_at, updated_at
  unique (person_id, hour_start_utc)

health_sleep_days
  person_id, family_id, sleep_day, timezone_version, duration_minutes,
  created_at, updated_at
  unique (person_id, sleep_day, timezone_version)

blood_pressure_readings
  person_id, family_id, source_sample_key, measured_at_utc,
  systolic, diastolic, optional pulse, created_at, updated_at
  unique (person_id, source_sample_key)

healthkit_sync_profile_settings
  person_id, consent_version, consented_at, health_timezone,
  health_timezone_version, updated_at
  unique (person_id)

healthkit_sync_metrics
  person_id, metric, enabled, updated_at
  unique (person_id, metric)

health_metric_sync_state
  person_id, metric, last_successful_at, last_attempt_at, last_error_code,
  coverage_start_at, coverage_end_at, status
  unique (person_id, metric)

healthkit_sync_installations
  person_id, installation_id, activated_at, revoked_at
  one active installation per person

healthkit_repairs
  repair_id, person_id, metric, installation_id, timezone_version,
  range_start, range_end, expected_chunk_count, completed_at, expires_at

healthkit_repair_chunks
  repair_id, chunk_index, sync_id, completed_at
  unique (repair_id, chunk_index)
~~~

These are real health records and bounded operational metadata. There is no healthkit_samples replacement table.

## 3. Write Authority

Every HealthKit write is authenticated with the ordinary Family OS bearer token. Before processing any request, the API verifies all of the following:

1. the caller owns the linked active Self profile in the active family;
2. HealthKit upload consent is active for that profile;
3. the requested metric is enabled;
4. the supplied installation is the profile's active installation;
5. the supplied timezone version is current; and
6. if present, the repair belongs to that installation, metric, and range.

The route, repository, and RLS enforce the same self-profile boundary. Direct table writes are not a normal client surface. A stale/revoked phone receives a clear non-retryable error and cannot overwrite newer data.

### 3.1 Settings and installation activation

PUT /health/api/v1/healthkit/settings is the only setup/settings write. It accepts the linked Self profile, explicit consent version, enabled metric set, selected IANA health timezone, and the Keychain installation ID. The server resolves the profile and family from the bearer token, persists the settings, and returns the trusted timezone version and active installation configuration.

Replacing an active installation requires an explicit confirmation flag in this request. The server revokes the previous installation in the same transaction. Disabling a metric or withdrawing consent makes later uploads fail immediately; the iPhone then clears its local anchor and ledger for that metric.

## 4. Sync Contract

### 4.1 Normal upload

POST /health/api/v1/healthkit/sync

The request includes syncId, installationId, personId, timezoneVersion, and no more than 500 final operations. A request is transactional. A unique (user_id, person_id, sync_id) makes it idempotent: replay returns the original redacted result and does not write again.

~~~json
{
  "syncId": "7afbe594-7e1d-4b31-a9a1-420b7fba42a7",
  "installationId": "53064303-35cf-4db0-a5d3-8af7d8f747e1",
  "personId": "b30940b4-dd76-453d-8e00-543d2e15f24e",
  "timezoneVersion": 1,
  "operations": [
    {
      "kind": "steps_hour_upsert",
      "hourStartUtc": "2026-07-25T02:00:00Z",
      "count": 842
    },
    {
      "kind": "sleep_day_upsert",
      "sleepDay": "2026-07-25",
      "durationMinutes": 436
    },
    {
      "kind": "blood_pressure_upsert",
      "sourceSampleKey": "5E1ED621-4A6C-4E09-969E-31C6F0872C24",
      "measuredAtUtc": "2026-07-25T01:10:00Z",
      "systolic": 118,
      "diastolic": 76,
      "pulse": 64
    }
  ]
}
~~~

blood_pressure_delete is valid only for an explicit HealthKit deletion and hard-deletes the matching HealthKit BP row. Aggregate data is never deleted because an API query was empty. The app may submit a zero aggregate only when its local source ledger proves an explicit HealthKit deletion produced that result.

The route validates operation shape, bounds, UUIDs, UTC hour boundaries, timezone version, and clinical values. It rejects unknown fields, service-role credentials, MCP-audience tokens, oversized bodies, and client-supplied family authority.

### 4.2 Minimal chunked repair

The first import and explicit timezone change repair exactly the most recent 90 days. They use a small repair protocol:

1. POST /health/api/v1/healthkit/repairs creates a short-lived repairId for one metric and its 90-day range.
2. /sync accepts chunks of at most 500 final records with repairId and chunkIndex.
3. Replaying a chunk index returns its existing result.
4. POST /health/api/v1/healthkit/repairs/{repairId}/complete provides the expected chunk count.
5. The API marks the requested metric's coverage ready only after every chunk is complete.

Chunks write the real tables directly. There are no raw-sample staging rows or content-hash protocol. While status is repairing, MCP must not present that window as complete. Expired, incomplete repair metadata is cleaned up; it does not create visible health coverage.

## 5. Per-Metric Freshness and MCP

Every accepted or failed attempt updates health_metric_sync_state for only the affected metric. MCP never uses one profile-wide lastSyncedAt.

family_os.get_health_data reads only these real tables:

- healthMetric: "steps": UTC hourly records for short ranges; API aggregation for longer supported ranges;
- healthMetric: "sleep": daily sleep records using their stored timezone version; and
- healthMetric: "blood_pressure": HealthKit-synced BP readings only.

For the requested metric, each result reports available coverage, selected profile health timezone, last successful sync, and a redacted current status. It must not interpret empty data as a permission decision or claim the iPhone is online. MCP never reads legacy tables and has no write/refresh side effect.

## 6. Errors, Privacy, and Rate Limits

Audit events may contain request correlation ID, sync ID, caller ID, metric, operation count, status category, and timestamp. They never contain health values, HealthKit UUIDs, anchors, profile labels, tokens, request bodies, or local-ledger information.

Use stable redacted errors, including:

~~~
healthkit_self_profile_required
healthkit_consent_required
healthkit_metric_disabled
healthkit_installation_inactive
healthkit_timezone_version_invalid
healthkit_repair_invalid
healthkit_repair_incomplete
healthkit_operation_invalid
~~~

Rate-limit by authenticated user/profile and enforce body and 500-operation caps before allocating large payloads. A validation/authority error is non-retryable; network and server failures are retryable by the iPhone's persisted pending-work flow.

## 7. Delivery Sequence

1. Create canonical tables, per-metric state, installation authority, and repair metadata with RLS and repository tests.
2. Implement server-side authority checks and the idempotent sync/repair routes.
3. Migrate MCP reads to the real tables and per-metric freshness.
4. Deploy the compatible API and iOS companion together.
5. After the new companion is ready for clean setup, permanently delete legacy imported health data and all manual BP data, remove their write paths, and drop healthkit_samples without migrating its contents.

## 8. Verification and Completion

Tests must prove that:

- a retry of a syncId or repair chunk is idempotent;
- incomplete repair data is never reported as complete MCP coverage;
- a steps upload cannot make sleep freshness current;
- one active installation fences stale phones;
- invalid consent, metric, timezone, repair, and profile state is rejected on every write;
- HealthKit BP upsert/correction/deletion affects only HealthKit BP records;
- timezone migration cannot create duplicate or double-counted visible rows;
- MCP reads no legacy/sample table; and
- logs, audits, and errors expose no sensitive values or identifiers.

Completion means the API is the only HealthKit-derived MCP data surface, it stores only real Family OS health data plus minimal operational state, and every write is controlled by normal Family OS authorization and explicit consent.
