-- HealthKit background sync: canonical tables, authority, repair metadata.
-- Clean cutover: drop legacy sample feed and imported HealthKit clinical rows.

DELETE FROM blood_pressure_readings WHERE source = 'healthkit';
--> statement-breakpoint
DELETE FROM blood_glucose_readings WHERE source = 'healthkit';
--> statement-breakpoint
DROP TABLE IF EXISTS "healthkit_samples" CASCADE;
--> statement-breakpoint
DROP TABLE IF EXISTS "health_metric_daily_summaries" CASCADE;
--> statement-breakpoint
DROP TABLE IF EXISTS "healthkit_sync_runs" CASCADE;
--> statement-breakpoint
DROP TABLE IF EXISTS "healthkit_sync_settings" CASCADE;
--> statement-breakpoint

CREATE TABLE "health_step_hours" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "family_id" uuid NOT NULL,
  "person_id" uuid NOT NULL,
  "hour_start_utc" timestamp with time zone NOT NULL,
  "count" integer NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "health_step_hours_count_check" CHECK ("count" >= 0)
);
--> statement-breakpoint
CREATE TABLE "health_sleep_days" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "family_id" uuid NOT NULL,
  "person_id" uuid NOT NULL,
  "sleep_day" date NOT NULL,
  "timezone_version" integer NOT NULL,
  "duration_minutes" integer NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "health_sleep_days_duration_check" CHECK ("duration_minutes" >= 0),
  CONSTRAINT "health_sleep_days_timezone_version_check" CHECK ("timezone_version" >= 1)
);
--> statement-breakpoint
CREATE TABLE "healthkit_sync_profile_settings" (
  "person_id" uuid PRIMARY KEY NOT NULL,
  "family_id" uuid NOT NULL,
  "user_id" uuid NOT NULL,
  "consent_version" text,
  "consented_at" timestamp with time zone,
  "health_timezone" text NOT NULL,
  "health_timezone_version" integer DEFAULT 1 NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "healthkit_sync_profile_settings_tz_version_check" CHECK ("health_timezone_version" >= 1)
);
--> statement-breakpoint
CREATE TABLE "healthkit_sync_metrics" (
  "person_id" uuid NOT NULL,
  "family_id" uuid NOT NULL,
  "metric" text NOT NULL,
  "enabled" boolean DEFAULT false NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "healthkit_sync_metrics_metric_check" CHECK ("metric" in ('steps', 'sleep', 'blood_pressure'))
);
--> statement-breakpoint
CREATE TABLE "health_metric_sync_state" (
  "person_id" uuid NOT NULL,
  "family_id" uuid NOT NULL,
  "metric" text NOT NULL,
  "last_successful_at" timestamp with time zone,
  "last_attempt_at" timestamp with time zone,
  "last_error_code" text,
  "coverage_start_at" timestamp with time zone,
  "coverage_end_at" timestamp with time zone,
  "status" text DEFAULT 'never_synced' NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "health_metric_sync_state_metric_check" CHECK ("metric" in ('steps', 'sleep', 'blood_pressure')),
  CONSTRAINT "health_metric_sync_state_status_check" CHECK (
    "status" in ('never_synced', 'ready', 'repairing', 'repair_needed', 'error', 'disabled')
  )
);
--> statement-breakpoint
CREATE TABLE "healthkit_sync_installations" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "person_id" uuid NOT NULL,
  "family_id" uuid NOT NULL,
  "installation_id" uuid NOT NULL,
  "activated_at" timestamp with time zone DEFAULT now() NOT NULL,
  "revoked_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "healthkit_repairs" (
  "repair_id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "person_id" uuid NOT NULL,
  "family_id" uuid NOT NULL,
  "metric" text NOT NULL,
  "installation_id" uuid NOT NULL,
  "timezone_version" integer NOT NULL,
  "range_start" timestamp with time zone NOT NULL,
  "range_end" timestamp with time zone NOT NULL,
  "expected_chunk_count" integer,
  "completed_at" timestamp with time zone,
  "expires_at" timestamp with time zone NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "healthkit_repairs_metric_check" CHECK ("metric" in ('steps', 'sleep', 'blood_pressure')),
  CONSTRAINT "healthkit_repairs_tz_version_check" CHECK ("timezone_version" >= 1),
  CONSTRAINT "healthkit_repairs_expected_chunks_check" CHECK (
    "expected_chunk_count" is null or "expected_chunk_count" >= 0
  )
);
--> statement-breakpoint
CREATE TABLE "healthkit_repair_chunks" (
  "repair_id" uuid NOT NULL,
  "chunk_index" integer NOT NULL,
  "sync_id" uuid NOT NULL,
  "response_json" jsonb NOT NULL,
  "completed_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "healthkit_repair_chunks_index_check" CHECK ("chunk_index" >= 0)
);
--> statement-breakpoint
CREATE TABLE "healthkit_sync_receipts" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "user_id" uuid NOT NULL,
  "person_id" uuid NOT NULL,
  "family_id" uuid NOT NULL,
  "sync_id" uuid NOT NULL,
  "response_json" jsonb NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint

