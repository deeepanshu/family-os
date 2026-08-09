# HealthKit Sync and MCP Product Implementation Plan

Status: Product decisions locked; implementation pending unless noted otherwise
Date: 2026-08-08
Scope: Family OS iOS Health Data UI, foreground/background HealthKit execution,
Health API lifecycle and reconciliation contracts, and the read-only health MCP

## 1. Purpose and precedence

This document is the implementation source of truth for the HealthKit sync UX
and the MCP health-data surface described below.

If an older HealthKit or MCP design document conflicts with this plan on any of
these topics, this plan wins:

- `Import history` versus `Sync` behavior.
- Per-metric and `Sync all enabled` controls.
- Enabled-only HealthKit authorization and execution.
- Save-before-run ordering and UI locking.
- Initial-import completion and interrupted-run display.
- Repair-only deletion behavior.
- MCP data-first reads and response shape.
- The MCP `healthMetric` allowlist.

Older documents may still supply lower-level correctness details that do not
conflict with these decisions, such as natural keys, operation validation,
outbox retry behavior, active-installation fencing, timezone storage, and
privacy-safe observability.

This plan does not authorize implementation by itself. It records the agreed
product behavior and the execution sequence to follow when implementation is
requested.

## 2. Outcomes

The finished product must make these statements true:

1. A first import builds up to 90 days of history once per implemented metric.
2. Routine sync reads only new or recently changed data after that import.
3. A routine sync never performs a hidden 90-day import and never deletes data.
4. A user can explicitly repair the last 90 days, including removal of records
   that no longer exist in Apple Health.
5. A disabled metric is not authorized, queried, uploaded, observed, or included
   in a foreground/background run.
6. Draft settings are saved successfully before any user-triggered run starts.
7. Save and run operations cannot race in the UI or in the app process.
8. The UI shows actual local activity as active progress and treats stale server
   `syncing` state as an interrupted run.
9. MCP returns stored data even while a phone import is incomplete or
   interrupted.
10. MCP exposes only `blood_pressure`, `sleep`, and `workout`, further restricted
    by the user's enabled app toggles.

## 3. Locked vocabulary

### 3.1 User-visible verbs

There are only two user-visible action labels:

- **Import history**: read the last 90 days.
- **Sync**: read new data since the last successful run, with a small overlap.

`Import history` has two contexts:

- First fill: primary action before the metric has completed its first history
  import. It does not delete.
- Manual repair: secondary action after the first fill. It may delete records
  missing from the complete Apple Health snapshot for the repair window.

### 3.2 Run kinds

The implementation may use this internal enum:

```swift
enum HealthKitRunKind {
    case initialImport
    case sync
    case repairImport
}
```

All three kinds use one run module. The kind derives two internal knobs:

| Run kind | Range | `allowDeletes` |
| --- | --- | --- |
| `initialImport` | Last 90 days | `false` |
| `sync` | Last success minus 24 hours through now | `false` |
| `repairImport` | Last 90 days | `true` |

The 24-hour overlap is the v1 default. Re-reading overlap data is safe because
upserts are idempotent by natural key.

### 3.3 Implemented metric mapping

The product exposes these three metric rows and no others in this release:

| App label | Internal HealthKit group | MCP metric |
| --- | --- | --- |
| Blood pressure | `vitals` | `blood_pressure` |
| Sleep | `sleep` | `sleep` |
| Workouts | `workouts` | `workout` |

The broad `vitals` registry group does not mean the app imports every vital.
For this product surface, it means blood pressure only.

## 4. Product behavior

### 4.1 Initial history import

An enabled metric needs an initial import when the server has no recorded
successful full history import for the current active installation and timezone
version.

The action:

1. Saves the current settings.
2. Verifies the metric remains enabled in the canonical saved settings.
3. Requests HealthKit read authorization only for that metric.
4. Reads the authoritative 90-day range returned by the server.
5. Enqueues and uploads idempotent upserts.
6. Does not generate delete operations.
7. Marks the metric ready only after its pending queue is empty.
8. Persists initial-import completion for that metric, installation, and timezone
   version.

