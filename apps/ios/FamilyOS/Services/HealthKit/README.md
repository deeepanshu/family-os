# HealthKit (iOS)

**Status: correctness-first rewrite — milestone 3 (BP + sleep + workouts, FG + shared BG).**

## Architecture (boring on purpose)

```
HealthKit samples (BP / sleepAnalysis / HKWorkout)
  → natural-key ops
  → SQLite pending_ops
  → HealthKitSyncWorker POST /healthkit/ops:batch
  → Postgres UPSERT by natural key
  → POST /groups/{vitals|sleep|workouts}/ready
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
| `HealthKitSleepDaySync.swift` | 90-day sleep day totals + enqueue |
| `HealthKitWorkoutSync.swift` | 90-day all-type workouts (fat summary + events + activities) |
| `HealthKitSyncCoordinator.swift` | Multi-group FG/BG import+drain+ready |
| `HealthKitBackgroundSync.swift` | BGTask + observers + become-active drain |
| `../Clients/HealthKitClient.swift` | Availability + multi-group authorization |

## Current scope

- Foreground **Sync now** for **vitals (BP)**, **sleep**, and **workouts** when enabled
- Shared coordinator for all implemented groups
- Local queue until server ACK
- Idempotent `op_id` + natural-key upsert
- Group ready gate (sleep/workouts may ready with 0 samples; BP still errors on empty)
- Background delivery + BG processing task (soft-fail; token from Keychain)

## Workouts (locked)

- **All** `HKWorkoutActivityType` values (mapped to snake_case; unknown → `other`)
- Fat summary scalars: energy, distance, min/avg/max HR, source, device, indoor, elevation, METs, swim strokes, flights
- Events JSON (pause/resume/lap/…) and multi-sport activities JSON
- **No** GPS routes, **no** per-second metric series
- Natural key: `workout:<uuid>`

## Sleep rules (locked)

- Day totals: total, core, deep, rem, unspecified, awake, inBed
- `sleepDay` = local calendar day of sample **end** in profile `healthTimezone`
- Prefer Apple / Watch source; never sum overlapping apps
- Empty full query never deletes history
