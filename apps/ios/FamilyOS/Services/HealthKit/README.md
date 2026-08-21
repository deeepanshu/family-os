# HealthKit (iOS)

**Status:** correctness-first rewrite — BP + sleep + workouts + foreground steps; background incremental sync for BP / sleep / workouts.

Source of truth for this slice: `docs/HEALTHKIT_BACKGROUND_SYNC_RELIABILITY_PLAN.md`

## Architecture

```
HealthKit samples (BP / sleepAnalysis / HKWorkout / step hours)
  → natural-key ops
  → SQLite pending_ops
  → HealthKitSyncWorker POST /healthkit/ops:batch
  → Postgres UPSERT by natural key
  → POST runs/complete
```

Shared orchestration: `HealthKitRunEngine` (begin → auth → fetch+enqueue → drain → complete).

Background: `HealthKitBackgroundSync` (observers + `enableBackgroundDelivery` + `BGProcessingTask` + `BGAppRefreshTask`).
**Not** `@MainActor` — registration lives on `NotificationAppDelegate`.

## Components

| File | Role |
|------|------|
| `HealthKitInstallationId.swift` | Keychain installation UUID |
| `HealthKitSyncStore.swift` | Single GRDB DB (`pending_ops`, config, group_state) |
| `HealthKitSyncWorker.swift` | Serialized drain of pending ops only |
| `HealthKitBloodPressureSync.swift` | BP query + enqueue |
| `HealthKitSleepDaySync.swift` | Sleep day totals + enqueue |
| `HealthKitWorkoutSync.swift` | All-type workouts (fat summary + events + activities) |
| `HealthKitStepsSync.swift` | UTC hourly steps (foreground first) |
| `HealthKitRunEngine.swift` | One run module + process-wide gate |
| `HealthKitBackgroundSync.swift` | BG tasks + observers + become-active incremental |
| `../Clients/HealthKitClient.swift` | Availability + multi-group authorization |

## Background policy

- Incremental `kind: sync` only. Never import, never repair, never delete.
- Allowlist: vitals (BP), sleep, workouts. Activity/steps stay foreground-only.
- Observer ack first, then at most one metric, ~25s, `waitSeconds: 0`. If the app is active, observers only schedule.
- Opening the app runs `runBoundedSync(reason: "become_active")` then leftover drain.
- Session refresh is `HealthSessionRefresher` (Keychain). Background refresh failure does not sign the user out.
- Heart rate is not observed until vitals uploads it.
- Opt-in lock-screen notification after a non-empty observer / processing / refresh sync.

## Current scope

- Foreground Import / Sync / Repair for vitals (BP), sleep, workouts, and activity (steps)
- Local queue until server ACK
- Idempotent `op_id` + natural-key upsert
- Background delivery + processing + app-refresh (soft-fail)

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
- Query overlapping samples with a 48h lead-in so overnight sessions survive a 24h sync window
- Omit a day when the query started after that night's bedtime — never overwrite a full night with leftover stages
- Empty full query never deletes history
