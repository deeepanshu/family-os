# HealthKit (iOS)

**Status: correctness-first rewrite — milestone 1 (blood pressure, foreground).**

Source of truth: `docs/HEALTHKIT_CORRECTNESS_FIRST_SYNC_PLAN.md`

## Architecture (boring on purpose)

```
HealthKit BP correlations
  → natural-key ops (blood_pressure:<uuid>)
  → SQLite pending_ops
  → HealthKitSyncWorker POST /healthkit/ops:batch
  → Postgres UPSERT by natural key
  → POST /groups/vitals/ready
```

## Components

| File | Role |
|------|------|
| `HealthKitInstallationId.swift` | Keychain installation UUID |
| `HealthKitSyncStore.swift` | Single GRDB DB (`pending_ops`, config, group_state) |
| `HealthKitSyncWorker.swift` | Serialized drain of pending ops only |
| `HealthKitBloodPressureSync.swift` | 90-day BP query + enqueue |
| `../Clients/HealthKitClient.swift` | Availability + authorization |

## Milestone 1 scope

- Foreground **Sync now** for **blood pressure** when vitals is enabled
- Local queue until server ACK
- Idempotent `op_id` + natural-key upsert
- Group ready gate

## Explicitly not in milestone 1

- Background delivery / BGTask
- Steps, sleep, HR, workouts, nutrition
- Entity versions, manifests, dual stores

## Crashlytics / logging

Pipeline stages and non-fatals go through `CrashReporting.healthKit` /
`healthKitNonFatal` (OSLog always; Firebase collection in **Release** only).

| Stage | When |
|-------|------|
| `sync_started` | Sync now begins |
| `import_started` | Server start-import OK |
| `samples_fetched` / `samples_enqueued` | Counts only (no BP values) |
| `drain_batch` / `drain_finished` | Worker upload |
| `group_ready` / `sync_completed` | Success |
| `sync_failed` / `op_rejected` / `store_open_failed` | Non-fatals |

**Never logged:** systolic/diastolic/pulse, sample UUIDs, tokens, free-text notes.

## Crashlytics constraints

- No `@MainActor` BG coordinator (BG not enabled yet)
- Fail soft on metric isolation when expanding later
- Narrow v1 metrics only
- DEBUG builds keep Crashlytics collection off (use Console.app / OSLog)

## Deleted (do not resurrect)

- Old engine / outbox / BG coordinator / dual UserDefaults authority
- `events:batch` + session/manifest protocol on iOS