ALTER TABLE "health_step_hours" ADD CONSTRAINT "health_step_hours_family_id_families_id_fk"
  FOREIGN KEY ("family_id") REFERENCES "public"."families"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "health_step_hours" ADD CONSTRAINT "health_step_hours_person_id_people_id_fk"
  FOREIGN KEY ("person_id") REFERENCES "public"."people"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "health_sleep_days" ADD CONSTRAINT "health_sleep_days_family_id_families_id_fk"
  FOREIGN KEY ("family_id") REFERENCES "public"."families"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "health_sleep_days" ADD CONSTRAINT "health_sleep_days_person_id_people_id_fk"
  FOREIGN KEY ("person_id") REFERENCES "public"."people"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "healthkit_sync_profile_settings" ADD CONSTRAINT "healthkit_sync_profile_settings_person_id_people_id_fk"
  FOREIGN KEY ("person_id") REFERENCES "public"."people"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "healthkit_sync_profile_settings" ADD CONSTRAINT "healthkit_sync_profile_settings_family_id_families_id_fk"
  FOREIGN KEY ("family_id") REFERENCES "public"."families"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "healthkit_sync_metrics" ADD CONSTRAINT "healthkit_sync_metrics_person_id_people_id_fk"
  FOREIGN KEY ("person_id") REFERENCES "public"."people"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "healthkit_sync_metrics" ADD CONSTRAINT "healthkit_sync_metrics_family_id_families_id_fk"
  FOREIGN KEY ("family_id") REFERENCES "public"."families"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "health_metric_sync_state" ADD CONSTRAINT "health_metric_sync_state_person_id_people_id_fk"
  FOREIGN KEY ("person_id") REFERENCES "public"."people"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "health_metric_sync_state" ADD CONSTRAINT "health_metric_sync_state_family_id_families_id_fk"
  FOREIGN KEY ("family_id") REFERENCES "public"."families"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "healthkit_sync_installations" ADD CONSTRAINT "healthkit_sync_installations_person_id_people_id_fk"
  FOREIGN KEY ("person_id") REFERENCES "public"."people"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "healthkit_sync_installations" ADD CONSTRAINT "healthkit_sync_installations_family_id_families_id_fk"
  FOREIGN KEY ("family_id") REFERENCES "public"."families"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "healthkit_repairs" ADD CONSTRAINT "healthkit_repairs_person_id_people_id_fk"
  FOREIGN KEY ("person_id") REFERENCES "public"."people"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "healthkit_repairs" ADD CONSTRAINT "healthkit_repairs_family_id_families_id_fk"
  FOREIGN KEY ("family_id") REFERENCES "public"."families"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "healthkit_repair_chunks" ADD CONSTRAINT "healthkit_repair_chunks_repair_id_fk"
  FOREIGN KEY ("repair_id") REFERENCES "public"."healthkit_repairs"("repair_id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "healthkit_sync_receipts" ADD CONSTRAINT "healthkit_sync_receipts_person_id_people_id_fk"
  FOREIGN KEY ("person_id") REFERENCES "public"."people"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "healthkit_sync_receipts" ADD CONSTRAINT "healthkit_sync_receipts_family_id_families_id_fk"
  FOREIGN KEY ("family_id") REFERENCES "public"."families"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint

CREATE UNIQUE INDEX "health_step_hours_person_hour_idx" ON "health_step_hours" USING btree ("person_id", "hour_start_utc");
--> statement-breakpoint
CREATE INDEX "health_step_hours_family_person_hour_idx" ON "health_step_hours" USING btree ("family_id", "person_id", "hour_start_utc");
--> statement-breakpoint
CREATE UNIQUE INDEX "health_sleep_days_person_day_version_idx" ON "health_sleep_days" USING btree ("person_id", "sleep_day", "timezone_version");
--> statement-breakpoint
CREATE INDEX "health_sleep_days_family_person_day_idx" ON "health_sleep_days" USING btree ("family_id", "person_id", "sleep_day");
--> statement-breakpoint
CREATE UNIQUE INDEX "healthkit_sync_metrics_person_metric_idx" ON "healthkit_sync_metrics" USING btree ("person_id", "metric");
--> statement-breakpoint
CREATE UNIQUE INDEX "health_metric_sync_state_person_metric_idx" ON "health_metric_sync_state" USING btree ("person_id", "metric");
--> statement-breakpoint
CREATE UNIQUE INDEX "healthkit_sync_installations_person_installation_idx"
  ON "healthkit_sync_installations" USING btree ("person_id", "installation_id");
--> statement-breakpoint
CREATE UNIQUE INDEX "healthkit_sync_installations_one_active_per_person_idx"
  ON "healthkit_sync_installations" USING btree ("person_id")
  WHERE "revoked_at" is null;
--> statement-breakpoint
CREATE INDEX "healthkit_repairs_person_metric_idx" ON "healthkit_repairs" USING btree ("person_id", "metric", "created_at");
--> statement-breakpoint
CREATE UNIQUE INDEX "healthkit_repair_chunks_repair_chunk_idx" ON "healthkit_repair_chunks" USING btree ("repair_id", "chunk_index");
--> statement-breakpoint
CREATE UNIQUE INDEX "healthkit_sync_receipts_user_person_sync_idx"
  ON "healthkit_sync_receipts" USING btree ("user_id", "person_id", "sync_id");
--> statement-breakpoint

CREATE TRIGGER health_step_hours_set_updated_at
BEFORE UPDATE ON health_step_hours
FOR EACH ROW
EXECUTE FUNCTION set_updated_at();
--> statement-breakpoint
CREATE TRIGGER health_sleep_days_set_updated_at
BEFORE UPDATE ON health_sleep_days
FOR EACH ROW
EXECUTE FUNCTION set_updated_at();
--> statement-breakpoint
CREATE TRIGGER healthkit_sync_profile_settings_set_updated_at
BEFORE UPDATE ON healthkit_sync_profile_settings
FOR EACH ROW
EXECUTE FUNCTION set_updated_at();
--> statement-breakpoint
CREATE TRIGGER healthkit_sync_metrics_set_updated_at
BEFORE UPDATE ON healthkit_sync_metrics
FOR EACH ROW
EXECUTE FUNCTION set_updated_at();
--> statement-breakpoint
CREATE TRIGGER health_metric_sync_state_set_updated_at
BEFORE UPDATE ON health_metric_sync_state
FOR EACH ROW
EXECUTE FUNCTION set_updated_at();
--> statement-breakpoint

ALTER TABLE health_step_hours ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE health_sleep_days ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE healthkit_sync_profile_settings ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE healthkit_sync_metrics ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE health_metric_sync_state ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE healthkit_sync_installations ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE healthkit_repairs ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE healthkit_repair_chunks ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE healthkit_sync_receipts ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint

CREATE POLICY health_step_hours_select_active_member ON health_step_hours
  FOR SELECT
  USING (
    EXISTS (
      SELECT 1 FROM family_memberships fm
      WHERE fm.family_id = health_step_hours.family_id
        AND fm.user_id = auth.uid()
        AND fm.status = 'active'
    )
  );
--> statement-breakpoint
CREATE POLICY health_step_hours_write_self ON health_step_hours
  FOR ALL
  USING (
    EXISTS (
      SELECT 1 FROM people p
      WHERE p.id = health_step_hours.person_id
        AND p.family_id = health_step_hours.family_id
        AND p.linked_user_id = auth.uid()
        AND p.relationship_label = 'Self'
        AND p.status = 'active'
    )
  )
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM people p
      WHERE p.id = health_step_hours.person_id
        AND p.family_id = health_step_hours.family_id
        AND p.linked_user_id = auth.uid()
        AND p.relationship_label = 'Self'
        AND p.status = 'active'
    )
  );
