# HealthKit Correctness-First Sync Plan

Status: proposed rewrite  
Priority: **correctness and stability. No over-engineering allowed.**  
Audience: implementers rewriting the HealthKit → Postgres → MCP path  
Date: 2026-07-30

---

## 0. Constitution (read first)

### 0.1 One sentence

**Put Health data into Postgres once, keep it correct, let MCP read it. Nothing else.**

### 0.2 NO OVER-ENGINEERING

This rewrite exists because the previous path was over-engineered and unstable.
**Over-engineering is a defect.** Clever protocol is not a feature.

Before adding any table, endpoint, status, hash, version field, or abstraction, answer:

> Does this directly prevent **loss**, **duplicate truth**, **false deletes**, or **half-ready MCP reads**?

If the answer is no → **do not build it.**

If unsure → **do not build it.** Ship the simpler path and prove it with tests.

### 0.3 Forbidden (do not reintroduce)

| Forbidden | Why |
|-----------|-----|
| Entity versions / `superseded` streams | Single writer; natural-key overwrite is enough |
| Payload fingerprints as conflict protocol | Trusted own phone |
| Scope manifests / SHA-256 completeness proofs | Ceremony, not row truth |
| Long-lived event logs / entity ledgers as product core | Second source of truth |
| Dual local stores (SQLite + UserDefaults/JSON authority) | They disagree |
| Session abort → full 90-day nuclear rescan for one bad op | Breaks stability |
| CRDTs, multi-writer merge, repair chunk protocols | Not this product |
| Dual full server engines (memory clone of apply rules) | Drift |
| “Future multi-device” hooks | YAGNI |
| Extra metrics “while we’re here” | Surface area kills correctness (see §15 Crashlytics) |
| Compatibility shims with the old sync protocol | Clean cutover |
| `@MainActor` coordinator owning BGTask handlers | Production `EXC_BREAKPOINT` isolation crashes (§15) |
| Full “repair all groups / all metrics” on BG budget | BG must only drain; not re-import the world |
| Crashing on bad `HKUnit` / one bad metric | Fail soft; skip metric; never kill the process |

### 0.4 Allowed complexity (only this)

Only mechanisms that defend the six promises below:

1. Local queue until server ACK (no loss on crash/offline)
2. Idempotent `op_id` + natural-key upsert/delete (no duplicate truth)
3. Anchors + empty-read ≠ delete (no false wipes)
4. Simple group ready/not-ready (no half-truth MCP)
5. One active installation + timezone version (no ghost/cross-phone mix as ready)
6. On-device aggregates for high-frequency types (correct family-shaped rows)

That is the whole system. Prefer boring code.

---

## 1. Product goal (the only contract)

```text
Apple Health (manual or auto)
  → Family OS iPhone app
  → Postgres (no lost rows, no duplicate truth)
  → MCP / app reads from Postgres
```

The user puts data into Apple Health. This app must land that data in the family database
without losing it or inventing duplicate history. MCP and the app then read the database.

This is a **personal / family single-writer** system: one active phone per person, trusted
client, private backend. It is not a multi-tenant public sync product and must not be
designed like one.

---

## 2. Accuracy and stability priorities

### 2.1 Six non-negotiable promises

| # | Promise | Failure mode if broken |
|---|---------|------------------------|
| 1 | Every in-scope HealthKit change eventually appears in Postgres | Silent loss |
| 2 | The same change does not create multiple conflicting truths | Duplicate / oscillating history |
| 3 | HealthKit deletes become corrected aggregates or row deletes | Stale ghost samples |
| 4 | Empty or permission-limited HealthKit reads never wipe real data | Catastrophic false delete |
| 5 | MCP never presents a half-imported group as complete | Misleading family/MCP answers |
| 6 | Crash, offline, and retry never violate 1–5 | Flaky “sometimes wrong” |

If a design element does not defend one of these six, it is **forbidden by default**.

### 2.2 What “stable” means

- Few independent state machines
- One local source of truth for sync control state
- Recovery is small and deterministic (“retry this group”), not “rebuild the universe”
- Stuck states are rare and user-visible with a single recovery action
- Soak tests prove kill mid-upload, offline, delete, reinstall, timezone change

### 2.3 Explicit non-goals

- Multi-device concurrent writers for the same person
- Cryptographic completeness proofs of backfill
- Full event-sourcing query model
- Long-term forensic event ledger
- Maximum HealthKit metric surface
- Compatibility with the current entityVersion / scope-manifest protocol
- Performance micro-optimizations before correctness soak

