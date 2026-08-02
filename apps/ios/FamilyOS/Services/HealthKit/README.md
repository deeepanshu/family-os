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

## Crashlytics constraints

- No `@MainActor` BG coordinator (BG not enabled yet)
- Fail soft on metric isolation when expanding later
- Narrow v1 metrics only

## Deleted (do not resurrect)

- Old engine / outbox / BG coordinator / dual UserDefaults authority
- `events:batch` + session/manifest protocol on iOS