An empty successful read is allowed for sleep and workouts. Blood pressure may
retain its existing actionable empty/permission guidance, but an empty result
must not cause deletion during an initial import.

### 4.2 Routine sync

An enabled metric may sync only after its initial import is complete.

The authoritative range is:

```text
rangeStart = lastSuccessfulAt - 24 hours
rangeEnd   = server now
```

The action:

1. Saves current settings first for a foreground user action.
2. Requests authorization only for the selected enabled metric set.
3. Reads and upserts data in the returned incremental range.
4. Never deletes.
5. Advances `lastSuccessfulAt` only after all pending work for that metric has
   drained and completion succeeds.

Routine foreground and background sync use this same behavior. Background
execution must not retain the current 90-day reimport behavior.

### 4.3 Manual history repair

Manual repair is available only after initial history import is complete.

Before starting, show a confirmation explaining:

> Re-imports the last 90 days and removes Family OS items in that period that no
> longer exist in Apple Health.

The repair action:

1. Saves settings first.
2. Requests authorization only for the selected metric.
3. Reads a complete 90-day snapshot.
4. Uploads all present records as idempotent upserts.
5. Supplies the complete set of present natural keys for the repair window when
   completing the run.
6. Lets the server remove stored keys inside that exact window that are absent
   from the supplied complete-key set.
7. Updates coverage and readiness only after upserts drain and reconciliation
   succeeds.

If the app exits, times out, loses authorization, or fails upload before the
completion request, reconciliation does not occur. This is the deletion safety
barrier. No partial read may delete data.

### 4.4 Sync all enabled

`Sync all enabled` uses this fixed order:

```text
Blood pressure -> Sleep -> Workouts
```

At the start of the action, take an immutable snapshot of the saved enabled set.
Then:

- Run only enabled metrics whose initial import is complete.
- Skip enabled metrics that still need `Import history`.
- Never turn a skipped metric into a hidden full import.
- Continue to later metrics if one metric fails.
- Show the current metric and stage in its row.
- Finish with one summary of successes, failures, and skipped metrics.

Example summary:

> Synced Blood pressure and Workouts. Sleep needs Import history first.

## 5. UI specification

### 5.1 Health Data section

Keep the top-level HealthKit consent control, timezone control, metric toggles,
and save action. Each implemented metric becomes its own row/card with status
and actions.

Conceptual layout:

```text
Health Data

Upload Apple Health data                         [on/off]

Blood pressure                                  [on/off]
Ready - Last synced 8 Aug, 15:42
[Sync]                         [Import history]

Sleep                                           [on/off]
Not started
[Import history]

Workouts                                        [on/off]
Interrupted - try again
[Sync]                         [Import history]

[Sync all enabled]
[Save changes]
```

The exact SwiftUI composition may use rows, disclosure, or grouped controls, but
the state and action hierarchy above must remain obvious.

### 5.2 Per-metric primary and secondary controls

| Metric state | Primary | Secondary |
| --- | --- | --- |
| Enabled, initial import incomplete | `Import history` | None |
| Enabled, initial import complete | `Sync` | `Import history` |
| Disabled | None | None |

The repair `Import history` control should be visually secondary and must show
the deletion confirmation before running.

### 5.3 Display state derivation

The UI state is derived from both local activity and server history:

| Evidence | Display |
| --- | --- |
| Local active run for this metric | Active stage and progress |
| No local run; server status is `syncing` or `backfilling` | `Interrupted - try again` |
| Initial import incomplete | `Not started` |
| Last local attempt failed | Actionable error for the current session |
| Initial import complete and idle | `Ready` plus last successful time |
| Disabled | `Disabled` |

The server status alone never produces a long-lived active spinner.

Recommended interrupted copy:

> Interrupted - try Sync or Import history again.

### 5.4 Progress and feedback

The metric row is the primary progress surface. It should show stages such as:

- Requesting Apple Health access.
- Preparing import or sync.
- Reading Apple Health.
- Uploading.
- Finishing.