Clean cutover is preferred. Preserving the old protocol is not a correctness requirement.

---

## 3. Diagnosis of the current system

### 3.1 What is already right (keep the idea)

- HealthKit is the only external health source
- Aggregate on device for high-frequency types (hour/day buckets)
- Typed canonical Postgres tables (not raw sample JSON firehose)
- Shared allowlist registry for privacy-bounded metrics
- Local durable queue before network
- Withhold incomplete first import from “ready” reads
- Empty incremental query must not imply deletion
- One active installation fence

### 3.2 What is overdone (remove or radically thin)

| Mechanism | Why it hurts stability more than it helps accuracy |
|-----------|-----------------------------------------------------|
| `entityVersion` + `superseded` protocol | Single serialized uploader already orders work |
| Server fingerprint conflict protocol | Trusted single writer; optional audit hash only |
| Per-scope SHA-256 manifests | Completeness ≠ row truth; chatty and brittle |
| Session abort → full 90-day rescan on one bad event | Recovery cost exceeds defect cost |
| Long-lived `healthkit_sync_events` + `healthkit_sync_entities` as core | Second sources of truth; retention unfinished |
| Dual iOS stores (SQLite + UserDefaults/JSON ledgers) | Disagreement and migration bugs |
| Unmapped delete → always full group 90-day rebuild | Safe-ish but operationally unstable |
| Dual memory + Postgres apply engines | Drift risk |
| Huge metric matrix (especially nutrition) | Multiplies failure surface without product pull |

### 3.3 Known correctness holes in the current design

These show that “more protocol” did not equal “more correct”:

1. **Installation replace** does not force `never_synced` / full re-import; person-level
   canonical rows can retain previous phone data while status stays `ready`.
2. **Dual local truth** (SQLite outbox vs UserDefaults/JSON ledgers) can diverge.
3. **Step ledger seeding** can be O(samples) HealthKit queries — instability under load,
   not a pure logic bug, but it prevents reliable first import.
4. **Event retention** planned but not implemented — unbounded growth.
5. **Harsh recovery** (full session abort / full rescan) makes the system feel permanently
   broken after a single permanent validation error.

---

## 4. Target architecture

### 4.1 Name

**Natural-key upsert + thin outbox + ready flag.**

Boring on purpose.

```text
HealthKit (anchors)
  → build natural-key records (hour / day / source UUID)
  → SQLite pending_ops
  → worker POST /ops:batch
  → Postgres UPSERT/DELETE by natural key
  → group ready? → MCP may read
```

### 4.2 Only these moving parts

| Piece | Why it exists (must map to a promise) |
|-------|----------------------------------------|
| HK anchors | Don’t miss changes / don’t re-scan forever |
| On-device aggregates | Correct day/hour rows without raw firehose |
| Natural keys | One truth per row in Postgres |
| `op_id` | Retries without duplicate apply |
| Thin outbox | Crash/offline without loss |
| Group `ready` flag | MCP doesn’t see half imports |
| Active installation | Phone swap doesn’t mix ready ghosts |

**If you need a new moving part, stop and re-read §0.**

---

## 5. Data model

### 5.1 Natural keys (source of truth identity)

| Kind | Natural key | Table (keep / align) |
|------|-------------|----------------------|
| Steps hour | `(person_id, hour_start_utc)` | `health_step_hours` |
| Sleep day | `(person_id, sleep_day, health_timezone_version)` | `health_sleep_days` |
| Daily metric | `(person_id, health_metric, local_day, health_timezone_version)` | `health_daily_metrics` |
| Blood pressure | `(person_id, source_object_key)` HealthKit correlation UUID | `health_blood_pressure_readings` |
| Blood glucose | `(person_id, source_sample_key)` | `health_blood_glucose_readings` |
| Workout | `(person_id, source_sample_key)` | `health_workouts` |

These keys already exist in spirit in the current payloads. The rewrite makes them the
**only** consistency model: last successful apply for a natural key wins.

### 5.2 Server control tables (minimal — do not grow this list)

| Table | Purpose |
|-------|---------|
| `healthkit_sync_profile_settings` | Consent, timezone, timezone version |
| `healthkit_sync_state` | enabled + `never_synced` \| `syncing` \| `ready` \| `error` + coverage + last error (merge groups into this; **one table**, not two) |
| `healthkit_sync_installations` | Single active installation per person |
| `healthkit_op_receipts` | Short-TTL `op_id` dedup only (7–30 days). Not a product event log. |

