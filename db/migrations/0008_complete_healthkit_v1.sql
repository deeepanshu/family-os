-- Complete HealthKit v1 clean cutover. Existing HealthKit, BP, and glucose
-- records are intentionally discarded; the compatible iPhone app repairs 90
-- days after the user re-enables selected consent groups.
DROP TABLE IF EXISTS healthkit_repair_chunks CASCADE;
--> statement-breakpoint
DROP TABLE IF EXISTS healthkit_repairs CASCADE;
--> statement-breakpoint
DROP TABLE IF EXISTS healthkit_sync_receipts CASCADE;
--> statement-breakpoint
DROP TABLE IF EXISTS healthkit_sync_installations CASCADE;
--> statement-breakpoint
DROP TABLE IF EXISTS health_metric_sync_state CASCADE;
--> statement-breakpoint
DROP TABLE IF EXISTS healthkit_sync_metrics CASCADE;
--> statement-breakpoint
DROP TABLE IF EXISTS healthkit_sync_profile_settings CASCADE;
--> statement-breakpoint
DROP TABLE IF EXISTS health_step_hours CASCADE;
--> statement-breakpoint
DROP TABLE IF EXISTS health_sleep_days CASCADE;
--> statement-breakpoint
DROP TABLE IF EXISTS blood_pressure_readings CASCADE;
--> statement-breakpoint
DROP TABLE IF EXISTS blood_glucose_readings CASCADE;
--> statement-breakpoint

