# Local Demo Seed Plan

| Field | Value |
| --- | --- |
| Status | Draft |
| Date | 2026-08-23 |
| Branch / worktree | `docs/local-demo-seed-plan` at `/Users/deepanshu/Desktop/projects/family-os-local-demo-seed-plan` |
| Does not authorize | Fake HTTP API, iOS `HealthAPIClient` protocol, OpenAPI spec, Swift codegen, ghost family members, production seed, production override, DB wipe, seed metadata tables, reminder seed |

## Overview

Debug already talks to a real local API. Home and History look empty because local Postgres has no rows until HealthKit syncs. The missing piece is **demo data on the API**, not a second backend and not a TestFlight loop.

Demo data lives in the API. The iOS app stays a real HTTP client (`dev-token` → `HEALTH_API_DEV_AUTH_USER_ID`). A **route-level demo contract** on the same Hono routes iOS calls is how an API change forces the seed to update. That test checks the JSON those screens consume. It does not run Swift decoding or SwiftUI.

## Why not a fake API

| Existing piece | Behavior |
| --- | --- |
| Debug / `FAMILY_OS_ENV=local` | `http://localhost:3001/health/api/v1` |
| Local API | `npm run db:up && npm run db:migrate:local && npm run api:dev` |
| Auth bypass | Debug **Continue** → `Bearer dev-token` |
| In-memory store | `HEALTH_API_REPOSITORY=memory` — test fake; production rejects it |
| Phone Debug | LAN IP in `HEALTH_API_BASE_URL`; `localhost` is the phone |
| ATS | `NSAllowsLocalNetworking` already on |

A canned HTTP server or in-process Swift mock cannot exercise HealthKit, background tasks, Sign in with Apple, or APNs. It would also clone `InMemoryFamilyRepository` + every `HealthAPIClient` route and drift.

`createProfile` for a non-self “Mom” is rejected (`ghost_profiles_unsupported`). Extra members must join with their own app.

## Coupling (how API changes update the fake)

There is no OpenAPI, no iOS `HealthAPIClient` protocol, and no response snapshots. Do not add those. The contract already exists: `@family-os/shared` types + `AppRepositories` + Hono routes.

```
@family-os/shared types
        ↓
AppRepositories           ← existing split, not FamilyRepository
   families / profiles / healthKit
   ├─ Postgres            ← local + prod
   └─ InMemory            ← existing test fake
        ↓
seedLocalDemo(stores, { asOf })
        ↓
route-level demo contract ← same Hono paths iOS calls
```

The seed function takes a structural subset, not the god interface:

```ts
Pick<AppRepositories, "families" | "profiles" | "healthKit">
```

That reuses real seams. It does **not** invent a fourth adapter. It also does **not** make TypeScript force the seed to call a newly added store method. The compile-gate claim in the first draft was wrong. Coupling is the route-level demo contract on **explicitly asserted fields**. A renamed or missing asserted field fails. A newly added metric or JSON key does not fail until someone adds an assertion for it.

HealthKit writes are `putHealthKitSettings` → `applyHealthKitOps` → list seeded workouts → `putHealthKitWorkoutExercises` on the **returned** `workout.id` → `markHealthKitGroupReady`. **Never** `beginHealthKitRun`. `applyHealthKitOps` does not require an open run. `begin(..., kind: "initial_import")` is rejected with `run_kind_not_allowed` once history is complete (`healthKitDomain.ts` `assertRunKindAllowed`). Branching on `needsInitialImport` only exists if the seed starts a run; this seed does not, so that branch is not in scope.

Do not pass `sourceSampleKey` into `putHealthKitWorkoutExercises`. In-memory `listHealthKitWorkouts` sets `id` to `sourceSampleKey`; Postgres allocates `health_workouts.id` and looks up that column (`healthKitStore.ts`). Find the strength row by `workoutType` + `startedAtUtc`, then use the listed `id`. Passing the sample key passes the in-memory test and 404s on local Postgres.

`opId` is `uuidHash("local-demo:" + userId + ":" + naturalKey)`. Do not fold in `asOf`. `healthkit_op_receipts.op_id` is a **global** primary key (`db/schema/health.ts`). Hashing only `naturalKey` collides when two users seed `steps_hour:<same timestamp>` — the second apply is a `duplicate` and never writes. Keep `userId` on the seed options (CLI maps `HEALTH_API_DEV_AUTH_USER_ID`); scoping the hash is cheaper than hard-coding the user. Same `(userId, naturalKey)` → same `opId` → `duplicate`, that user’s receipt table does not grow. A later `asOf` only adds receipts for **new** keys.

Idempotency is **for a fixed seed window**, not “run any day, same row count.” Inject `asOf`. Stable HealthKit natural keys upsert the same timestamps. A rolling `now` window would add a new day on tomorrow’s run. No seed metadata table, no cleanup job. CLI defaults `asOf` to today UTC so History stays inside the app’s 90-day fetch. The test pins `asOf` and runs twice.

### Do not add

| Artifact | Why not |
| --- | --- |
| OpenAPI | Second copy of `@family-os/shared`. One iOS app in-repo. If codegen is ever needed, generate from shared Zod/TS types. |
| `HealthAPIClient` protocol + Swift fake | Every new route becomes live + protocol + fake + fixtures. Debug already uses HTTP. Tests can swap `URLSession`. |
| Full `toMatchSnapshot()` goldens | Break on every UUID and timestamp. |
| iOS fake just to “close” Swift decoding | The route-level test is enough for this pass. |

### Route-level demo contract

After `seedLocalDemo`, call the same paths iOS uses:

