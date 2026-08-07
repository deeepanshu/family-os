-- Fat workout summary: extra scalars + events/activities JSON (no GPS / metric series).
ALTER TABLE health_workouts
  ADD COLUMN IF NOT EXISTS minimum_heart_rate_bpm numeric(8, 2),
  ADD COLUMN IF NOT EXISTS source_name text,
  ADD COLUMN IF NOT EXISTS source_bundle_id text,
  ADD COLUMN IF NOT EXISTS device_name text,
  ADD COLUMN IF NOT EXISTS device_manufacturer text,
  ADD COLUMN IF NOT EXISTS is_indoor boolean,
  ADD COLUMN IF NOT EXISTS elevation_ascended_meters numeric(14, 3),
  ADD COLUMN IF NOT EXISTS average_mets numeric(8, 3),
  ADD COLUMN IF NOT EXISTS swimming_stroke_count integer,
  ADD COLUMN IF NOT EXISTS total_flights_climbed integer,
  ADD COLUMN IF NOT EXISTS events_json jsonb,
  ADD COLUMN IF NOT EXISTS activities_json jsonb;

ALTER TABLE health_workouts
  DROP CONSTRAINT IF EXISTS health_workouts_swimming_stroke_check;
ALTER TABLE health_workouts
  ADD CONSTRAINT health_workouts_swimming_stroke_check
  CHECK (swimming_stroke_count IS NULL OR swimming_stroke_count >= 0);

ALTER TABLE health_workouts
  DROP CONSTRAINT IF EXISTS health_workouts_flights_check;
ALTER TABLE health_workouts
  ADD CONSTRAINT health_workouts_flights_check
  CHECK (total_flights_climbed IS NULL OR total_flights_climbed >= 0);