CREATE TABLE healthkit_sync_profile_settings (
  person_id uuid PRIMARY KEY REFERENCES people(id) ON DELETE CASCADE,
  family_id uuid NOT NULL REFERENCES families(id) ON DELETE CASCADE,
  user_id uuid NOT NULL,
  consent_version text,
  consented_at timestamptz,
  health_timezone text NOT NULL,
  health_timezone_version integer NOT NULL DEFAULT 1,
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT healthkit_sync_profile_settings_tz_version_check CHECK (health_timezone_version >= 1)
);
--> statement-breakpoint
CREATE TABLE healthkit_sync_groups (
  person_id uuid NOT NULL REFERENCES people(id) ON DELETE CASCADE,
  family_id uuid NOT NULL REFERENCES families(id) ON DELETE CASCADE,
  group_key text NOT NULL,
  enabled boolean NOT NULL DEFAULT false,
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT healthkit_sync_groups_group_check CHECK (group_key IN ('activity', 'sleep', 'vitals', 'body', 'mobility', 'workouts', 'mindfulness_environment', 'nutrition')),
  CONSTRAINT healthkit_sync_groups_person_group_idx UNIQUE (person_id, group_key)
);
--> statement-breakpoint
CREATE TABLE healthkit_sync_state (
  person_id uuid NOT NULL REFERENCES people(id) ON DELETE CASCADE,
  family_id uuid NOT NULL REFERENCES families(id) ON DELETE CASCADE,
  group_key text NOT NULL,
  last_successful_at timestamptz,
  last_attempt_at timestamptz,
  last_error_code text,
  coverage_start_at timestamptz,
  coverage_end_at timestamptz,
  status text NOT NULL DEFAULT 'never_synced',
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT healthkit_sync_state_group_check CHECK (group_key IN ('activity', 'sleep', 'vitals', 'body', 'mobility', 'workouts', 'mindfulness_environment', 'nutrition')),
  CONSTRAINT healthkit_sync_state_status_check CHECK (status IN ('never_synced', 'ready', 'repairing', 'repair_needed', 'error', 'disabled')),
  CONSTRAINT healthkit_sync_state_person_group_idx UNIQUE (person_id, group_key)
);
--> statement-breakpoint
CREATE TABLE healthkit_sync_installations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  person_id uuid NOT NULL REFERENCES people(id) ON DELETE CASCADE,
  family_id uuid NOT NULL REFERENCES families(id) ON DELETE CASCADE,
  installation_id uuid NOT NULL,
  activated_at timestamptz NOT NULL DEFAULT now(),
  revoked_at timestamptz,
  CONSTRAINT healthkit_sync_installations_person_installation_idx UNIQUE (person_id, installation_id)
);
--> statement-breakpoint
CREATE TABLE healthkit_repairs (
  repair_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  person_id uuid NOT NULL REFERENCES people(id) ON DELETE CASCADE,
  family_id uuid NOT NULL REFERENCES families(id) ON DELETE CASCADE,
  group_key text NOT NULL,
  installation_id uuid NOT NULL,
  timezone_version integer NOT NULL,
  range_start timestamptz NOT NULL,
  range_end timestamptz NOT NULL,
  range_start_day date NOT NULL,
  range_end_day date NOT NULL,
  expected_chunk_count integer,
  completed_at timestamptz,
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT healthkit_repairs_group_check CHECK (group_key IN ('activity', 'sleep', 'vitals', 'body', 'mobility', 'workouts', 'mindfulness_environment', 'nutrition')),
  CONSTRAINT healthkit_repairs_tz_version_check CHECK (timezone_version >= 1),
  CONSTRAINT healthkit_repairs_day_order_check CHECK (range_start_day <= range_end_day),
  CONSTRAINT healthkit_repairs_expected_chunks_check CHECK (expected_chunk_count IS NULL OR expected_chunk_count >= 0)
);
--> statement-breakpoint
CREATE TABLE healthkit_repair_chunks (
  repair_id uuid NOT NULL REFERENCES healthkit_repairs(repair_id) ON DELETE CASCADE,
  chunk_index integer NOT NULL,
  sync_id uuid NOT NULL,
  response_json jsonb NOT NULL,
  completed_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT healthkit_repair_chunks_index_check CHECK (chunk_index >= 0),
  CONSTRAINT healthkit_repair_chunks_repair_chunk_idx UNIQUE (repair_id, chunk_index)
);
--> statement-breakpoint
CREATE TABLE healthkit_sync_receipts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL,
  person_id uuid NOT NULL REFERENCES people(id) ON DELETE CASCADE,
  family_id uuid NOT NULL REFERENCES families(id) ON DELETE CASCADE,
  sync_id uuid NOT NULL,
  response_json jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT healthkit_sync_receipts_user_person_sync_idx UNIQUE (user_id, person_id, sync_id)
);
--> statement-breakpoint
CREATE TABLE health_step_hours (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  family_id uuid NOT NULL REFERENCES families(id) ON DELETE CASCADE,
  person_id uuid NOT NULL REFERENCES people(id) ON DELETE CASCADE,
  hour_start_utc timestamptz NOT NULL,
  count integer NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT health_step_hours_count_check CHECK (count >= 0),
  CONSTRAINT health_step_hours_person_hour_idx UNIQUE (person_id, hour_start_utc)
);
--> statement-breakpoint
CREATE TABLE health_daily_metrics (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  family_id uuid NOT NULL REFERENCES families(id) ON DELETE CASCADE,
  person_id uuid NOT NULL REFERENCES people(id) ON DELETE CASCADE,
  metric_key text NOT NULL,
  local_day date NOT NULL,
  timezone_version integer NOT NULL,
  unit text NOT NULL,
  sum_value numeric(14, 4),
  average_value numeric(14, 4),
  minimum_value numeric(14, 4),
  maximum_value numeric(14, 4),
  latest_value numeric(14, 4),
  sample_count integer NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT health_daily_metrics_tz_version_check CHECK (timezone_version >= 1),
  CONSTRAINT health_daily_metrics_sample_count_check CHECK (sample_count >= 0),
  CONSTRAINT health_daily_metrics_person_metric_day_version_idx UNIQUE (person_id, metric_key, local_day, timezone_version)
);
--> statement-breakpoint
CREATE TABLE health_sleep_days (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  family_id uuid NOT NULL REFERENCES families(id) ON DELETE CASCADE,
  person_id uuid NOT NULL REFERENCES people(id) ON DELETE CASCADE,
  sleep_day date NOT NULL,
  timezone_version integer NOT NULL,
  total_minutes integer NOT NULL,
  core_minutes integer NOT NULL DEFAULT 0,
  deep_minutes integer NOT NULL DEFAULT 0,
  rem_minutes integer NOT NULL DEFAULT 0,
  unspecified_asleep_minutes integer NOT NULL DEFAULT 0,
  awake_minutes integer NOT NULL DEFAULT 0,
  in_bed_minutes integer NOT NULL DEFAULT 0,
  wrist_temperature_celsius numeric(6, 3),
  breathing_disturbance_count integer,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT health_sleep_days_person_day_version_idx UNIQUE (person_id, sleep_day, timezone_version),
  CONSTRAINT health_sleep_days_timezone_version_check CHECK (timezone_version >= 1),
  CONSTRAINT health_sleep_days_minutes_check CHECK (total_minutes >= 0 AND core_minutes >= 0 AND deep_minutes >= 0 AND rem_minutes >= 0 AND unspecified_asleep_minutes >= 0 AND awake_minutes >= 0 AND in_bed_minutes >= 0),
  CONSTRAINT health_sleep_days_breathing_check CHECK (breathing_disturbance_count IS NULL OR breathing_disturbance_count >= 0)
);
--> statement-breakpoint
CREATE TABLE health_blood_pressure_readings (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  family_id uuid NOT NULL REFERENCES families(id) ON DELETE CASCADE,
  person_id uuid NOT NULL REFERENCES people(id) ON DELETE CASCADE,
  source_sample_key uuid NOT NULL,
  measured_at timestamptz NOT NULL,
  systolic integer NOT NULL,
  diastolic integer NOT NULL,
  pulse integer,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT health_bp_person_source_sample_idx UNIQUE (person_id, source_sample_key),
  CONSTRAINT health_bp_systolic_check CHECK (systolic BETWEEN 50 AND 260),
  CONSTRAINT health_bp_diastolic_check CHECK (diastolic BETWEEN 30 AND 180),
  CONSTRAINT health_bp_pulse_check CHECK (pulse IS NULL OR pulse BETWEEN 30 AND 220)
);
--> statement-breakpoint
CREATE TABLE health_blood_glucose_readings (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  family_id uuid NOT NULL REFERENCES families(id) ON DELETE CASCADE,
  person_id uuid NOT NULL REFERENCES people(id) ON DELETE CASCADE,
  source_sample_key uuid NOT NULL,
  measured_at timestamptz NOT NULL,
  value_mg_dl numeric(6, 2) NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT health_glucose_person_source_sample_idx UNIQUE (person_id, source_sample_key),
  CONSTRAINT health_glucose_value_check CHECK (value_mg_dl BETWEEN 20 AND 700)
);
--> statement-breakpoint
CREATE TABLE health_workouts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  family_id uuid NOT NULL REFERENCES families(id) ON DELETE CASCADE,
  person_id uuid NOT NULL REFERENCES people(id) ON DELETE CASCADE,
  source_sample_key uuid NOT NULL,
  workout_type text NOT NULL,
  started_at timestamptz NOT NULL,
  ended_at timestamptz NOT NULL,
  duration_seconds integer NOT NULL,
  active_energy_kcal numeric(12, 3),
  distance_meters numeric(14, 3),
  average_heart_rate_bpm numeric(8, 2),
  maximum_heart_rate_bpm numeric(8, 2),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT health_workouts_person_source_sample_idx UNIQUE (person_id, source_sample_key),
  CONSTRAINT health_workouts_duration_check CHECK (duration_seconds >= 0),
  CONSTRAINT health_workouts_time_order_check CHECK (ended_at >= started_at)
);
--> statement-breakpoint

