# HealthKit (iOS)

**Status: correctness-first rewrite — milestone 2 (BP + sleep day, FG + shared BG pipeline).**

Source of truth: `docs/HEALTHKIT_CORRECTNESS_FIRST_SYNC_PLAN.md`

## Architecture (boring on purpose)

```
HealthKit samples (BP correlations / sleepAnalysis)
  → natural-key ops (blood_pressure:<uuid> | sleep_day:YYYY-MM-DD)
  → SQLite pending_ops
  → HealthKitSyncWorker POST /healthkit/ops:batch
  → Postgres UPSERT by natural key
  → POST /groups/{vitals|sleep}/ready
```

Shared orchestration: `HealthKitSyncCoordinator` (start-import → auth → fetch+enqueue → drain → ready).

Background: `HealthKitBackgroundSync` (observers + `enableBackgroundDelivery` + BGTask drain/reimport).
**Not** `@MainActor` — registration lives on `NotificationAppDelegate`.

## Components

| File | Role |
|------|------|
| `HealthKitInstallationId.swift` | Keychain installation UUID |
| `HealthKitSyncStore.swift` | Single GRDB DB (`pending_ops`, config, group_state) |
| `HealthKitSyncWorker.swift` | Serialized drain of pending ops only |
| `HealthKitBloodPressureSync.swift` | 90-day BP query + enqueue |
| `HealthKitSleepDaySync.swift` | 90-day sleep day totals + enqueue (Apple-preferred source) |
| `HealthKitSyncCoordinator.swift` | Multi-group FG/BG import+drain+ready |
| `HealthKitBackgroundSync.swift` | BGTask + observers + become-active drain |
| `../Clients/HealthKitClient.swift` | Availability + multi-group authorization |

## Current scope

- Foreground **Sync now** for **vitals (BP)** and **sleep** when enabled
- Shared coordinator for all implemented groups
- Local queue until server ACK
- Idempotent `op_id` + natural-key upsert
- Group ready gate (sleep may ready with 0 days; BP still errors on empty)
- Background delivery + BG processing task (soft-fail; token from Keychain)

## Sleep rules (locked)

- Day totals only: total, core, deep, rem, unspecified, awake, inBed
- `sleepDay` = local calendar day of sample **end** in profile `healthTimezone`
- `totalMinutes` = core+deep+rem+unspecified after single-source selection
- Prefer Apple / Watch source; never sum overlapping apps
- Naps included; no wrist temp / breathing in v1
- Empty full query never deletes history (upsert-only for observed days)

## Explicitly not yet

- Steps, HR-only series, workouts, nutrition as first-class groups
- Entity versions, manifests, dual stores
- Wrist temperature / breathing disturbance fields

## Crashlytics / logging

Pipeline stages and non-fatals go through `CrashReporting.healthKit` /
`healthKitNonFatal` (OSLog always; Firebase collection in **Release** only).

| Stage | When |
|-------|------|
| `sync_started` | Sync now / BG bounded sync begins |
| `import_started` | Server start-import OK |
| `samples_fetched` / `samples_enqueued` | Counts only (no values / days) |
| `drain_batch` / `drain_finished` | Worker upload |
| `group_ready` / `sync_completed` | Success |
| `sync_failed` / `op_rejected` / `store_open_failed` | Non-fatals |

**Never logged:** BP values, sleep minutes detail, sample UUIDs, tokens, free-text notes.

## Crashlytics constraints

- No `@MainActor` BG coordinator (BGTask isolation fatals)
- Fail soft on metric isolation (one group error does not crash the other)
- Narrow implemented metrics only
- DEBUG builds keep Crashlytics collection off (use Console.app / OSLog)

## Deleted (do not resurrect)

- Old engine / outbox / BG coordinator / dual UserDefaults authority
- `events:batch` + session/manifest protocol on iOS