Existing foreground stage feedback may remain, but it must not replace the
in-row state. Emit one final success toast/haptic for the overall user action.
Use one actionable failure alert/haptic for failure or partial failure. Do not
emit success feedback for passive background work.

### 5.5 Busy-state rules

`isSavingSettings` and active run state belong in the observable feature model,
not local `@State` inside the view.

While settings are saving:

- Disable all metric toggles.
- Disable timezone changes.
- Disable Save.
- Disable every Sync and Import history action.
- Disable `Sync all enabled`.

While any foreground run is active:

- Disable all metric toggles and timezone changes.
- Disable Save.
- Disable every other run action.
- Keep the active metric row visibly progressing.

Controls re-enable after success or failure. Cancellation is not offered.

### 5.6 Accessibility and empty states

- Every metric action needs a stable accessibility identifier.
- Progress text must be available to VoiceOver and not represented by color
  alone.
- Disabled actions should have visible explanatory copy when the reason is not
  obvious, especially `Import history first` skips.
- Loading settings, settings-load failure, and no Self profile must each have an
  explicit state.

## 6. iOS application design

### 6.1 One deep run module

Create one run module whose external interface hides authorization, range
selection, HealthKit queries, enqueueing, draining, completion, and progress
reporting:

```swift
struct HealthKitRunRequest: Sendable {
    let metric: HealthKitSyncMetric
    let kind: HealthKitRunKind
}

struct HealthKitRunResult: Sendable {
    let metric: HealthKitSyncMetric
    let kind: HealthKitRunKind
    let fetchedCount: Int
    let appliedCount: Int
    let deletedCount: Int
    let rangeStart: Date
    let rangeEnd: Date
}

protocol HealthKitRunning: Sendable {
    func run(_ request: HealthKitRunRequest) async throws -> HealthKitRunResult
}
```

The caller should not need to know which fetcher, endpoint, outbox operation, or
reconciliation shape a metric uses. Tests and UI cross this same seam.

### 6.2 Run policy

The run module enforces these invariants before HealthKit authorization:

1. The requested metric is one of blood pressure, sleep, or workouts.
2. The metric is in the saved canonical enabled set.
3. `initialImport` is used only when initial history is incomplete.
4. `sync` and `repairImport` are used only when initial history is complete.
5. Only `repairImport` may receive `allowDeletes=true` from the server.
6. Only one foreground/background run may execute in the app process at once.

Use one process-wide actor or equivalent serialization primitive as the run
gate. Both foreground commands and background entry points must cross it.

### 6.3 Save-before-run

A user-triggered run is a two-step command:

```text
save draft settings -> receive/apply canonical settings -> run selection
```

The settings save interface must return success or throw. It must not swallow an
error into shared status text and then allow the run to continue.

On save failure:

- Abort before HealthKit authorization.
- Keep the draft visible.
- Show the actionable failure.
- Do not change local background configuration.

On save success:

1. Apply the canonical server response.
2. Persist the canonical enabled set, installation, profile, timezone, and
   timezone version to the local sync store.
3. Reconcile background observers and delivery with that enabled set.
4. Only then allow the requested foreground run to start.

If local configuration or observer reconciliation fails after the server save,
abort the run and show an error. A server-only save is not sufficient proof that
the local execution state matches the UI.

### 6.4 Immutable selection

At command start, capture the selected enabled metrics after save. Do not replace
that set with `status.enabledGroups` later in the run, and do not fall back to a
broader server group list when replacing an installation.

The installation replacement request must use the saved UI selection. This
prevents disabled groups from being restored by a stale server response.

### 6.5 Metric query interfaces

Each HealthKit adapter must accept an explicit range supplied by the run module:

```swift
fetchBloodPressure(from: Date, through: Date)
fetchSleepDays(from: Date, through: Date, healthTimezone: String)
fetchWorkouts(from: Date, through: Date)
```

No metric adapter may contain an unconditional 90-day default used by every
call. The run kind owns range selection.

For repair imports, adapters must also return the complete natural-key set for
the exact range. For routine sync and initial import, no missing-key deletion is
generated.