CREATE UNIQUE INDEX healthkit_sync_installations_one_active_per_person_idx ON healthkit_sync_installations (person_id) WHERE revoked_at IS NULL;
--> statement-breakpoint
CREATE INDEX healthkit_repairs_person_group_idx ON healthkit_repairs (person_id, group_key, created_at);
--> statement-breakpoint
CREATE INDEX health_step_hours_family_person_hour_idx ON health_step_hours (family_id, person_id, hour_start_utc);
--> statement-breakpoint
CREATE INDEX health_daily_metrics_family_person_metric_day_idx ON health_daily_metrics (family_id, person_id, metric_key, local_day);
--> statement-breakpoint
CREATE INDEX health_sleep_days_family_person_day_idx ON health_sleep_days (family_id, person_id, sleep_day);
--> statement-breakpoint
CREATE INDEX health_bp_family_person_measured_idx ON health_blood_pressure_readings (family_id, person_id, measured_at);
--> statement-breakpoint
CREATE INDEX health_glucose_family_person_measured_idx ON health_blood_glucose_readings (family_id, person_id, measured_at);
--> statement-breakpoint
CREATE INDEX health_workouts_family_person_started_idx ON health_workouts (family_id, person_id, started_at);
--> statement-breakpoint

CREATE TRIGGER healthkit_sync_profile_settings_set_updated_at BEFORE UPDATE ON healthkit_sync_profile_settings FOR EACH ROW EXECUTE FUNCTION set_updated_at();
--> statement-breakpoint
CREATE TRIGGER healthkit_sync_groups_set_updated_at BEFORE UPDATE ON healthkit_sync_groups FOR EACH ROW EXECUTE FUNCTION set_updated_at();
--> statement-breakpoint
CREATE TRIGGER healthkit_sync_state_set_updated_at BEFORE UPDATE ON healthkit_sync_state FOR EACH ROW EXECUTE FUNCTION set_updated_at();
--> statement-breakpoint
CREATE TRIGGER health_step_hours_set_updated_at BEFORE UPDATE ON health_step_hours FOR EACH ROW EXECUTE FUNCTION set_updated_at();
--> statement-breakpoint
CREATE TRIGGER health_daily_metrics_set_updated_at BEFORE UPDATE ON health_daily_metrics FOR EACH ROW EXECUTE FUNCTION set_updated_at();
--> statement-breakpoint
CREATE TRIGGER health_sleep_days_set_updated_at BEFORE UPDATE ON health_sleep_days FOR EACH ROW EXECUTE FUNCTION set_updated_at();
--> statement-breakpoint
CREATE TRIGGER health_blood_pressure_readings_set_updated_at BEFORE UPDATE ON health_blood_pressure_readings FOR EACH ROW EXECUTE FUNCTION set_updated_at();
--> statement-breakpoint
CREATE TRIGGER health_blood_glucose_readings_set_updated_at BEFORE UPDATE ON health_blood_glucose_readings FOR EACH ROW EXECUTE FUNCTION set_updated_at();
--> statement-breakpoint
CREATE TRIGGER health_workouts_set_updated_at BEFORE UPDATE ON health_workouts FOR EACH ROW EXECUTE FUNCTION set_updated_at();
--> statement-breakpoint