**Drop and do not replace with clever variants:**

- `healthkit_sync_events`
- `healthkit_sync_entities`
- `healthkit_backfill_scope_manifests`
- `healthkit_backfill_sessions` with multi-phase status machines  
  (first import readiness is **group status only** — see §6.2)
- Separate `healthkit_sync_groups` if state can hold `enabled`

### 5.3 Canonical health tables

**Keep** the typed tables. They are the right product surface for MCP and history.

Do not return to raw `healthkit_samples` as the primary model.

### 5.4 Local SQLite (single store)

One database file, excluded from backup, file-protected:

```sql
-- Single configuration row
CREATE TABLE sync_configuration (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  user_id TEXT NOT NULL,
  person_id TEXT NOT NULL,
  installation_id TEXT NOT NULL,
  health_timezone TEXT NOT NULL,
  timezone_version INTEGER NOT NULL,
  enabled_groups_json TEXT NOT NULL,
  updated_at REAL NOT NULL
);

CREATE TABLE group_state (
  group_key TEXT PRIMARY KEY,
  status TEXT NOT NULL, -- never_synced | syncing | ready | error
  coverage_start REAL,
  coverage_end REAL,
  last_error_code TEXT,
  last_success_at REAL
);

CREATE TABLE sync_cursors (
  cursor_key TEXT PRIMARY KEY,
  anchor BLOB,
  updated_at REAL NOT NULL
);

-- Thin outbox: one row per pending upload
CREATE TABLE pending_ops (
  op_id TEXT PRIMARY KEY,
  natural_key TEXT NOT NULL,
  group_key TEXT NOT NULL,
  scope_key TEXT NOT NULL,
  op TEXT NOT NULL,              -- upsert | delete
  payload_json BLOB,             -- NULL for delete
  status TEXT NOT NULL,          -- pending | in_flight
  attempt_count INTEGER NOT NULL DEFAULT 0,
  next_attempt_at REAL NOT NULL DEFAULT 0,
  created_at REAL NOT NULL,
  updated_at REAL NOT NULL
);
CREATE INDEX pending_ops_drain ON pending_ops(status, next_attempt_at);
CREATE INDEX pending_ops_natural ON pending_ops(natural_key, status);

-- Pending recompute for bucketed metrics (steps hour / sleep day / daily). Correctness, not ceremony.
CREATE TABLE dirty_buckets (
  natural_key TEXT PRIMARY KEY,
  group_key TEXT NOT NULL,
  scope_key TEXT NOT NULL,
  allows_delete INTEGER NOT NULL DEFAULT 0,
  updated_at REAL NOT NULL
);

-- Map sample UUID → natural keys so deletes can recompute the right buckets. Keep in SQLite only.
CREATE TABLE source_bucket_index (
  source_uuid TEXT NOT NULL,
  group_key TEXT NOT NULL,
  natural_key TEXT NOT NULL,
  measured_at REAL NOT NULL,
  PRIMARY KEY (source_uuid, natural_key)
);
CREATE INDEX source_bucket_index_source ON source_bucket_index(source_uuid);
```

**Rules:**

- SQLite is the **only** durable sync control plane
- No UserDefaults / JSON files as authority
- UI may mirror status for display only
- Do not add tables “for diagnostics” that become a second control plane

---

## 6. API surface (keep tiny)

Base: `/health/api/v1/healthkit` (or one clean cutover path — **not** dual v1+v2 forever).

| Endpoint | Purpose |
|----------|---------|
| `GET/PUT /settings` | Consent, enabled groups, timezone, active installation |
| `POST /ops:batch` | Apply ops; each result `applied` \| `duplicate` \| `rejected` |
| `POST /groups/:group/ready` | Client asserts first import finished (scanned + local outbox empty for group) |
| `GET /groups/:group/status` | status + coverage for UI |

**No** import-session CRUD, **no** scope manifests, **no** pending-event diagnostic pagination,
**no** group entity reconciliation API in v1.

If first-import needs a server-side range freeze, store `coverage_start` / `coverage_end` on
`healthkit_sync_state` when client starts import (`POST /groups/:group/start-import` is
acceptable as a **single** extra endpoint). Do not grow a session subsystem.

### 6.1 Op batch contract

