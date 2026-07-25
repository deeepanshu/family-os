# Family OS iOS Background HealthKit Sync Plan

**Status:** Implementation-ready plan

## 1. Outcome

The Family OS iPhone app is the single HealthKit companion for the existing
`/health/api/v1` ingestion API. It asks for explicit group-level consent, reads
only selected HealthKit types, derives final canonical records on-device, and
uploads bounded operations. The API, MCP, Raspberry Pi, and AI clients never
receive a HealthKit credential and never poll Apple Health.

This is a clean cutover. The replacement app clears local anchors and ledgers,
then performs a fresh 90-day repair after the user saves new HealthKit settings.
It does not read, transform, or re-upload prior Family OS HealthKit data.

## 2. Consent Groups and HealthKit Types

| Group | Read scope | On-device output |
| --- | --- | --- |
| Activity | steps, distance, flights, active energy, exercise/stand time, VO2 max | hourly steps and daily aggregates |
| Sleep | sleep analysis, wrist temperature, breathing disturbances | daily total and stage breakdown |
| Vitals | heart rate variants, HRV, respiratory rate, oxygen saturation, temperature, glucose, BP | daily aggregates plus clinical readings |
| Body | weight, BMI, body fat, lean mass, waist | daily latest values |
| Mobility | walking metrics, steadiness, falls | daily aggregate/latest values |
| Workouts | HKWorkout summaries | summary rows only; never routes |
| Mindfulness and environment | mindful session, UV, headphone audio exposure | daily aggregates |
| Nutrition | water, caffeine, alcohol, all allowlisted nutrient quantities | daily nutrient totals |

The app does not request routes, location series, ECG/heartbeat waveforms,
audiograms, clinical records, medication data, reproductive/sexual health, or
identity characteristics. Unsupported values remain outside the permission
request and cannot be uploaded.

The consent UI uses group toggles with a short explanation of the data category
and its Family OS/MCP use. There is no single misleading “all HealthKit data”
toggle. Disabling a group immediately stops observers and causes later uploads
for that group to be rejected by the API.

## 3. Metric Registry

One shared, versioned metric registry drives the iOS app and API. Every metric
entry specifies:

- consent group and HealthKit type;
- canonical metric key and unit;
- daily aggregation (`sum`, `average`, `min_max_average`, or `latest`),
  individual-reading, interval, or workout-summary behavior;
- repair range and local-calendar semantics;
- observer/background-delivery eligibility; and
- MCP view shape and maximum query range.

The app must not derive metric names from HealthKit identifiers at runtime.
Unknown types are ignored locally and rejected by the API.

## 4. Time, Deduplication, and Source Selection

- Instants use UTC. The server-owned profile health timezone determines local
  daily buckets and does not change automatically while travelling.
- Steps remain UTC hourly buckets.
- Sleep is assigned to the profile-local day on which the interval ends.
  `core`, `deep`, `REM`, and `asleepUnspecified` are kept separately; total
  asleep is the union of asleep intervals, not a sum of overlapping samples.
- Each repair considers only the latest 90 days.
- The device-local ledger records only enough source UUID-to-canonical-bucket
  information to recompute an explicit deletion. It is encrypted, stays on the
  device, expires after 90 days, and is never logged or uploaded.
- The source-selection policy is deterministic: prefer Apple Watch/Apple
  Health samples where equivalent samples overlap, then use the highest-priority
  permitted source. The policy never sums overlaps from two apps.

## 5. Sync Lifecycle

1. The signed-in user saves their group selections, consent version, health
   timezone, and Keychain installation ID.
2. The API accepts the settings only for the user's linked Self profile and
   returns the active groups and timezone version.
3. The app requests HealthKit read authorization for exactly the selected
   types, registers supported observers, and enables best-effort background
   delivery.
4. A foreground 90-day repair runs per group. It uploads final typed records
   in idempotent chunks and completes each repair only after every chunk is
   acknowledged.
5. Incremental anchored changes recompute only affected canonical buckets.
   The app advances each anchor only after the matching upload succeeds.
6. If a deletion cannot be mapped from the local ledger, the group becomes
   repair-needed; the app does not guess from an empty query.

Some HealthKit types do not support background delivery. The app registers
observers only where Apple supports them and otherwise refreshes on the next
foreground launch or another relevant observer event. The UI never promises a
polling frequency or immediate delivery.

## 6. UI and Failure Behavior

The HealthKit section shows consent groups, health timezone, a save action,
per-group status, and a foreground sync action. It does not repeat the already
visible profile name or generic HealthKit availability row.

Status is factual and redacted: `Not started`, `Repairing`, `Ready`, `Repair
needed`, or `Error`. A successful empty result means no readable values were
found; it never means Apple granted or denied a particular read permission.

Network failure leaves the anchor and repair progress intact. The app retries
while awake, at the next relevant HealthKit event, and on foreground launch.
Authority/configuration errors stop blind retries and refresh the settings.

## 7. Delivery Order

1. Add the shared registry, clean-cutover migration, API validation, canonical
   repositories, and MCP view registry.
2. Implement Sleep end to end, including stages and existing sleep totals.
3. Implement Activity, Vitals, and Body.
4. Implement Mobility, Workouts, Mindfulness/Environment, and Nutrition.
5. Deploy the compatible API, run the destructive migration, install the app,
   reselect consent groups, and complete the initial repair before enabling MCP
   views for each group.

## 8. Verification

Physical-iPhone tests must cover group-level permission requests, sleep stage
aggregation, duplicate-source handling, a full repair, anchored additions and
deletions, app relaunch during a repair, and a health-timezone change. API and
MCP tests must cover metric allowlists, units, bounds, consent, profile and
installation authority, idempotency, coverage withholding, and privacy-redacted
logs.