### 6.6 Local store

The existing local sync store remains the durable queue and configuration
source. Add only state needed for this product contract:

- Canonical enabled groups.
- Per-group initial-history completion as returned by the server.
- Per-group last successful time and completed coverage.
- Per-group local active/failed display state as needed for the current process.
- Pending natural-key upsert/delete operations.

Do not introduce a second outbox, repair ledger, anchor engine, or parallel sync
coordinator for these behaviors.

### 6.7 Background execution

Background execution is routine `Sync`, never `Import history`:

- Run only saved enabled metrics.
- Skip metrics whose initial import is incomplete.
- Use the same 24-hour-overlap incremental range.
- Never delete.
- Never show authorization UI.
- Never emit foreground success toasts.
- Serialize through the same run gate as foreground work.

On settings save and app launch:

- Rebuild observers for the canonical enabled set.
- Stop observer queries for disabled metrics.
- Disable HealthKit background delivery for types no longer enabled when
  supported by the chosen HealthKit adapter behavior.
- Do not query a disabled metric merely because it remains in an older local
  configuration.

## 7. Health API contract

### 7.1 Persisted group state

Each person/group state needs to distinguish completed history from the latest
attempt label. Additive fields should include the equivalent of:

```text
history_import_completed_at
history_import_installation_id
history_import_timezone_version
last_successful_at
last_attempt_at
last_error_code
coverage_start_at
coverage_end_at
status
```

`needsInitialImport` is true when no completed history marker matches the active
installation and timezone version. Do not derive it from `status == ready`
alone.

Disabling a metric does not delete its rows or its completion marker. Re-enabling
it on the same installation/timezone can resume routine sync. Replacing the
active installation or changing the relevant timezone version invalidates the
completion marker and requires a new non-deleting initial history import.

### 7.2 Begin contract

Use one generic begin operation for all run kinds. The wire route may be named to
fit current routing conventions, but its behavior must be equivalent to:

```http
POST /healthkit/groups/:group/runs/begin
```

```json
{
  "installationId": "uuid",
  "personId": "uuid",
  "timezoneVersion": 1,
  "kind": "initial_import | sync | repair_import"
}
```

The server validates authorization, Self profile, active installation, enabled
group, timezone version, and allowed state transition. It returns the
authoritative descriptor:

```json
{
  "group": "vitals",
  "kind": "sync",
  "rangeStartAt": "ISO-8601",
  "rangeEndAt": "ISO-8601",
  "allowDeletes": false
}
```

The server derives the range and delete permission. It does not trust
client-supplied range or deletion authority.

Beginning a run may record `lastAttemptAt` and server status, but must not
overwrite previously completed coverage. Coverage changes only on successful
completion.

### 7.3 Operation batch

Retain the existing natural-key operation batch and its idempotent apply rules.
Every operation remains group-scoped and active-installation fenced.

- Initial import: upserts only.
- Sync: upserts only.
- Repair import: upserts first; reconciliation deletes happen at completion.

Individual client-supplied delete operations must not become a way to bypass the
repair-only rule. If the current operation contract accepts deletes, the server
must require repair completion context or move missing-key deletion entirely
inside repair reconciliation.

### 7.4 Completion and repair reconciliation

Use one generic completion operation equivalent to:

```http
POST /healthkit/groups/:group/runs/complete
```

For initial import and sync, the body contains installation, person, timezone,
kind, and the authoritative range returned by begin.

For repair import, it also contains the complete present-natural-key manifest
for the repair window. The server transaction:

1. Revalidates authorization, enabled group, installation, timezone, kind, and
   exact 90-day repair window.
2. Confirms the request explicitly declares a complete snapshot.
3. Deletes stored natural keys inside the window that are absent from the
   manifest.
4. Leaves records outside the window untouched.
5. Marks initial history complete when appropriate.
6. Updates last success and completed coverage.
7. Returns applied/deleted counts and canonical group state.