--> statement-breakpoint
CREATE POLICY health_sleep_days_select_active_member ON health_sleep_days
  FOR SELECT
  USING (
    EXISTS (
      SELECT 1 FROM family_memberships fm
      WHERE fm.family_id = health_sleep_days.family_id
        AND fm.user_id = auth.uid()
        AND fm.status = 'active'
    )
  );
--> statement-breakpoint
CREATE POLICY health_sleep_days_write_self ON health_sleep_days
  FOR ALL
  USING (
    EXISTS (
      SELECT 1 FROM people p
      WHERE p.id = health_sleep_days.person_id
        AND p.family_id = health_sleep_days.family_id
        AND p.linked_user_id = auth.uid()
        AND p.relationship_label = 'Self'
        AND p.status = 'active'
    )
  )
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM people p
      WHERE p.id = health_sleep_days.person_id
        AND p.family_id = health_sleep_days.family_id
        AND p.linked_user_id = auth.uid()
        AND p.relationship_label = 'Self'
        AND p.status = 'active'
    )
  );
--> statement-breakpoint
CREATE POLICY healthkit_sync_profile_settings_select_active_member ON healthkit_sync_profile_settings
  FOR SELECT
  USING (
    EXISTS (
      SELECT 1 FROM family_memberships fm
      WHERE fm.family_id = healthkit_sync_profile_settings.family_id
        AND fm.user_id = auth.uid()
        AND fm.status = 'active'
    )
  );
