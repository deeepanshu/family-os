# HealthKit Correctness-First Sync Plan

Status: proposed rewrite  
Priority: **accuracy and stability over speed, feature breadth, or protocol completeness**  
Audience: implementers rewriting the HealthKit → Postgres → MCP path  
Date: 2026-07-30

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

If a design element does not defend one of these six, it is optional and default-removed.

### 2.2 What “stable” means

- Few independent state machines
- One local source of truth for sync control state
- Recovery is small and deterministic (“retry this group”), not “rebuild the universe”
- Stuck states are rare and user-visible with a single recovery action
- Soak tests prove kill mid-upload, offline, delete, reinstall, timezone change

### 2.3 Explicit non-goals for v1 of this rewrite

- Multi-device concurrent writers for the same person
- Cryptographic completeness proofs of backfill
- Full event-sourcing query model
- Long-term forensic event ledger as product dependency
- Maximum HealthKit metric surface (nutrition micronutrients, etc.)
- Compatibility with the current outbox / entityVersion / scope-manifest protocol

Clean cutover is preferred. This path has not shipped to real users as a stable product;
preserving the old protocol is not a correctness requirement.

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

**Natural-key bulk upsert with thin durable outbox and group readiness.**

```text
HealthKit (anchors)
  → recompute natural-key records (hour / day / source UUID)
  → one SQLite table: pending_ops
  → serialized worker POST /healthkit/ops:batch
  → Postgres UPSERT/DELETE by natural key (idempotent op_id)
  → group status: never_synced | syncing | ready | error
  → MCP / API history read when ready (or clearly incomplete)
```

### 4.2 Pattern components

| Component | Role |
|-----------|------|
| HK anchors | Incremental change detection |
| On-device aggregation | Product-shaped rows, not sample firehose |
| Natural keys | Single row identity in Postgres |
| `op_id` (UUID) | Idempotent upload / retry |
| Thin outbox | Crash-safe until ACK |
| Group readiness | MCP accuracy gate for first import |
| Active installation | Phone swap fence |

No entity-version streams. No scope crypto manifests. No long-lived apply log as product
dependency (short-lived receipts optional for dedup windows only).

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

### 5.2 Server control tables (minimal)

Keep / rewrite down to:

| Table | Purpose |
|-------|---------|
| `healthkit_sync_profile_settings` | Consent, timezone, timezone version |
| `healthkit_sync_groups` or merged into state | Enabled groups |
| `healthkit_sync_state` | `never_synced` \| `syncing` \| `ready` \| `error` + coverage window + last error |
| `healthkit_sync_installations` | Single active installation per person |
| `healthkit_op_receipts` (optional, short TTL) | Recent `op_id` dedup only (e.g. 7–30 days) |

Drop as product dependencies:

- `healthkit_sync_events` long-lived apply log (or replace with short TTL receipts only)
- `healthkit_sync_entities` version ledger
- `healthkit_backfill_scope_manifests` crypto proofs
- Complex multi-status backfill session machine beyond open/complete/abort

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

-- Dirty aggregate buckets (optional but recommended for steps/sleep/daily)
CREATE TABLE dirty_buckets (
  natural_key TEXT PRIMARY KEY,
  group_key TEXT NOT NULL,
  scope_key TEXT NOT NULL,
  allows_delete INTEGER NOT NULL DEFAULT 0,
  updated_at REAL NOT NULL
);

-- Source UUID → affected bucket keys for delete fan-out (in SQLite, not JSON files)
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

- No UserDefaults as durable sync control plane
- No parallel “ledger JSON files” as authority
- UI may cache display state; SQLite is authoritative for sync

---

## 6. API surface (minimal)

Base path remains under `/health/api/v1/healthkit` (or a clean `/healthkit/v2` cutover).