The manifest may be empty because a user can legitimately have no matching
Apple Health records. Deletion remains safe because it occurs only after the
explicit repair confirmation, successful complete read, successful upload
drain, and completion request.

The completion operation must be idempotent. Repeating the same complete request
produces the same final database state.

### 7.5 Failure behavior

Do not add a `/fail` endpoint.

If the client disappears after begin:

- The server may retain `syncing` as the last-written attempt state.
- Previously completed coverage and `lastSuccessfulAt` remain intact.
- MCP continues returning stored rows.
- The idle app displays `Interrupted`, not active progress.
- The next successful run clears the stale state by completing normally.

### 7.6 Settings contract

The settings response must include, per implemented metric:

- Enabled state.
- Server attempt status.
- `needsInitialImport` or the fields required to derive it without ambiguity.
- `lastSuccessfulAt`.
- Completed coverage.
- Last error code when useful to the app.

The app must not infer that an enabled broad group means every registry metric is
implemented.

## 8. MCP contract

### 8.1 Role

The MCP is a bounded, read-only warehouse adapter over authenticated Family OS
data. It does not start, stop, wait for, or repair phone sync.

It must continue to enforce:

- OAuth client allowlist.
- Active connection grant and `health_read` capability.
- Authenticated user and server-derived family access.
- Authorized opaque `personId` values.
- Per-profile metric consent.
- Range, row-count, timeout, response-size, rate-limit, and audit controls.

Never trust a model-supplied `family_id`. A supplied `personId` remains untrusted
until server-side authorization succeeds.

### 8.2 Fixed product allowlist

The complete MCP `healthMetric` allowlist for this release is:

```text
blood_pressure
sleep
workout
```

The `get_health_data.healthMetric` JSON schema enum must contain exactly those
three values. Do not build it from every key in `HEALTHKIT_METRIC_REGISTRY`.

This fixed schema is the product capability set. User settings apply a second,
runtime filter:

| Enabled app toggle | MCP metric available |
| --- | --- |
| Blood pressure / `vitals` | `blood_pressure` only |
| Sleep / `sleep` | `sleep` only |
| Workouts / `workouts` | `workout` only |

Enabling `vitals` must not advertise or authorize heart rate, glucose,
temperature, oxygen saturation, respiratory rate, or any other broad-registry
metric.

MCP tool schemas should remain stable across users. The per-user enabled subset
is returned by `list_authorized_profiles.availableMetrics` and enforced again by
`get_health_data` at call time.

### 8.3 Data-first reads

For an authorized and enabled metric:

- Query and return stored rows in the requested range.
- Do not return an empty payload solely because server status is `syncing`,
  `error`, `never_synced`, or interrupted.
- Do not wait for the phone.
- Do not expose phone authorization or online state.

Disabling a metric still denies new MCP reads for that metric. This is access
control, not lifecycle gating.

### 8.4 Response shape

Remove from both shared result types and every result branch:

- `disclaimer`
- `metricSyncStatus`

Keep:

- Authorized `personId`.
- `healthMetric`.
- Metric-specific data payload.
- Unit and view type.
- Health/presentation timezone fields where relevant.
- Coverage metadata.
- `lastSyncedAt` sourced from the last completed successful run.

`list_authorized_profiles` must also stop returning a response disclaimer.

Tool descriptions should describe the data and bounds concisely without
repeating response boilerplate.

### 8.5 Coverage semantics

Coverage describes completed stored coverage, not the current phone attempt.

- `availableStart` and `availableEnd` come from the last successfully completed
  coverage window.
- Beginning an import does not expand or replace them.
- `complete` compares the requested range to completed coverage and is not set
  false merely because a newer attempt is in progress or interrupted.
- `daysWithData` describes actual returned buckets/rows. Sparse metrics may have
  fewer data days even when the imported range is complete.

This preserves useful freshness without reintroducing sync lifecycle noise.

### 8.6 MCP connection flow unchanged

This plan does not redesign OAuth or connection grants. The existing remote MCP,
OAuth audience/client validation, connection consent, revocation, authorization,
and auditing remain in force. The change here is the health-data product
contract and metric surface.