--> statement-breakpoint
CREATE POLICY healthkit_sync_profile_settings_write_self ON healthkit_sync_profile_settings
  FOR ALL
  USING (user_id = auth.uid())
  WITH CHECK (
    user_id = auth.uid()
    AND EXISTS (
      SELECT 1 FROM people p
      WHERE p.id = healthkit_sync_profile_settings.person_id
        AND p.family_id = healthkit_sync_profile_settings.family_id
        AND p.linked_user_id = auth.uid()
        AND p.relationship_label = 'Self'
        AND p.status = 'active'
    )
  );
--> statement-breakpoint
CREATE POLICY healthkit_sync_metrics_select_active_member ON healthkit_sync_metrics
  FOR SELECT
  USING (
    EXISTS (
      SELECT 1 FROM family_memberships fm
      WHERE fm.family_id = healthkit_sync_metrics.family_id
        AND fm.user_id = auth.uid()
        AND fm.status = 'active'
    )
  );
--> statement-breakpoint
CREATE POLICY healthkit_sync_metrics_write_self ON healthkit_sync_metrics
  FOR ALL
  USING (
    EXISTS (
      SELECT 1 FROM people p
      WHERE p.id = healthkit_sync_metrics.person_id
        AND p.family_id = healthkit_sync_metrics.family_id
        AND p.linked_user_id = auth.uid()
        AND p.relationship_label = 'Self'
        AND p.status = 'active'
    )
  )
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM people p
      WHERE p.id = healthkit_sync_metrics.person_id
        AND p.family_id = healthkit_sync_metrics.family_id
        AND p.linked_user_id = auth.uid()
        AND p.relationship_label = 'Self'
        AND p.status = 'active'
    )
  );
--> statement-breakpoint
CREATE POLICY health_metric_sync_state_select_active_member ON health_metric_sync_state
  FOR SELECT
  USING (
    EXISTS (
      SELECT 1 FROM family_memberships fm
      WHERE fm.family_id = health_metric_sync_state.family_id
        AND fm.user_id = auth.uid()
        AND fm.status = 'active'
    )
  );
--> statement-breakpoint
CREATE POLICY health_metric_sync_state_write_self ON health_metric_sync_state
  FOR ALL
  USING (
    EXISTS (
      SELECT 1 FROM people p
      WHERE p.id = health_metric_sync_state.person_id
        AND p.family_id = health_metric_sync_state.family_id
        AND p.linked_user_id = auth.uid()
        AND p.relationship_label = 'Self'
        AND p.status = 'active'
    )
  )
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM people p
      WHERE p.id = health_metric_sync_state.person_id
        AND p.family_id = health_metric_sync_state.family_id
        AND p.linked_user_id = auth.uid()
        AND p.relationship_label = 'Self'
        AND p.status = 'active'
    )
  );
