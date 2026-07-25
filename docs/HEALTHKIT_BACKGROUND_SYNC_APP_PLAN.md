# Family OS iOS Background HealthKit Sync Plan

**Status:** Implementation-ready plan

## 1. Outcome

Make the Family OS iPhone app a low-touch, best-effort HealthKit ingestion companion. After a signed-in user completes setup and explicitly consents, the app receives HealthKit changes, normalizes the supported data on-device, and uploads final Family OS records to the Health API. The API and Family OS MCP are read-only consumers; neither has a HealthKit credential or polls Apple Health.

This is background delivery, not polling or a real-time guarantee. iOS may coalesce or defer delivery. If delivery is missed or the app is force-quit, a foreground repair is the recovery path.

## 2. Locked Product Decisions

### 2.1 Scope and ownership

Background sync supports only the signed-in user's linked Self profile and only these HealthKit metrics:

| Metric | Family OS record | Sync behavior |
| --- | --- | --- |
| Steps | UTC hourly count | Replace affected hour from on-device calculation |
| Sleep | sleep-day duration in minutes | Replace affected day from merged asleep intervals |
| Blood pressure | individual clinical reading | Upsert/delete by HealthKit correlation UUID |

Manual blood-pressure entry is removed. The app does not sync walking distance, weight, glucose, or any other HealthKit type in this phase. A family member cannot upload their HealthKit data to another person's profile.

### 2.2 Clean 90-day cutover

healthkit_samples and its importer are removed. No value from that table is migrated or transformed into a new table. The first successful setup imports only the most recent 90 days directly from HealthKit into the real Family OS tables. New HealthKit changes extend that clean history over time.

The iPhone never uploads a HealthKit export or a generic sample feed. It uploads only final step-hour totals, sleep-day totals, and BP readings. A phone replacement performs a new 90-day repair; it does not copy a previous phone's HealthKit cache.

### 2.3 Time semantics

- Every instant and step-hour key is stored and transmitted in UTC.
- Each profile has a server-owned health_timezone, selected during setup from the device's IANA timezone, for example Asia/Bangkok.
- The selected profile timezone defines sleep-day boundaries and the timezone used to present health-calendar data. The current travel/device timezone must not silently change stored grouping.
- A user can explicitly change the profile timezone. The server creates a new timezone version; the app repairs the latest 90 days under it, and the API retires overlapping values from the previous version before making the new version visible. Earlier historical records retain their original grouping.
- A step-hour is a UTC hour. This avoids duplicate records at DST fall-back.
- A sleep session belongs to the selected profile-local date on which its asleep interval ends. Overlapping asleep stages are merged before calculating minutes.
- BP values come only from a HealthKit blood-pressure correlation containing both systolic and diastolic samples. Pulse is optional.

### 2.4 Privacy, consent, and local ledger

Before enabling sync, the app shows an unticked consent control explaining that the selected HealthKit measurements are uploaded to the user's Family OS account to power health history and MCP access they authorize. Disabling sync withdraws that consent.

The app keeps an encrypted, device-local source ledger for the rolling 90-day window. It maps HealthKit source UUIDs to the canonical records and contribution needed to process an explicit HealthKit deletion. It never leaves the device or appears in logs. It is technical state, not a server sample store, and is cleared on sign-out, consent withdrawal, metric disablement, or expiry.

The app must never infer that HealthKit data was deleted merely because a broad read returns empty: Apple does not disclose read denial. Empty reads therefore do not overwrite a stored step/sleep value with zero and do not delete BP. A zero aggregate is permitted only when the local ledger proves an explicit deletion changed that canonical bucket to zero.

The app never logs or sends export files, device/source metadata, locations, raw sleep stages, notes, local ledger contents, HealthKit UUIDs other than the actual BP record key, anchors, tokens, or request bodies.

## 3. Architecture

~~~
HealthKit observer
        |
HealthKitBackgroundSyncCoordinator
        |
HealthKitSyncEngine ---- HealthKitSyncStateStore
        |                         |
        |                    local anchor, pending work,
        |                    encrypted 90-day source ledger
        |
SessionProvider
        |
Health API: sync and repair endpoints
        |
canonical Family OS health tables
        |
read-only Family OS MCP
~~~

HealthKitSyncEngine is a testable non-UI actor that queries HealthKit, normalizes records, updates the local ledger, uploads batches, and advances an anchor only after the corresponding API acknowledgement.

HealthKitBackgroundSyncCoordinator, retained by NotificationAppDelegate, owns observer registration, completion handlers, serialization, and background retry scheduling. HealthKitSyncStateStore is keyed by user, self profile, and metric. It stores no bearer token. SessionProvider is the sole session reader and refreshes a normal user session once when needed.

## 4. Required API Contract

Implement the companion [API plan](HEALTHKIT_BACKGROUND_SYNC_API_PLAN.md) before enabling background delivery.

### 4.1 Normal sync

POST /health/v1/healthkit/sync

Every request includes a persisted syncId, active installationId, profile timezone version, and at most 500 typed operations. Retrying the same syncId returns the original result without applying the operations again. The server validates the self-profile link, active consent, enabled metric, active installation, and timezone version before writing.

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