## 9. Current implementation gaps

The implementation must reconcile these known mismatches:

| Area | Current behavior | Required behavior |
| --- | --- | --- |
| UI actions | One global `Sync now` | Per-metric Import/Sync plus Sync all |
| UI busy state | Save busy is local view state; Sync is not locked by Save | Shared save/run state locks all conflicting controls |
| First-import state | Mostly inferred from broad server status | Explicit completed-history marker |
| Foreground range | Every metric fetcher hardcodes 90 days | Range supplied by the shared run module |
| Foreground settings | Run reloads and may reuse server enabled groups | Save UI intent, snapshot it, and run only that set |
| Background range | Bounded background run reimports 90 days | Incremental Sync only |
| Background configuration | Save does not refresh local config/observers | Save updates local config and observer set |
| Disabled metrics | Stale local groups/observers may still authorize/query | No auth, query, upload, observer, or run |
| Server begin | `start-import` always creates a 90-day syncing window | Generic begin returns kind-specific authoritative range |
| Coverage | Attempt start can write coverage before success | Only completion updates completed coverage |
| Repair | No complete-window missing-key reconciliation | Repair completion performs bounded key diff |
| Idle stale status | Server `syncing` renders as Syncing | Idle app renders Interrupted |
| MCP schema | Enum comes from nearly the full HealthKit registry | Exactly BP, sleep, workout |
| MCP availability | Broad group enables unrelated metrics | Explicit three-entry app-to-MCP mapping |
| MCP payload | Includes disclaimer and `metricSyncStatus` | Remove both; retain data, coverage, `lastSyncedAt` |

Primary files likely involved include:

- `apps/ios/FamilyOS/Views/HealthKitSyncView.swift`
- `apps/ios/FamilyOS/ViewModels/HealthKitSyncStateViewModel.swift`
- `apps/ios/FamilyOS/ViewModels/HealthBootstrapHealthKitViewModel.swift`
- `apps/ios/FamilyOS/Services/HealthKit/HealthKitSyncCoordinator.swift`
- `apps/ios/FamilyOS/Services/HealthKit/HealthKitBackgroundSync.swift`
- `apps/ios/FamilyOS/Services/HealthKit/HealthKitSyncStore.swift`
- `apps/ios/FamilyOS/Services/HealthKit/HealthKitBloodPressureSync.swift`
- `apps/ios/FamilyOS/Services/HealthKit/HealthKitSleepDaySync.swift`
- `apps/ios/FamilyOS/Services/HealthKit/HealthKitWorkoutSync.swift`
- `apps/api/src/routes/healthKit.ts`
- `apps/api/src/repositories/postgres/healthKitStore.ts`
- `packages/shared/src/healthkitOps.ts`
- `packages/shared/src/index.ts`
- `apps/api/src/mcp/createMcpServer.ts`
- `apps/api/src/mcp/HealthMcpReadService.ts`

## 10. Implementation sequence

### Phase 1: Freeze shared contracts

1. Add the explicit three-metric MCP product allowlist.
2. Narrow `get_health_data.healthMetric` to that allowlist.
3. Remove MCP disclaimer and metric status from shared result types.
4. Add run kind, begin/complete result types, and explicit initial-import state.
5. Add contract tests before changing adapters.

Exit criteria:

- Shared types express all locked behavior.
- No caller can accidentally expose the full HealthKit registry through MCP.

### Phase 2: Health API state and run contract

1. Add the initial-history completion fields through an additive migration.
2. Implement generic begin range derivation.
3. Ensure begin does not mutate completed coverage.
4. Implement idempotent completion.
5. Implement repair-only missing-key reconciliation.
6. Preserve all existing authorization, Self profile, enabled-group,
   active-installation, timezone, validation, and audit checks.

Exit criteria:

- API integration tests prove initial, sync, and repair semantics.
- No failed or abandoned run can delete or falsely expand coverage.

### Phase 3: MCP correction