```jsonc
{
  "installationId": "uuid",
  "personId": "uuid",
  "timezoneVersion": 1,
  "ops": [
    {
      "opId": "uuid",
      "naturalKey": "steps_hour:2026-07-25T14:00:00.000Z",
      "group": "activity",
      "scopeKey": "steps",
      "op": "upsert",
      "payload": { "kind": "steps_hour", "hourStartUtc": "...", "count": 1200 }
    }
  ]
}
```

Server rules (all of them):

1. Reject batch if installation inactive, consent withdrawn, or timezone version stale.
2. Known `op_id` → `duplicate`.
3. Invalid op → `rejected` for that op only (do not invent batch-wide drama).
4. Valid op → UPSERT/DELETE by natural key; store short-TTL `op_id` receipt.
5. While group is `syncing` / `never_synced`, rows may land, but reads stay withheld until `ready`.

**Do not add:** entity versions, fingerprints, supersede results, session-tagged events.

### 6.2 First import readiness (no crypto, no session machine)

1. Client sets group `syncing` (local + `start-import` if used) and scans the 90-day window.
2. Client enqueues ops and drains outbox for that group.
3. Client calls `POST /groups/:group/ready` only when scan finished and local pending for that
   group is empty.
4. Server sets `ready` + coverage. MCP may read.
5. Bad single op → fix or surface error; **never** force a nuclear full-protocol rebuild.

### 6.3 Installation replace (correctness critical, still simple)

On `replaceActiveInstallation=true`:

1. Revoke old installation; activate new one.
2. Set all enabled groups to `never_synced` (not `ready`).
3. Clear coverage / last success for those groups.
4. MCP stays withheld until new phone finishes import.

No soft-quarantine subsystem. Readiness flag is the gate. Timezone change bumps version and
forces re-import for day-bucketed data — same simple rule.

---

## 7. iOS pipeline

### 7.1 Components (hard cap)

Prefer **four** units of code. Do not invent a fifth “manager/coordinator/facade” layer
without deleting another.

| Component | Responsibility |
|-----------|----------------|
| `HealthKitClient` | HK auth, observers, anchors, queries |
| `HealthKitSyncStore` | One GRDB DB (schema above) |
| `HealthKitSyncEngine` | Read HK → enqueue ops → advance cursor (same txn as enqueue) |
| `HealthKitSyncWorker` | Drain `pending_ops` only |

Background: observers + BGTask only **nudge** the worker (drain). Auth token provider can be a
small helper, not a parallel state store.

**Crashlytics (§15):** Do **not** put BGTask registration/handlers on a `@MainActor`
coordinator. BG entry is nonisolated; sync work is actor/background-safe; MainActor is for UI
only. BG does **not** run full multi-group first import.

**Delete** dual UserDefaults / JSON ledger authority. UI reads store counts + server status.

### 7.2 Triggers

1. Manual “Sync now”
2. App foreground / profile resume
3. HealthKit observer
4. BG processing task when outbox non-empty

All paths only **nudge** the same engine + worker. No second upload path.

### 7.3 First import vs incremental

**First import / re-import (`never_synced` or `error` recovery):**

1. Mark group `syncing` (local + server).
2. Query HealthKit for the 90-day window per scope; materialize natural-key ops.
3. Drain outbox until empty for that group.
4. Call `ready` → group `ready`.
5. Keep anchors in SQLite; advance cursor only after durable local enqueue of an observed page.

**Incremental (`ready`):**

1. Anchored query pages for relevant types.
2. Source-keyed types (BP, glucose, workout): upsert/delete by UUID.
3. Bucketed types: mark dirty natural keys; recompute from HealthKit; enqueue upsert or
   delete only if `allows_delete` after observed HK deletion (or equivalent safe rule).
4. Never delete because a query returned empty without an observed deletion path.

### 7.4 Delete rules (accuracy critical)

| Situation | Action |
|-----------|--------|
| Anchored deletion for source-keyed sample | Enqueue `delete` for that natural key |
| Anchored deletion affecting a bucket | Mark dirty + `allows_delete=1`; recompute; empty → delete op |
| Incremental empty page / empty recompute without allows_delete | Clear dirty; **no delete op** |
| Missing source→bucket index entry | Recompute a **bounded** window for that metric (e.g. last 14–90 days for that scope), not necessarily a full multi-scope protocol reset |
| Permission revoked | Stop group; do not delete server data |

### 7.5 Upload / retry