--> statement-breakpoint
CREATE POLICY healthkit_sync_installations_select_self ON healthkit_sync_installations
  FOR SELECT
  USING (
    EXISTS (
      SELECT 1 FROM people p
      WHERE p.id = healthkit_sync_installations.person_id
        AND p.family_id = healthkit_sync_installations.family_id
        AND p.linked_user_id = auth.uid()
        AND p.status = 'active'
    )
  );
--> statement-breakpoint
CREATE POLICY healthkit_sync_installations_write_self ON healthkit_sync_installations
  FOR ALL
  USING (
    EXISTS (
      SELECT 1 FROM people p
      WHERE p.id = healthkit_sync_installations.person_id
        AND p.family_id = healthkit_sync_installations.family_id
        AND p.linked_user_id = auth.uid()
        AND p.relationship_label = 'Self'
        AND p.status = 'active'
    )
  )
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM people p
      WHERE p.id = healthkit_sync_installations.person_id
        AND p.family_id = healthkit_sync_installations.family_id
        AND p.linked_user_id = auth.uid()
        AND p.relationship_label = 'Self'
        AND p.status = 'active'
    )
  );
--> statement-breakpoint
CREATE POLICY healthkit_repairs_select_self ON healthkit_repairs
  FOR SELECT
  USING (
    EXISTS (
      SELECT 1 FROM people p
      WHERE p.id = healthkit_repairs.person_id
        AND p.family_id = healthkit_repairs.family_id
        AND p.linked_user_id = auth.uid()
        AND p.status = 'active'
    )
  );
--> statement-breakpoint
CREATE POLICY healthkit_repairs_write_self ON healthkit_repairs
  FOR ALL
  USING (
    EXISTS (
      SELECT 1 FROM people p
      WHERE p.id = healthkit_repairs.person_id
        AND p.family_id = healthkit_repairs.family_id
        AND p.linked_user_id = auth.uid()
        AND p.relationship_label = 'Self'
        AND p.status = 'active'
    )
  )
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM people p
      WHERE p.id = healthkit_repairs.person_id
        AND p.family_id = healthkit_repairs.family_id
        AND p.linked_user_id = auth.uid()
        AND p.relationship_label = 'Self'
        AND p.status = 'active'
    )
  );
--> statement-breakpoint
CREATE POLICY healthkit_repair_chunks_select_self ON healthkit_repair_chunks
  FOR SELECT
  USING (
    EXISTS (
      SELECT 1
      FROM healthkit_repairs r
      JOIN people p ON p.id = r.person_id
      WHERE r.repair_id = healthkit_repair_chunks.repair_id
        AND p.linked_user_id = auth.uid()
        AND p.status = 'active'
    )
  );
--> statement-breakpoint
CREATE POLICY healthkit_repair_chunks_write_self ON healthkit_repair_chunks
  FOR ALL
  USING (
    EXISTS (
      SELECT 1
      FROM healthkit_repairs r
      JOIN people p ON p.id = r.person_id
      WHERE r.repair_id = healthkit_repair_chunks.repair_id
        AND p.linked_user_id = auth.uid()
        AND p.relationship_label = 'Self'
        AND p.status = 'active'
    )
  )
  WITH CHECK (
    EXISTS (
      SELECT 1
      FROM healthkit_repairs r
      JOIN people p ON p.id = r.person_id
      WHERE r.repair_id = healthkit_repair_chunks.repair_id
        AND p.linked_user_id = auth.uid()
        AND p.relationship_label = 'Self'
        AND p.status = 'active'
    )
  );
--> statement-breakpoint
CREATE POLICY healthkit_sync_receipts_select_self ON healthkit_sync_receipts
  FOR SELECT
  USING (user_id = auth.uid());
--> statement-breakpoint
CREATE POLICY healthkit_sync_receipts_write_self ON healthkit_sync_receipts
  FOR ALL
  USING (user_id = auth.uid())
  WITH CHECK (user_id = auth.uid());
