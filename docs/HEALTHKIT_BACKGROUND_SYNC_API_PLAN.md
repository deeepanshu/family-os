# Family OS HealthKit Background Sync API Plan

**Status:** Implementation-ready plan

## 1. Outcome

Keep the existing authenticated `/health/api/v1/healthkit` API and replace its
three-metric implementation with complete, privacy-bounded HealthKit support.
The iPhone remains the only HealthKit client and only writer. The API stores
canonical Family OS records; MCP is a read-only, bounded consumer.

This is a clean cutover. Existing HealthKit data, repair state, and current
HealthKit tables are deleted during the production migration. Nothing is copied
from them. The replacement app imports the latest 90 days after the user
re-enables the desired consent groups.

## 2. Supported Data

| Consent group | HealthKit scope | Canonical shape |
| --- | --- | --- |
| Activity | steps, walking/running distance, flights, active energy, exercise, stand, VO2 max | hourly steps; daily numeric aggregates |
| Sleep | total, core, deep, REM, unspecified asleep, awake, in-bed, wrist temperature, breathing-disturbance events | structured local sleep-day record |
| Vitals | heart rate, resting/walking heart rate, HRV, respiratory rate, oxygen saturation, body temperature, glucose, blood pressure | daily numeric aggregates; individual glucose and BP readings |
| Body | weight, BMI, body fat, lean mass, waist | daily latest numeric values |
| Mobility | walking speed, step length, asymmetry, double support, steadiness, falls | daily aggregate or daily latest numeric values |
| Workouts | type, start/end, duration, energy, distance, heart-rate summary | workout summary |
| Mindfulness and environment | mindful minutes, UV, headphone audio exposure | daily numeric aggregates |
| Nutrition | water, caffeine, alcohol, and Apple Health nutrient quantities | daily nutrient totals |

Routes, locations, raw ECG/heartbeat series, audiograms, clinical documents,
medications, reproductive/sexual health, identity characteristics, and free
text are not stored or exposed. HealthKit may not contain every supported value;
the API reports recorded coverage rather than inventing a value.

## 3. Canonical Storage

The database does not contain a generic JSON sample feed. Metric definitions are
versioned in code and each table has typed, queryable columns.

~~~
healthkit_sync_profile_settings
  person_id, family_id, user_id, consent_version, consented_at,
  health_timezone, health_timezone_version, updated_at

healthkit_sync_groups
  person_id, family_id, group_key, enabled, updated_at
  unique (person_id, group_key)

healthkit_sync_state
  person_id, family_id, group_key, status, last_successful_at,
  last_attempt_at, coverage_start_at, coverage_end_at, last_error_code
  unique (person_id, group_key)

health_daily_metrics
  person_id, family_id, metric_key, local_day, timezone_version, unit,
  sum_value, average_value, minimum_value, maximum_value, latest_value,
  sample_count, updated_at
  unique (person_id, metric_key, local_day, timezone_version)

health_sleep_days
  person_id, family_id, sleep_day, timezone_version,
  total_minutes, core_minutes, deep_minutes, rem_minutes,
  unspecified_asleep_minutes, awake_minutes, in_bed_minutes,
  wrist_temperature_celsius, breathing_disturbance_count, updated_at
  unique (person_id, sleep_day, timezone_version)

health_blood_pressure_readings
  person_id, family_id, source_sample_key, measured_at,
  systolic, diastolic, pulse, updated_at
  unique (person_id, source_sample_key)

health_blood_glucose_readings
  person_id, family_id, source_sample_key, measured_at, value_mg_dl, updated_at
  unique (person_id, source_sample_key)

health_workouts
  person_id, family_id, source_sample_key, workout_type, started_at, ended_at,
  duration_seconds, active_energy_kcal, distance_meters,
  average_heart_rate_bpm, maximum_heart_rate_bpm, updated_at
  unique (person_id, source_sample_key)
~~~

`health_daily_metrics` is only for numeric values with declared aggregation.
It is not a raw payload table and cannot store arbitrary fields. Sleep, clinical
readings, and workouts remain dedicated structured tables because their meaning
cannot be represented safely by one number.