| Endpoint | Purpose |
|----------|---------|
| `GET/PUT /settings` | Consent, groups, timezone, active installation |
| `POST /ops:batch` | Apply up to N ops; each result `applied` \| `duplicate` \| `rejected` |
| `POST /import-sessions` | Open first-import / re-import window for one group (optional but useful) |
| `POST /import-sessions/:id/complete` | Mark group ready after client finished full scan + drain |
| `POST /import-sessions/:id/abort` | Mark error; does not delete already-applied good rows |
| `GET /groups/:group/status` | status + coverage for UI/MCP diagnostics |

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

Server rules:

1. Reject batch if installation inactive, consent withdrawn, or timezone version stale.
2. For each op: if `op_id` already seen → `duplicate` (no re-apply required).
3. Else validate payload; on invalid → `rejected` for that op only (do not fail whole batch
   unless fencing error).
4. Apply UPSERT/DELETE on canonical table by natural key.
5. Optionally store `op_id` in short-TTL receipts.
6. **Do not** require entity versions or payload fingerprints for conflict protocol.
7. Incremental applies during `syncing` may write canonical rows, but group stays non-ready
   until import session completes (MCP withholds).

### 6.2 Import session (simple readiness, no crypto)

- Create session freezes `rangeStart`, `rangeEnd`, required scope list for the group.
- Client scans all scopes, enqueues ops, drains outbox.
- Client calls complete when:
  - every required scope was scanned once, and
  - no pending/in_flight ops remain for that session/group (or server pending count is 0
    if using session tags — optional).
- Server marks group `ready` and sets coverage window.
- **One permanent rejection does not auto-nuke the session.** Client may retry the bad op
  or mark group `error` with a clear code after repeated failure. Prefer soft isolation.

### 6.3 Installation replace (correctness critical)

On `replaceActiveInstallation=true`:

1. Revoke old installation.
2. Activate new installation.
3. Set all enabled groups to `never_synced`.
4. Abort open import sessions.
5. Do **not** leave status `ready` with previous phone’s unsuperseded rows.

Optional hardening (recommended):

- Soft-quarantine or delete previous installation’s sparse source-keyed rows that will not
  be re-sent (or require full re-import before any MCP read — already forced by status).

Timezone change already bumps version and forces re-import for day-bucketed data; keep that.

---

## 7. iOS pipeline

### 7.1 Components (fewer than today)

| Component | Responsibility |
|-----------|----------------|
| `HealthKitClient` | Auth, observers, anchors, statistics, sample queries |
| `HealthKitSyncEngine` | Read HK → dirty/index → enqueue ops → advance cursor in same SQLite txn as enqueue |
| `HealthKitOutboxStore` | Single GRDB store (above schema) |
| `HealthKitSyncWorker` | Serialize drain of `pending_ops` |
| `HealthKitBackgroundCoordinator` | Observers + BGTask nudge only |
| Session/auth provider | Token + config for background |

Delete dual `HealthKitSyncStateStore` durable role (UserDefaults anchors/ledgers). UI view
models read from outbox diagnostics + API status only.

### 7.2 Triggers

1. Manual “Sync now”
2. App foreground / profile resume
3. HealthKit observer
4. BG processing task when outbox non-empty

All paths only **nudge** the same engine + worker. No second upload path.

### 7.3 First import vs incremental

**First import / re-import (`never_synced` or `error` recovery):**

1. Open import session (server freezes 90-day range).
2. For each scope in group, query HealthKit for the range and materialize natural-key ops.
3. Enqueue all ops; drain until empty.
4. Complete session → group `ready`.
5. Establish anchors after successful materialize of the window (cursor advanced only after
   durable local enqueue of observed page, same transaction preferred).

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

### 8.1 Apply algorithm (simple)

```text
for each op in batch:
  if op_id known → duplicate
  validate payload + natural key match
  if upsert → UPSERT canonical row by natural key
  if delete → DELETE canonical row by natural key (no-op if missing)
  record short-TTL op receipt
  return applied
```

Optional: one transaction per batch or per small chunk; prefer **not** rolling back already
valid ops when a later op is invalid. Per-op isolation is good; fencing checks (install,
timezone, consent) stay batch-level up front.

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
- [ ] Complete only after full window scanned and outbox drained
- [ ] Failed complete leaves group non-ready