1. Use the fixed `blood_pressure | sleep | workout` schema enum.
2. Replace broad registry group expansion with the explicit app mapping.
3. Enforce the enabled subset again in `get_health_data`.
4. Remove disclaimer and `metricSyncStatus` from all result branches and profile
   listing.
5. Keep data-first tests for in-progress/interrupted state.
6. Update coverage semantics to use completed coverage.

Exit criteria:

- MCP discovery shows only three health metrics.
- Enabling Blood pressure never advertises heart rate or glucose.
- Stored rows remain visible during an interrupted import.

### Phase 4: iOS run module and metric adapters

1. Introduce the one shared run interface.
2. Make each metric fetcher accept an explicit range.
3. Route initial import, sync, and repair through the same module.
4. Add repair natural-key manifests.
5. Add the process-wide run gate.
6. Make save return/throw a result suitable for command composition.

Exit criteria:

- Unit tests exercise all run kinds through the shared interface.
- A second routine run demonstrably does not query 90 days.

### Phase 5: Background alignment

1. Convert background work to incremental Sync only.
2. Skip initial-import-required metrics.
3. Update local configuration immediately after settings save.
4. Reconcile observer queries and background delivery on save and launch.
5. Ensure foreground and background calls share the same run gate.

Exit criteria:

- Disabling Sleep prevents later Sleep authorization/query/upload attempts.
- Background execution never deletes or starts a history import.

### Phase 6: SwiftUI product surface

1. Move save/run state into the observable feature model.
2. Add per-metric primary and secondary actions.
3. Add repair confirmation.
4. Add sequential `Sync all enabled` and skipped-metric summary.
5. Render local stages per metric.
6. Map idle server syncing/backfilling to Interrupted.
7. Add accessibility identifiers and state fixtures/previews.

Exit criteria:

- Every enabled metric has the correct action for its history state.
- Save and run controls cannot race.
- No idle row displays an eternal active spinner.

### Phase 7: Deployment and release

1. Deploy additive database migration and API changes first.
2. Deploy the MCP restriction and response cleanup with the API.
3. Verify remote OAuth discovery, connection grant, profile listing, and all
   three metric calls in staging/production as appropriate.
4. Release the iOS UI and run behavior after API compatibility is confirmed.
5. Validate on a physical iPhone; Simulator is not proof of HealthKit background
   delivery.
6. Push a new `release/` tag only after the intended commit is on `main`.
7. Observe Crashlytics and privacy-safe sync telemetry before removing any
   temporary compatibility route.

## 11. Test plan

### 11.1 Shared and MCP unit tests

- `MCP_HEALTH_METRICS` equals exactly:
  `blood_pressure`, `sleep`, `workout`.
- MCP input schema contains exactly those enum values.
- `vitals` maps to `blood_pressure` only.
- Disabled Blood pressure removes `blood_pressure` from profile availability.
- Enabling Blood pressure does not expose heart rate, glucose, temperature, or
  oxygen saturation.
- Unknown or previously registry-derived metrics are rejected.
- Result types contain no `disclaimer` or `metricSyncStatus`.
- Results retain `lastSyncedAt` and coverage.

### 11.2 MCP integration tests

- Authorized stored BP, sleep, and workout rows are returned.
- Stored rows are returned while server state is `syncing`.
- Stored rows are returned while server state is `error` or stale/interrupted.
- Disabled-group reads fail closed.
- Guessed, stale, cross-family, and unauthorized `personId` values fail.
- Revoked or unallowlisted OAuth clients fail.
- Audit metadata contains no health values.

### 11.3 API run tests

- Initial import returns a 90-day range and `allowDeletes=false`.
- Sync before initial completion is rejected.
- Sync after initial completion uses last success minus 24 hours.
- Routine sync cannot delete.
- Repair before initial completion is rejected.
- Repair returns a 90-day range and `allowDeletes=true`.
- Repair completion removes only absent keys inside its exact window.
- Repair leaves keys outside the window untouched.
- Initial import with an empty manifest deletes nothing.
- App termination before repair completion deletes nothing.
- Replayed completion is idempotent.
- Begin does not alter completed coverage or last success.
- Successful completion updates readiness, last success, and coverage.
- Installation replacement/timezone invalidation produces
  `needsInitialImport=true` as specified.