CREATE OR REPLACE FUNCTION family_os_is_active_member(target_family_id uuid)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, auth AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.family_memberships
    WHERE family_id = target_family_id AND user_id = auth.uid() AND status = 'active'
  );
$$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION family_os_is_linked_self_profile(target_person_id uuid, target_family_id uuid)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, auth AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.people
    WHERE id = target_person_id AND family_id = target_family_id AND linked_user_id = auth.uid()
      AND relationship_label = 'Self' AND status = 'active'
  );
$$;
--> statement-breakpoint

ALTER TABLE healthkit_sync_profile_settings ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE healthkit_sync_groups ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE healthkit_sync_state ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE healthkit_sync_installations ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE healthkit_repairs ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE healthkit_repair_chunks ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE healthkit_sync_receipts ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE health_step_hours ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE health_daily_metrics ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE health_sleep_days ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE health_blood_pressure_readings ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE health_blood_glucose_readings ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE health_workouts ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint

CREATE POLICY healthkit_sync_profile_settings_select ON healthkit_sync_profile_settings FOR SELECT USING (family_os_is_active_member(family_id));
--> statement-breakpoint
CREATE POLICY healthkit_sync_profile_settings_write ON healthkit_sync_profile_settings FOR ALL USING (family_os_is_linked_self_profile(person_id, family_id)) WITH CHECK (family_os_is_linked_self_profile(person_id, family_id));
--> statement-breakpoint
CREATE POLICY healthkit_sync_groups_select ON healthkit_sync_groups FOR SELECT USING (family_os_is_active_member(family_id));
--> statement-breakpoint
CREATE POLICY healthkit_sync_groups_write ON healthkit_sync_groups FOR ALL USING (family_os_is_linked_self_profile(person_id, family_id)) WITH CHECK (family_os_is_linked_self_profile(person_id, family_id));
--> statement-breakpoint
CREATE POLICY healthkit_sync_state_select ON healthkit_sync_state FOR SELECT USING (family_os_is_active_member(family_id));
--> statement-breakpoint
CREATE POLICY healthkit_sync_state_write ON healthkit_sync_state FOR ALL USING (family_os_is_linked_self_profile(person_id, family_id)) WITH CHECK (family_os_is_linked_self_profile(person_id, family_id));
--> statement-breakpoint
CREATE POLICY healthkit_sync_installations_select ON healthkit_sync_installations FOR SELECT USING (family_os_is_linked_self_profile(person_id, family_id));
--> statement-breakpoint
CREATE POLICY healthkit_sync_installations_write ON healthkit_sync_installations FOR ALL USING (family_os_is_linked_self_profile(person_id, family_id)) WITH CHECK (family_os_is_linked_self_profile(person_id, family_id));
--> statement-breakpoint
CREATE POLICY healthkit_repairs_select ON healthkit_repairs FOR SELECT USING (family_os_is_linked_self_profile(person_id, family_id));
--> statement-breakpoint
CREATE POLICY healthkit_repairs_write ON healthkit_repairs FOR ALL USING (family_os_is_linked_self_profile(person_id, family_id)) WITH CHECK (family_os_is_linked_self_profile(person_id, family_id));
--> statement-breakpoint
CREATE POLICY healthkit_repair_chunks_select ON healthkit_repair_chunks FOR SELECT USING (EXISTS (SELECT 1 FROM healthkit_repairs r WHERE r.repair_id = healthkit_repair_chunks.repair_id AND family_os_is_linked_self_profile(r.person_id, r.family_id)));
--> statement-breakpoint
CREATE POLICY healthkit_repair_chunks_write ON healthkit_repair_chunks FOR ALL USING (EXISTS (SELECT 1 FROM healthkit_repairs r WHERE r.repair_id = healthkit_repair_chunks.repair_id AND family_os_is_linked_self_profile(r.person_id, r.family_id))) WITH CHECK (EXISTS (SELECT 1 FROM healthkit_repairs r WHERE r.repair_id = healthkit_repair_chunks.repair_id AND family_os_is_linked_self_profile(r.person_id, r.family_id)));
--> statement-breakpoint
CREATE POLICY healthkit_sync_receipts_select ON healthkit_sync_receipts FOR SELECT USING (user_id = auth.uid());
--> statement-breakpoint
CREATE POLICY healthkit_sync_receipts_write ON healthkit_sync_receipts FOR ALL USING (user_id = auth.uid()) WITH CHECK (user_id = auth.uid());
--> statement-breakpoint
CREATE POLICY health_step_hours_select ON health_step_hours FOR SELECT USING (family_os_is_active_member(family_id));
--> statement-breakpoint
CREATE POLICY health_step_hours_write ON health_step_hours FOR ALL USING (family_os_is_linked_self_profile(person_id, family_id)) WITH CHECK (family_os_is_linked_self_profile(person_id, family_id));
--> statement-breakpoint
CREATE POLICY health_daily_metrics_select ON health_daily_metrics FOR SELECT USING (family_os_is_active_member(family_id));
--> statement-breakpoint
CREATE POLICY health_daily_metrics_write ON health_daily_metrics FOR ALL USING (family_os_is_linked_self_profile(person_id, family_id)) WITH CHECK (family_os_is_linked_self_profile(person_id, family_id));
--> statement-breakpoint
CREATE POLICY health_sleep_days_select ON health_sleep_days FOR SELECT USING (family_os_is_active_member(family_id));
--> statement-breakpoint
CREATE POLICY health_sleep_days_write ON health_sleep_days FOR ALL USING (family_os_is_linked_self_profile(person_id, family_id)) WITH CHECK (family_os_is_linked_self_profile(person_id, family_id));
--> statement-breakpoint
CREATE POLICY health_blood_pressure_readings_select ON health_blood_pressure_readings FOR SELECT USING (family_os_is_active_member(family_id));
--> statement-breakpoint
CREATE POLICY health_blood_pressure_readings_write ON health_blood_pressure_readings FOR ALL USING (family_os_is_linked_self_profile(person_id, family_id)) WITH CHECK (family_os_is_linked_self_profile(person_id, family_id));
--> statement-breakpoint
CREATE POLICY health_blood_glucose_readings_select ON health_blood_glucose_readings FOR SELECT USING (family_os_is_active_member(family_id));
--> statement-breakpoint
CREATE POLICY health_blood_glucose_readings_write ON health_blood_glucose_readings FOR ALL USING (family_os_is_linked_self_profile(person_id, family_id)) WITH CHECK (family_os_is_linked_self_profile(person_id, family_id));
--> statement-breakpoint
CREATE POLICY health_workouts_select ON health_workouts FOR SELECT USING (family_os_is_active_member(family_id));
--> statement-breakpoint
CREATE POLICY health_workouts_write ON health_workouts FOR ALL USING (family_os_is_linked_self_profile(person_id, family_id)) WITH CHECK (family_os_is_linked_self_profile(person_id, family_id));