blood_pressure_delete is sent only for an explicit anchored HealthKit deletion and hard-deletes the matching HealthKit BP row. Aggregate rows are never deleted directly; an explicit local-ledger correction sends their replacement value.

### 4.2 Minimal 90-day repair

The initial repair and an explicit timezone-change repair use a short-lived repair session:

1. POST /health/v1/healthkit/repairs creates repairId for one metric and a 90-day UTC/profile-timezone window.
2. The app uploads real records through /sync in idempotent chunks of at most 500 operations, each carrying repairId and chunkIndex.
3. POST /health/v1/healthkit/repairs/{repairId}/complete supplies the expected chunk count.
4. The API makes the repaired window available to MCP only after completion.

There are no per-record content hashes, generic staging tables, or raw HealthKit uploads. While repairing, the app resumes the failed chunk; it does not restart or duplicate the repair. An incomplete repair expires and is not reported as available health coverage.

## 5. HealthKit Lifecycle and Incremental Sync

### 5.1 Setup and observer registration

1. Add the HealthKit background-delivery entitlement.
2. In a foreground Profile flow, request read access for step count, sleep analysis, and blood-pressure correlations.
3. Call PUT /health/v1/healthkit/settings to link the user's Self profile, record consent and enabled metrics server-side, activate this installation, and persist the returned configuration.
4. Register one observer per enabled type and request .immediate background delivery.
5. Run the initial 90-day repair.

HealthKit does not reveal whether read permission was denied. The UI says "Health access requested" until a successful sync has returned data or a redacted no-readable-data state; it never claims permission from an empty query.

An installation ID is a random UUID stored in Keychain, not a hardware identifier. Each self profile has exactly one active installation in v1. Activating a replacement phone fences the old phone; its later requests are rejected and the replacement performs a new repair.

### 5.2 Anchored changes

For each metric, persist its secure archived HKQueryAnchor, pending work, repair progress, redacted success/error state, and encrypted 90-day ledger.

For each anchored-query page:

1. Read added and deleted HealthKit objects.
2. Add/update local ledger entries for additions.
3. For explicit deletions, use the ledger to determine and recompute only the affected canonical records.
4. Upload final records in idempotent batches.
5. Persist the candidate anchor and ledger changes only after all associated API batches succeed.

If a deletion lacks a local-ledger entry, retain the current anchor, mark that metric repair_needed, and require a foreground repair. Do not guess from an empty HealthKit query.

Steps use HealthKit statistics to create affected UTC-hour totals. Sleep merges asleep intervals and updates the profile-local ending day. BP additions/upserts and explicit deletions map directly to actual BP readings.

### 5.3 Failure and retry

Observer completion handlers always run promptly. A failed upload never advances an anchor or clears repair progress. The coordinator persists a redacted pendingSync marker, makes a brief bounded retry while awake, and schedules a network-enabled BGProcessingTask. It also retries at the next HealthKit event and next foreground launch.

For persistent failure:

- network/API failures leave existing server records intact and freshness stale;
- expired authentication becomes authentication_required and waits for the user to sign in again;
- invalid configuration, consent, installation, or timezone responses stop blind retrying and refresh setup state; and
- validation failures are logged as redacted diagnostics for repair by a future app version.

## 6. UX

The Profile HealthKit section provides a self-profile link, consent, metric toggles, selected health timezone, per-metric last successful sync, actionable redacted status, and **Sync HealthKit Now**. The timezone change requires an explicit confirmation because it triggers a 90-day repair.

The UI must not promise a polling interval, immediate delivery, or a specific read-permission result. It explains that background delivery is best effort and opening the app resumes pending work.

## 7. Implementation Sequence

1. Remove the raw sample importer and migrate the API to the canonical tables, installation authority, per-metric state, and repair session contract.
2. Replace legacy HealthKit and manual BP data with the clean cutover: delete it, remove manual BP entry, and drop healthkit_samples; do not transform it.
3. Build the iOS sync state store, installation activation, consent flow, and non-UI sync engine with fake HealthKit/API tests.
4. Add the encrypted local ledger, anchored-change processing, chunked repair, and safe anchor advancement.
5. Wire observer lifecycle, background delivery, pending-work retry, and Profile status. Remove the current manual all-metric sync path.
6. Verify on a physical Release iPhone before TestFlight.

## 8. Verification and Completion

Automated and device tests must prove that:

- the first sync imports exactly the recent 90 days and no legacy sample data;
- empty/permission-limited reads never erase prior records;
- explicit additions, corrections, and deletions update only the intended final records;
- interrupted repair resumes its chunk and MCP withholds incomplete coverage;
- duplicate notifications and request retries do not duplicate data;
- each metric reports independent freshness and errors;
- replacing the active phone fences the old installation;
- travel does not create duplicates, and an explicit timezone change retires overlapping prior-version records; and
- logs contain no health values, source ledger contents, UUIDs, anchors, or tokens.

Completion means ordinary changes are ingested when iOS permits delivery, recovery is durable after failure, MCP reads only real Family OS health tables, and no raw HealthKit sample storage exists on the server.
