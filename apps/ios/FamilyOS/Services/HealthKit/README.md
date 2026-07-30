# HealthKit (iOS)

**Status: previous sync stack removed (2026-07-30).**

Deleted (do not resurrect without following the rewrite plan):

- `HealthKitSyncEngine` — full backfill/repair/dirty-bucket engine
- `HealthKitOutboxStore` — GRDB outbox + dual protocol state
- `HealthKitSyncWorker` — versioned event drain
- `HealthKitBackgroundSyncCoordinator` — `@MainActor` BGTask path (Crashlytics fatals)
- `HealthKitSessionProvider` / `HealthKitSyncStateStore` — dual local authority

Rewrite source of truth:

`docs/HEALTHKIT_CORRECTNESS_FIRST_SYNC_PLAN.md`

What remains here:

- `HealthKitInstallationId.swift` — Keychain installation UUID only
- `../Clients/HealthKitClient.swift` — availability + authorization only

No background delivery, no outbox, no observers, no upload pipeline until the
correctness-first rewrite lands.