- Claim batch of pending ops (start with 50–100; raise toward API max when Pi latency OK).
- POST `/ops:batch`.
- `applied` / `duplicate` → delete local op.
- `rejected` (validation) → record error on op or group; do not infinite loop; surface to UI.
- Network / 5xx / 429 → exponential backoff with jitter; keep ops.
- 401 → single-flight token refresh, one retry.

Worker is app-wide serialized. On launch, reset `in_flight` → `pending`.

### 7.6 Metric surface for first correctness milestone

Ship readiness for a **narrow** set first:

- **activity:** steps (hourly), active energy, exercise time (daily as needed)
- **sleep:** sleep day (+ wrist temp / breathing only if already solid)
- **vitals:** heart rate stats (daily), resting HR, HRV, blood pressure, blood glucose
- **body:** body mass
- **workouts:** workouts

Defer full nutrition micronutrient matrix and large mobility/environment sets until the
pipeline is soak-stable. Registry size is a correctness surface area multiplier.

---

## 8. Server apply path

### 8.1 Apply algorithm (this is the whole server sync brain)

```text
for each op in batch:
  if op_id known → duplicate
  validate payload + natural key match
  if upsert → UPSERT canonical row by natural key
  if delete → DELETE canonical row by natural key (no-op if missing)
  record short-TTL op receipt
  return applied
```

Fence install/consent/timezone once at batch start. Do not build savepoint ballets, entity
ledgers, or fingerprint conflict graphs.

### 8.2 Read path / MCP

- MCP and history queries read **only** canonical tables.
- If group status is `never_synced`, `syncing`, or `error`, withhold or mark incomplete
  via existing `shouldWithholdMetricRecords`-style rules **in every read API**, not only MCP.
- Never require entity ledgers for reads.

### 8.3 Retention

- Purge `healthkit_op_receipts` older than 30 days (or 7).
- Canonical tables retain product history; optionally later add product-level retention
  policy (e.g. years) — separate from sync protocol.

---

## 9. Correctness rules checklist (implement as tests)

These are the acceptance bar. A rewrite is “done” when these pass on device + local API,
not when protocol docs are complete.

### 9.1 Loss / retry

- [ ] Kill app after local enqueue, before upload → data eventually lands
- [ ] Kill after server apply, before client ACK → retry yields `duplicate`, DB unchanged
- [ ] Offline for hours → drain resumes, final DB matches uninterrupted run
- [ ] 429 / 5xx → backoff, no data loss, no duplicate truth

### 9.2 Deletes

- [ ] Delete BP/glucose/workout in HealthKit → row removed in Postgres after sync
- [ ] Delete steps contribution for an hour → hour recomputed or deleted correctly
- [ ] Empty incremental query does **not** delete server rows
- [ ] Missing local index → bounded recompute, not infinite stuck state

### 9.3 First import / readiness

- [ ] Mid-import MCP/API does not present group as complete
- [ ] `ready` only after full window scanned and outbox drained
- [ ] Failed ready leaves group non-ready

### 9.4 Install / timezone

- [ ] New installation with replace → groups not ready until re-import
- [ ] No ghost “ready” data from previous phone after replace
- [ ] Timezone change → day-bucketed metrics re-imported under new version

### 9.5 Concurrency / background (Crashlytics-driven)

- [ ] Observer + manual sync + BG task do not double-corrupt local state
- [ ] Only one drain loop mutates in_flight claims
- [ ] BGTask handler never touches a `@MainActor` singleton/coordinator path that can
      trip queue isolation asserts (device soak after shipping BG)
- [ ] BG path only drains pending ops; does not run full multi-group first import
- [ ] Expiration handler only reschedules; does not re-enter MainActor-heavy stacks unsafely

### 9.6 Units / metric isolation (Crashlytics-driven)

- [ ] VO₂ and every enabled metric use safe composed `HKUnit` constructors (no process-killing
      `unitFromString` for complex units)
- [ ] One bad metric skips with non-fatal log; other metrics still import
- [ ] Production-enabled metric list is the narrow v1 set only (§7.6 / §15)

### 9.7 Accuracy samples

- [ ] Manual BP entry in Health → appears once in DB
- [ ] Watch steps for a day → hour buckets match Health totals within known aggregation rules
- [ ] Sleep across midnight → assigned to correct local sleep day in health timezone

---

## 10. Migration / cutover plan

Prefer **one clean cut**, not dual-protocol forever:

1. Stop adding features to the old protocol.
2. One migration: keep canonical health tables; drop unused protocol tables; add short-TTL
   op receipts + simplified state if needed.
3. Replace iOS HealthKit stack with the four components in §7.1.
4. Force re-import on first launch of the new client.
5. Enable only the narrow metric set.
6. Soak on a real phone (manual entry, Watch, delete, airplane, force-quit, reinstall).
7. Expand metrics only after soak is boringly green.

---

## 11. Implementation order (correctness first)

Take as long as needed. Do not add “nice” layers mid-stream.

1. Shared op + natural-key schemas + small registry subset.
2. Postgres control tables + install-replace → `never_synced` + receipt TTL.
3. API: settings, ops batch, start-import (optional), ready, status; withhold on all reads.
4. iOS single SQLite store.
5. End-to-end **one** metric (e.g. blood pressure) foreground only.
6. Worker drain/retry/idempotency.
7. Add steps hourly, sleep day, daily HR, workouts — one at a time with tests.
8. Incremental anchors + deletes.
9. Background only after foreground is soak-stable — and only as **drain** (§15).
10. Device soak specifically for: BGTask no crash, bad-unit skip, narrow metrics.
11. MCP check on ready groups.
12. Delete dead old sync code and mark old plan docs superseded.

**Gate:** if a PR adds a forbidden item from §0.3, reject it.  
**Gate:** if a PR reintroduces a §15 failure mode (MainActor BGTask, full repair on BG,
crash on unit, full nutrition critical path), reject it.

---

## 12. What success looks like

1. Health data appears in Postgres **once**.
2. Deletes in Health correct Postgres.
3. Crash / offline / retry end in the same DB state as a clean run.
4. MCP only answers from ready groups and matches those tables.
5. Phone replace never shows old phone data as ready.
6. Nobody is debugging versions, manifests, dual ledgers, or session machines.
7. Crashlytics does not show recurring HealthKit BGTask isolation or unit-parse fatals
   after the rewrite ships.

If you need a debugger for protocol state more often than for HealthKit itself, the design
has failed the simplicity rule.

---

## 13. Decision summary

| Question | Decision |
|----------|----------|
| Over-engineering allowed? | **No** |
| Goal | Correct Health → DB → MCP |
| Model | Natural-key upsert + thin outbox + ready flag |
| Typed aggregates + local queue? | **Yes** (correctness) |
| Versions / hashes / dual stores / session manifests? | **No** |
| More tables “for safety”? | Only if they map to a §2.1 promise |
| Production crash lesson | BG isolation + narrow safe metrics, not more protocol |

---

## 14. Related docs

- This file is the source of truth for the rewrite.
- `docs/HEALTHKIT_SYNC_PLAN.md` and older background-sync plans are historical; do not
  implement from them after this is accepted.
- `docs/TECHNICAL_DESIGN.md` HealthKit sections are stale for this area.

When accepted, mark old HealthKit sync plans superseded and point here only.

---

## 15. Crashlytics constraints (production evidence, 2026-07)

**Source:** Firebase Crashlytics for app `1:326123052022:ios:5593032d52c78a35a605d7`
(`com.deepanshujain.familyos`), roughly last 30 days, versions `0.1.0` (builds 17–34).  
**Method:** Firebase MCP `crashlytics_get_report` (topIssues / topVersions) + sample events.  
**Takeaway:** All top fatals are HealthKit sync related. Production pain is **not** “need
more sync protocol.” It is **concurrency isolation** and **unsafe metric/unit breadth**.

### 15.1 Top fatal issues observed

| Rank | Issue (title) | Events | Users | Class |
|------|---------------|--------|-------|-------|
| 1 | `HealthKitBackgroundSyncCoordinator.registerBackgroundTasks` closure #2 | 8 | 3 | `EXC_BREAKPOINT` — MainActor / queue isolation |
| 2 | `HealthKitDataMetric.unit.getter` | 2 | 1 | `NSInvalidArgumentException` — `Unable to parse factorization string mL/kg/min` (VO₂) |
| 3 | `registerBackgroundTasks` closure #1 | 2 | 2 | Same BGTask isolation class as #1 |

No top issues attributed to outbox SQL, API client fatals, entity versions, or scope
manifests. That supports stripping the heavy control plane and fixing the real failure modes.

### 15.2 BGTask + `@MainActor` (dominant crash)