## 4. Ingestion and Repair

The current endpoints remain:

- `PUT /health/api/v1/healthkit/settings`
- `POST /health/api/v1/healthkit/sync`
- `POST /health/api/v1/healthkit/repairs`
- `POST /health/api/v1/healthkit/repairs/{repairId}/complete`

Settings accept explicit enabled consent groups, the linked Self profile, the
installation ID, consent version, and health timezone. A server-side metric
registry expands those groups into allowlisted HealthKit metrics. Clients cannot
upload an unregistered metric key.

Repairs operate per consent group and cover the most recent 90 days. The app
uploads final canonical operations only. A repair never uploads HealthKit XML,
raw sample metadata, source-device details, location, or attachments. While a
group is repairing, MCP withholds that group's records until every repair chunk
is complete.

Operations are a discriminated union with typed validation:

- hourly step replacement;
- daily numeric aggregate replacement;
- structured sleep-day replacement;
- blood-pressure and glucose upsert/delete by source UUID; and
- workout-summary upsert/delete by source UUID.

Each request is transactional, capped at 500 operations, and idempotent by
`(user_id, person_id, sync_id)`. Bulk upserts are required for aggregate-heavy
repairs; a repair must not perform one remote database round trip per hour or
per day.

## 5. Aggregation Rules

- Steps remain UTC hourly counts.
- Health-calendar days use the profile's explicit health timezone. Travel does
  not silently regroup data.
- Sleep intervals are attributed to the profile-local day on which they end.
  Stage values are calculated without double-counting overlapping samples.
- Activity, mindfulness, water, caffeine, alcohol, and nutrients use daily
  sums. High-frequency vitals use daily count/min/max/average plus the latest
  value when useful. Body and mobility measurements use the daily latest value
  unless the metric has a meaningful aggregate.
- Blood pressure and glucose retain individual readings because daily averages
  erase clinically meaningful variation.
- Workouts retain their summary only. GPS routes are excluded.

When multiple HealthKit sources overlap, the iPhone applies an explicit
source-priority rule and never sums duplicate intervals or duplicate samples.
The rule is deterministic and covered by device tests.

## 6. Authorization, Privacy, and MCP

Every write is authorized by the ordinary Family OS bearer token and must prove:

1. the caller owns the active linked Self profile;
2. consent is active for the requested group;
3. the metric belongs to that group;
4. the installation is the one active installation for that profile; and
5. the timezone version and repair ownership are current.

MCP continues to accept one authorized profile and one allowlisted metric per
call. It returns only the metric's appropriate bounded result: daily series,
hourly steps, sleep-stage series, clinical reading table, or workout summary
table. It never has a bulk export, raw HealthKit payload, arbitrary SQL, route,
or write tool.

Audits contain action, group/metric key, operation count, result category, and
timestamp only. They never contain health values, source UUIDs, tokens,
anchors, local-ledger contents, or request bodies.

## 7. Clean Cutover

The migration drops the current HealthKit data tables, sync tables, repair
tables, RLS policies, related indexes, and legacy manual BP/glucose tables
before creating the tables above. No old HealthKit, BP, or glucose record is
migrated, transformed, or exposed after the migration. Apple Health is the only
BP and glucose source after the cutover.

The API and iOS app ship together. On first launch after the cutover, the app
clears its local anchors and ledger, saves the selected groups, and performs a
fresh 90-day repair. The MCP exposes a group only after that repair completes.

## 8. Verification

Tests and device verification must prove that:

- each registered metric maps to the correct aggregation and unit;
- stages, nutrients, and overlapping sources do not double count;
- empty/permission-limited reads do not erase stored records;
- explicit HealthKit deletions only affect records proven by the local ledger;
- retries and duplicate notifications are idempotent;
- incomplete repairs are withheld from MCP;
- a replacement installation fences the old phone;
- timezone changes cannot produce duplicate visible daily records; and
- logs, audits, MCP output, and the database contain no excluded raw payloads.