- `POST /bootstrap`
- `GET /families/current`
- `GET /families/members`
- `GET /people`
- `GET /healthkit/settings`
- `GET /readings/blood-pressure`
- `GET /readings/sleep`
- `GET /readings/steps`
- `GET /readings/workouts`

Not `/readings/sleep-days` or `/readings/step-days`. Those paths do not exist.

Assert response fields, not entire payloads:

- `families/current` is a household named `Jain Family` unless the user already had one (then keep that name)
- `families/members` includes the seed user
- `people` includes the Self profile
- latest BP present
- 14 sleep days, 14 step days, 3 workouts
- one `traditional_strength_training` workout with exercises
- HealthKit groups `activity`, `sleep`, `vitals`, `workouts` are `ready`

Home loads `/people`. Family loads `/families/current` and `/families/members`. Omit those and the contract does not cover Family.

Later (not this pass): if SwiftUI canvas must work with the API off, dump this JSON and have iOS decode it with the existing `Codable` models. Still generated from the API.

## What to seed

User `00000000-0000-4000-8000-000000000001` (AGENTS.md / local `dev-token`).

| Item | Value |
| --- | --- |
| Self profile | `Deepanshu` — keep the name if a Self profile already exists |
| Household | `Jain Family` if none, so Family is not the empty create form. No ghost extra people |
| HealthKit | Enable `activity`, `sleep`, `vitals`, `workouts`; ops → list workouts → put exercises on listed `id` → `markReady`. Do not `begin` a run. Settings are required: BP list joins `healthkit_sync_profile_settings` |
| 14 days ending `asOf` | Hourly steps (08:00–15:00 UTC), nightly sleep |
| ~8 BP readings | Morning, varying ~116–128 / 74–80 |
| 3 workouts | Run, walk, strength (Bench Press + Arnold Press sets) |
| Timezone | `UTC` so day windows are trivial and match History’s 90-day fetch |
| Installation | `existing settings.activeInstallationId ?? 00000000-0000-4000-8000-000000005eed`. Never `replaceActiveInstallation` when an install is already active. `…seed` is not a valid UUID |

No reminder. Home, History, and Family do not render reminders. A reminder would add `ReminderStore`, `requireActiveMember`, and a second idempotency rule for no extra pixels.

`getHealthKitSettings` already returns a settings object with optional `activeInstallationId` when none exists. Reuse that id for `put` + ops so a phone that already claimed the profile is not revoked.

## Commands

```sh
npm run db:up
npm run db:migrate:local
npm run db:seed:local          # new
```

Existing API:

```sh
DATABASE_URL=postgres://family_os:family_os@localhost:5432/family_os \
HEALTH_API_REPOSITORY=postgres \
HEALTH_API_SYNC_LOCAL_AUTH_USERS=true \
HEALTH_API_ENABLE_DEV_AUTH=true \
HEALTH_API_DEV_AUTH_USER_ID=00000000-0000-4000-8000-000000000001 \
npm run api:dev
```

Debug iOS → **Continue**. Phone Debug: Mac LAN IP, not `localhost`.

A second run with the same `asOf` preserves the same **route-visible** fixture counts. Settings `updated_at` and audit rows may still be written. Next calendar day (new default `asOf`) adds one more day’s keys; old days stay. That is acceptable. Do not wipe.

### CLI guards

`apps/api/scripts/seed-local.ts` must refuse to write unless both hold:

- `NODE_ENV` is not `production`
- `DATABASE_URL` hostname is loopback: `localhost`, `127.0.0.1`, `::1`, or `[::1]`

No production override flag in this pass. `NODE_ENV` alone is weak; the host check is the real fence. Documented local URL is loopback. Docker/`homelab-postgres` hostnames are out of scope — port-forward and seed against localhost.

## Implementation

1. `apps/api/src/localDemoSeed.ts` — `seedLocalDemo(stores, { userId, asOf })` on `Pick<AppRepositories, "families" | "profiles" | "healthKit">`. Writes: settings → deterministic ops → list workouts → `putHealthKitWorkoutExercises(listed.id, …)` → `markReady`. No `beginHealthKitRun`. No `sourceSampleKey` as workout id.
2. `apps/api/src/localDemoSeedGuard.ts` — `assertLocalSeedTarget({ nodeEnv, databaseUrl })`. Allow `localhost`, `127.0.0.1`, `::1`, and `[::1]`. `new URL(postgresUrl).hostname` returns `[::1]` (brackets included) for IPv6. Reject `NODE_ENV=production` and any other host. No override flag.
3. `apps/api/scripts/seed-local.ts` — call the guard, then `PostgresFamilyRepository` + `syncLocalAuthUsers: true`.
4. Root `npm run db:seed:local` (wait for Postgres, then the script).
5. `apps/api/test/localDemoSeed.test.ts` — two seeds with the same pinned `asOf` keep the same route-visible counts; Hono route-level demo contract above; unit cases for the four loopback host forms and for production / non-loopback rejection.
6. Run seed against local Postgres and confirm the seeded records are present. Exact totals are only asserted in the fresh in-memory contract test; existing local HealthKit rows are intentionally kept.
7. One-line note in `AGENTS.md` and README local setup.

`HEALTH_API_REPOSITORY=memory` stays a unit-test store. Do not use it as the phone backend: state dies on restart, and HealthKit sync is what must persist.

## Out of scope

- Fake HTTP API or in-app mock client
- OpenAPI / Swift codegen / client protocol
- Production seed or any production override
- Wiping local Postgres
- Extra family members without a second user
- Reminders
- Seed metadata / cleanup machinery
- Checked-in response dumps (unless a later preview-without-API pass needs them)