**Stack pattern (sample, build 34, iPhone 17 / iOS 26.5.2):**

```text
_dispatch_assert_queue_fail
swift_task_isCurrentExecutorWithFlagsImpl
closure in HealthKitBackgroundSyncCoordinator.registerBackgroundTasks()
BGTaskScheduler _runTask
```

**Cause class:** BGTaskScheduler invokes handlers off the main queue. A fully `@MainActor`
coordinator (registration, shared singleton, processing) produces isolation asserts
(`EXC_BREAKPOINT`) when BG work crosses that boundary incorrectly.

**Rewrite requirements (non-negotiable):**

1. **BGTask entry is nonisolated.** Do not own registration/handlers on a `@MainActor` type.
2. Sync work lives on an **actor / plain class / worker**; hop to MainActor **only** for UI.
3. BG path is **drain pending ops only** — load config, upload queue, `setTaskCompleted`.
   Not full multi-group first import / “repair everything.”
4. Expiration handler only **reschedules** a later drain; no heavy MainActor re-entry.
5. Device soak must prove BGTask completes without this fatal after rewrite.

**Maps to:** §7 (iOS components hard cap), §9.5, implementation order step 9.

### 15.3 Invalid unit + oversized metric surface

**Exception (sample, build 17):**

```text
NSInvalidArgumentException: Unable to parse factorization string mL/kg/min
  at HealthKitDataMetric.unit.getter
  → dailyMetricOperations → additionalRepairOperations → buildRepair / processMetric
  → ProfileView resumePendingWork
```

**Context from Crashlytics logs:** `healthkit_stage: background_delivery_requested` and a
flood of enabled types including many **dietary micronutrients** (e.g. DietaryMolybdenum,
DietaryVitaminE, DietaryChromium, …) before/around the crash.

**Cause class:**

1. Unsafe / wrong `HKUnit` construction for complex units (VO₂-style `mL/kg/min` is not a
   valid HealthKit factorization string; use composed units).
2. **Metric surface far too wide for v1** — nutrition matrix + full repair multiplies
   fatal surface. One bad unit can kill the whole import path.

**Rewrite requirements (non-negotiable):**

1. **Narrow v1 allowlist only** (§7.6): steps + core activity, sleep, vitals (HR/BP/glucose),
   body mass, workouts. **No full nutrition micronutrient critical path** until soak is green.
2. Units are a **static composed `HKUnit` map**. Prefer constructors over `HKUnit(from:)`.
   Complex units (VO₂, rates) must be composed; never process-kill on parse failure.
3. **Per-metric isolation:** bad metric → skip + non-fatal log; other metrics continue.
4. **Do not enable background delivery** for metrics not ready to sync correctly.
5. Ship metrics **one at a time** with tests (implementation order), not “all groups at once.”

**Maps to:** §0.3 extra-metrics ban, §7.6, §9.6, implementation order steps 5–7.

### 15.4 What we will not do in response to these crashes

| Temptation | Why rejected |
|------------|--------------|
| Add more protocol / versions / manifests to “be safer” | Crashes are isolation + units, not event ordering |
| Keep dual ledgers for “diagnostics” | Did not prevent fatals; increases dual-truth risk |
| Nuclear full rescan when one metric unit fails | Same class of harsh recovery already banned |
| Enable all HealthKit types then “fix units later” | Production already proved this crashes users |

### 15.5 Crashlytics-derived acceptance (must pass before calling rewrite done)

- [ ] No recurrence of BGTask `EXC_BREAKPOINT` isolation fatals on device after BG enabled
- [ ] No fatal on unit construction for any **enabled** metric (VO₂ included only if enabled
      and unit is composed-safe)
- [ ] Enabling/disabling metrics never registers background delivery for out-of-scope types
- [ ] One intentionally broken unit in a **test** path skips without killing the process
- [ ] Foreground import of narrow set works before BG is turned on

### 15.6 Priority order implied by Crashlytics

| Priority | Work | Why |
|----------|------|-----|
| P0 | Nonisolated BG entry + worker drain-only | Most events; still open on recent builds |
| P0 | Safe unit map + fail soft | Process-killing fatals on sync |
| P0 | Narrow enabled metric set | Removes entire crash classes |
| P1 | Per-metric try/isolation in engine | One bad metric must not stop the pipe |
| P1 | BG only after foreground soak | Avoid shipping isolation bugs early |

These constraints are part of the plan’s definition of done, not optional polish.