### 9.4 Install / timezone

- [ ] New installation with replace → groups not ready until re-import
- [ ] No ghost “ready” data from previous phone after replace
- [ ] Timezone change → day-bucketed metrics re-imported under new version

### 9.5 Concurrency

- [ ] Observer + manual sync + BG task do not double-corrupt local state
- [ ] Only one drain loop mutates in_flight claims

### 9.6 Accuracy samples

- [ ] Manual BP entry in Health → appears once in DB
- [ ] Watch steps for a day → hour buckets match Health totals within known aggregation rules
- [ ] Sleep across midnight → assigned to correct local sleep day in health timezone

---

## 10. Migration / cutover plan

1. **Freeze** new features on the old protocol (no more manifest/version edge cases).
2. **Add** v2 ops batch + simplified status alongside or as clean replacement migration
   (prefer clean replacement if no production users depend on old tables).
3. **Replace** iOS HealthKit services with single-store engine/worker against v2.
4. **Drop** dual UserDefaults durable state.
5. **Force** re-import on first launch of new client (simplest correctness).
6. **Prune** metric enablement to the milestone set.
7. **Soak** on personal device for real days: manual entries, Watch auto data, deletes,
   airplane mode, force-quit mid-sync, reinstall.
8. Only then expand metrics.

Database: one migration that drops unused protocol tables after cutover, keeps canonical
health tables, and introduces short-TTL op receipts if desired.

---

## 11. Implementation order (correctness-driven, not calendar-driven)

Order is dependency order. Take as long as needed; do not reorder for “demo speed.”

1. **Shared contracts** — natural keys, op payload schemas, group status enum, registry subset.
2. **Postgres** — ensure canonical tables + minimal control tables + op receipt; install
   replace resets readiness; retention job for receipts.
3. **API** — settings, ops batch, simple import session complete/abort, status read;
   withhold helpers on all health reads.
4. **iOS SQLite store** — schema above; no dual store.
5. **Engine** — first import for one group (e.g. vitals BP/glucose only) end-to-end.
6. **Worker** — drain, retry, idempotent ACK.
7. **Expand scopes** — steps hourly, sleep day, daily HR, workouts.
8. **Incremental anchors + deletes** with tests.
9. **Background observers + BGTask** after foreground path is soak-stable.
10. **MCP verification** against ready groups only.
11. **Remove** dead protocol code and docs; single design doc remains this file (or supersedes
    `HEALTHKIT_SYNC_PLAN.md`).

---

## 12. What success looks like

You can say the system is accurate and stable when:

1. You enter or generate health data in Apple Health and it appears in Postgres **once**.
2. You delete it in Health and it disappears or corrects in Postgres.
3. You force-quit, go offline, or retry freely and final DB state matches a clean run.
4. MCP answers only from ready groups and matches those tables.
5. Phone reinstall / replace never silently mixes old and new device history as “ready.”
6. You are not debugging scope manifests, entity versions, or dual ledgers.

---

## 13. Decision summary

| Question | Decision |
|----------|----------|
| Is the current system over-engineered for personal use? | **Yes** (control plane) |
| Does over-engineering improve accuracy here? | **No** — it reduced stability |
| Keep typed aggregates + outbox idea? | **Yes** |
| Keep entity versions / scope hashes / dual stores? | **No** |
| Primary goal of rewrite? | **Accuracy + stability** of Health → DB → MCP |
| Primary model? | **Natural-key upsert + thin outbox + group readiness** |

---

## 14. Related docs

- Supersedes protocol direction in `docs/HEALTHKIT_SYNC_PLAN.md` for the rewrite branch.
- `docs/TECHNICAL_DESIGN.md` HealthKit sections are historical; do not implement from them.
- Older background-sync plans remain historical context only.

When this plan is accepted and implemented, mark `HEALTHKIT_SYNC_PLAN.md` as superseded and
point here as the single source of truth.
