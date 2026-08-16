-- Deleting a household must not delete person-owned health rows.
-- Keep memberships/invites/reminders cascading with the family row.
--> statement-breakpoint
ALTER TABLE people DROP CONSTRAINT IF EXISTS people_family_id_families_id_fk;
--> statement-breakpoint
ALTER TABLE people
  ADD CONSTRAINT people_family_id_families_id_fk
  FOREIGN KEY (family_id) REFERENCES families(id) ON DELETE SET NULL;
--> statement-breakpoint
ALTER TABLE audit_logs DROP CONSTRAINT IF EXISTS audit_logs_family_id_families_id_fk;
--> statement-breakpoint
ALTER TABLE audit_logs
  ADD CONSTRAINT audit_logs_family_id_families_id_fk
  FOREIGN KEY (family_id) REFERENCES families(id) ON DELETE SET NULL;
--> statement-breakpoint
ALTER TABLE healthkit_sync_profile_settings DROP CONSTRAINT IF EXISTS healthkit_sync_profile_settings_family_id_fkey;
--> statement-breakpoint
ALTER TABLE healthkit_sync_profile_settings
  ADD CONSTRAINT healthkit_sync_profile_settings_family_id_fkey
  FOREIGN KEY (family_id) REFERENCES families(id) ON DELETE SET NULL;
--> statement-breakpoint
ALTER TABLE healthkit_sync_groups DROP CONSTRAINT IF EXISTS healthkit_sync_groups_family_id_fkey;
--> statement-breakpoint
ALTER TABLE healthkit_sync_groups
  ADD CONSTRAINT healthkit_sync_groups_family_id_fkey
  FOREIGN KEY (family_id) REFERENCES families(id) ON DELETE SET NULL;
--> statement-breakpoint
ALTER TABLE healthkit_sync_state DROP CONSTRAINT IF EXISTS healthkit_sync_state_family_id_fkey;
--> statement-breakpoint
ALTER TABLE healthkit_sync_state
  ADD CONSTRAINT healthkit_sync_state_family_id_fkey
  FOREIGN KEY (family_id) REFERENCES families(id) ON DELETE SET NULL;
--> statement-breakpoint
ALTER TABLE healthkit_sync_installations DROP CONSTRAINT IF EXISTS healthkit_sync_installations_family_id_fkey;
--> statement-breakpoint
ALTER TABLE healthkit_sync_installations
  ADD CONSTRAINT healthkit_sync_installations_family_id_fkey
  FOREIGN KEY (family_id) REFERENCES families(id) ON DELETE SET NULL;
--> statement-breakpoint
ALTER TABLE healthkit_op_receipts DROP CONSTRAINT IF EXISTS healthkit_op_receipts_family_id_fkey;
--> statement-breakpoint
ALTER TABLE healthkit_op_receipts
  ADD CONSTRAINT healthkit_op_receipts_family_id_fkey
  FOREIGN KEY (family_id) REFERENCES families(id) ON DELETE SET NULL;
--> statement-breakpoint
ALTER TABLE health_step_hours DROP CONSTRAINT IF EXISTS health_step_hours_family_id_fkey;
--> statement-breakpoint
ALTER TABLE health_step_hours
  ADD CONSTRAINT health_step_hours_family_id_fkey
  FOREIGN KEY (family_id) REFERENCES families(id) ON DELETE SET NULL;
--> statement-breakpoint
ALTER TABLE health_sleep_days DROP CONSTRAINT IF EXISTS health_sleep_days_family_id_fkey;
--> statement-breakpoint
ALTER TABLE health_sleep_days
  ADD CONSTRAINT health_sleep_days_family_id_fkey
  FOREIGN KEY (family_id) REFERENCES families(id) ON DELETE SET NULL;
--> statement-breakpoint
ALTER TABLE health_daily_metrics DROP CONSTRAINT IF EXISTS health_daily_metrics_family_id_fkey;
--> statement-breakpoint
ALTER TABLE health_daily_metrics
  ADD CONSTRAINT health_daily_metrics_family_id_fkey
  FOREIGN KEY (family_id) REFERENCES families(id) ON DELETE SET NULL;
--> statement-breakpoint
ALTER TABLE health_blood_pressure_readings DROP CONSTRAINT IF EXISTS health_blood_pressure_readings_family_id_fkey;
--> statement-breakpoint
ALTER TABLE health_blood_pressure_readings
  ADD CONSTRAINT health_blood_pressure_readings_family_id_fkey
  FOREIGN KEY (family_id) REFERENCES families(id) ON DELETE SET NULL;
--> statement-breakpoint
ALTER TABLE health_blood_glucose_readings DROP CONSTRAINT IF EXISTS health_blood_glucose_readings_family_id_fkey;
--> statement-breakpoint
ALTER TABLE health_blood_glucose_readings
  ADD CONSTRAINT health_blood_glucose_readings_family_id_fkey
  FOREIGN KEY (family_id) REFERENCES families(id) ON DELETE SET NULL;
--> statement-breakpoint
ALTER TABLE health_workouts DROP CONSTRAINT IF EXISTS health_workouts_family_id_fkey;
--> statement-breakpoint
ALTER TABLE health_workouts
  ADD CONSTRAINT health_workouts_family_id_fkey
  FOREIGN KEY (family_id) REFERENCES families(id) ON DELETE SET NULL;
--> statement-breakpoint
UPDATE people
SET status = 'inactive', updated_at = now()
WHERE linked_user_id IS NULL
  AND status = 'active';
