-- Solo-first: Self person is user-owned; family is optional (created from app later).
-- HealthKit milestone scope: BP (live), sleep + workouts (next).

-- people: family optional
ALTER TABLE people ALTER COLUMN family_id DROP NOT NULL;

-- One active Self profile per auth user
CREATE UNIQUE INDEX IF NOT EXISTS people_one_active_self_per_user_idx
  ON people (linked_user_id)
  WHERE linked_user_id IS NOT NULL
    AND relationship_label = 'Self'
    AND status = 'active';

-- HealthKit + health sample tables: family optional for solo
ALTER TABLE healthkit_sync_profile_settings ALTER COLUMN family_id DROP NOT NULL;
ALTER TABLE healthkit_sync_groups ALTER COLUMN family_id DROP NOT NULL;
ALTER TABLE healthkit_sync_state ALTER COLUMN family_id DROP NOT NULL;
ALTER TABLE healthkit_sync_installations ALTER COLUMN family_id DROP NOT NULL;
ALTER TABLE healthkit_op_receipts ALTER COLUMN family_id DROP NOT NULL;

ALTER TABLE health_blood_pressure_readings ALTER COLUMN family_id DROP NOT NULL;
ALTER TABLE health_blood_glucose_readings ALTER COLUMN family_id DROP NOT NULL;
ALTER TABLE health_daily_metrics ALTER COLUMN family_id DROP NOT NULL;
ALTER TABLE health_step_hours ALTER COLUMN family_id DROP NOT NULL;
ALTER TABLE health_sleep_days ALTER COLUMN family_id DROP NOT NULL;
ALTER TABLE health_workouts ALTER COLUMN family_id DROP NOT NULL;

ALTER TABLE audit_logs ALTER COLUMN family_id DROP NOT NULL;