### 11.4 iOS module tests

- Save failure aborts before HealthKit authorization.
- The authorization set equals enabled intersection selected.
- A disabled metric never reaches its HealthKit adapter.
- Initial import requests 90 days with no deletes.
- Sync requests the incremental range with no deletes.
- Repair requests 90 days and sends a complete key manifest.
- `Sync all enabled` follows BP -> Sleep -> Workouts.
- Metrics needing initial import are skipped, not imported.
- One metric failure does not prevent later eligible metrics.
- Foreground and background runs serialize.
- Settings save updates local background configuration.
- Disabling a metric removes its observer/query path.

### 11.5 SwiftUI tests and previews

Cover at least:

- Loading settings.
- Settings failure.
- Disabled metric.
- Needs initial import.
- Ready.
- Active initial import.
- Active routine sync.
- Active repair.
- Interrupted server state.
- Per-metric failure.
- Save busy.
- Sync-all partial success and skip summary.

### 11.6 Physical-device release checks

On a signed Release build installed on a physical iPhone:

1. Enable only Workouts and confirm no BP/Sleep authorization or query telemetry.
2. Perform first Workout Import history and confirm a 90-day non-deleting run.
3. Perform Workout Sync and confirm the requested range is incremental.
4. Enable BP and Sleep, then verify each has its own first-import requirement.
5. Start a run, terminate the app after server begin, relaunch, and confirm
   `Interrupted` rather than `Syncing`.
6. Disable Sleep, save, and confirm later observer/background paths do not touch
   Sleep.
7. Run repair against a controlled deleted Apple Health record and confirm only
   that in-window record disappears from Family OS.
8. Connect the MCP and confirm tool discovery lists only BP, Sleep, and Workout.
9. Query stored data during an interrupted phone run and confirm MCP still
   returns it with coverage and `lastSyncedAt`.

## 12. Observability

Operational telemetry may record:

- Run kind.
- Metric/group.
- Stage.
- Requested range duration.
- Fetched/applied/deleted counts.
- Pending count.
- Duration and timeout stage.
- Error code.
- Foreground/background trigger.

Do not log health values, natural keys, raw payloads, OAuth tokens, or profile
names. MCP audits retain caller/client/tool/profile authorization metadata but no
returned health values.

Metrics should distinguish API and MCP traffic so latency dashboards do not mix
the two services.

## 13. Explicitly out of scope

Do not build or reintroduce:

- A cancel button or cooperative user cancellation product.
- A `/fail` lifecycle endpoint.
- MCP tools that trigger phone sync or wait for it.
- MCP empty-on-syncing behavior.
- Hidden 90-day work under a `Sync` label.
- Automatic deletion during routine/background sync.
- A second sync engine, second outbox, repair-session ledger, or multi-phase
  anchor architecture solely for this UX.
- Metrics beyond Blood pressure, Sleep, and Workouts in this release's app or MCP
  surface.
- A model-supplied `family_id` trust path.

## 14. Definition of done

This plan is complete only when all of the following are true:

- Per-metric UI behavior matches the locked table.
- `Sync all enabled` is sequential and never hides imports.
- Save-before-run is mandatory and failure stops the run.
- Save and run states lock every conflicting control.
- Foreground and background execution use enabled-only selections.
- Background work is incremental and non-deleting.
- Initial-history completion is explicit and survives ordinary status changes.
- Repair deletion is bounded, complete-snapshot-based, and completion-gated.
- Idle stale server work renders as Interrupted.
- MCP discovery exposes exactly BP, Sleep, and Workout.
- MCP runtime availability matches enabled app toggles.
- MCP returns stored data regardless of import lifecycle.
- MCP responses omit disclaimer and metric status while keeping coverage and
  `lastSyncedAt`.
- Automated tests pass.
- A physical-device Release build proves foreground/background behavior.
- The API/MCP deployment and tagged iOS release are verified in the intended
  environment.
