# HealthKit Steps and Heart-Rate Plan

Status: Steps implemented; Heart Rate pending Steps device soak
Date: 2026-08-10
Scope: foreground, correctness-first addition of Steps and daily Heart Rate to
the existing HealthKit → API → Postgres → MCP path.

## 1. Precedence and constraints

This document is the implementation source of truth for Steps and Heart Rate.
It supplements `HEALTHKIT_CORRECTNESS_FIRST_SYNC_PLAN.md`; that document still
controls the correctness constraints, outbox, natural-key, installation, and
timezone rules.

For these two metrics, this document supersedes the fixed three-metric mapping
in `HEALTHKIT_SYNC_AND_MCP_PRODUCT_PLAN.md`. It does not authorize unrelated
HealthKit expansion.

The release remains deliberately narrow:

- no raw heart-rate uploads or storage;
- no new entity versions, manifests, scope-state table, or second local ledger;
- no incremental anchors, deletes, observer expansion, or background import in
  this work;
- no active energy, exercise time, resting HR, HRV, or other registry metrics.

## 2. Locked product model

The app continues to present and synchronize group-level HealthKit controls.

| App row | Group | v1 scopes | Storage | MCP metrics after group is ready |
| --- | --- | --- | --- | --- |
| Activity (Steps) | `activity` | `steps` | UTC hourly buckets | `steps` |
| Vitals (Blood pressure and heart rate) | `vitals` | `blood_pressure`, `heart_rate` | BP source rows; HR local-day statistics | `blood_pressure`, `heart_rate` |
| Sleep | `sleep` | unchanged | unchanged | `sleep` |
| Workouts | `workouts` | unchanged | unchanged | `workout` |

Steps is not part of Workouts, Sleep, or Vitals. It has its own toggle, Import
history action, Sync action, readiness state, and API group.

Vitals is one group. Its Import history and Sync actions fetch BP and Heart Rate
sequentially over the same server-supplied range. The group becomes ready only
after both scopes have completed reading, all their pending operations have been
acknowledged, and run completion succeeds. During a Vitals import, MCP withholds
both BP and Heart Rate rather than presenting a half-upgraded group.

## 3. Canonical data contracts

### 3.1 Steps

- Group and scope: `activity` / `steps`.
- Payload: `steps_hour` with `hourStartUtc` and integer `count`.
- Natural key: `steps_hour:<ISO UTC hour start>`.
- Canonical key: `(person_id, hour_start_utc)` in `health_step_hours`.
- Unit: `HKUnit.count()`.
- The adapter uses UTC calendar-hour boundaries and HealthKit's aggregate for
  the bucket. It does not source-rank phone, Watch, or manually entered records.
- It enqueues only observed non-zero buckets. A missing hour is not manufactured
  as a zero, because an empty or permission-limited HealthKit read must never
  overwrite existing truth with zero.

`HKStatisticsCollectionQuery` is the preferred query shape. It must be anchored
to whole UTC hours and configured with a one-hour interval. The server already
validates UTC hour boundaries and upserts this payload shape.

### 3.2 Heart Rate

- Group and scope: `vitals` / `heart_rate`.
- Payload: `daily_metric` with `healthMetric: "heart_rate"`, `localDay`,
  `averageValue`, `minimumValue`, `maximumValue`, `latestValue`, and
  `sampleCount`.
- Natural key: `daily_metric:heart_rate:<localDay>`.
- Canonical key: `(person_id, metric_key, local_day, timezone_version)` in
  `health_daily_metrics`.
- Unit: `bpm`, made with a safe composed HealthKit unit rather than parsing a
  compound unit string.
- The local day is the sample end time expressed in the profile's
  `healthTimezone`; `timezoneVersion` remains server-owned.

Heart Rate is uploaded only as one daily statistic row. A bounded on-device
sample pass is nevertheless required to derive `latestValue` and `sampleCount`,
which `HKStatisticsCollectionQuery` does not provide. Statistics collection may
derive min/average/max, but the final row must reflect the same local-day sample
set. Raw samples never leave the iPhone or enter Postgres.

An empty Heart Rate range is valid: it creates no daily rows and is not evidence
of denied read access. Do not invent a read-permission oracle.

## 4. Readiness, errors, and UI

- Add `activity` to the implemented foreground product set and fixed Sync-all
  order after Vitals, Sleep, and Workouts.
- Add the Step Count type only when Activity is enabled.
- Vitals authorization requests BP types and Heart Rate whenever Vitals is
  enabled, even when BP has no readings.
- The user-visible rows are `Activity (Steps)` and
  `Vitals (Blood pressure and heart rate)`, not misleading generic labels.
- One bad query/bucket/day must not crash the process or lose pending operations.
  For a first import, however, an unresolved Steps or Heart-Rate coverage hole
  fails the run and leaves its group non-ready; it cannot be silently skipped.
- MCP uses an explicit app mapping, never broad registry expansion. In
  particular, enabling Vitals must not expose glucose, HRV, temperature, or
  other unimplemented `vitals` registry keys.

## 5. Existing-user Vitals upgrade

Steps is a new group and therefore gets a normal first 90-day Activity import.

Heart Rate expands an already-ready Vitals group, so an existing BP user must do
a one-time 90-day Vitals re-import. That run re-upserts BP under its existing
natural keys and inserts daily Heart Rate rows. It does not delete canonical BP
or HR rows.

The server rollout must reset Vitals history completion, coverage, and readiness
for the affected user before this import. It must not reset Sleep, Workouts, or
Activity. The reset is not allowed to let a legacy BP-only app complete Vitals
again: deployment must require the updated client capability for Vitals writes
before globally invalidating existing Vitals readiness. This is a release gate,
not a new long-lived protocol state machine.

After reset, MCP withholds BP and Heart Rate until the updated app completes the
combined foreground import. This temporary withholding is the accepted
consequence of one group-level readiness contract. Keeping BP readable while HR
is incomplete would require separate scope readiness and is explicitly out of
scope.

## 6. Delivery order and acceptance gates

1. Add/update contract tests and documentation. Steps' TypeScript/API contract
   already exists; add the missing Swift `daily_metric` wire encoding/decoding
   for Heart Rate.
2. Implement foreground Activity/Steps: adapter, UTC aggregation, auth type,
   fetch dispatch, product/UI map, explicit MCP allowlist, and API idempotency
   tests.
3. Soak Steps on a physical iPhone: 90-day import, routine sync, offline/kill
   during upload, empty range, UTC day boundary, and Watch/Health aggregate
   comparison.
4. Implement foreground composite Vitals: Heart-Rate adapter and daily local
   aggregation, combined fetch/enqueue, wire/API/MCP tests, and the safe
   existing-user upgrade gate.
5. Soak combined Vitals on a physical iPhone: BP regression, dense Watch HR,
   local-day/timezone boundary, empty HR, interrupted upload, and MCP
   withholding while the group is syncing.

Only after both foreground soaks are boring may a separate plan introduce
anchored incremental recomputation, safe observed-delete handling, and
drain-only background work for these scopes.

## 7. Explicit exclusions

- No full raw Heart Rate series, ECG, GPS, or workout-routed samples.
- No zero-filled Steps buckets from empty reads.
- No repair-manifest extension for Activity or Heart Rate in this work.
- No automatic or background 90-day import.
- No registry-wide consent, upload, or MCP read enablement.
