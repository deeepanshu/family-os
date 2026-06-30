CREATE TABLE "healthkit_samples" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"family_id" uuid NOT NULL,
	"person_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"sync_run_id" uuid NOT NULL,
	"metric_type" text NOT NULL,
	"source_sample_key" text NOT NULL,
	"start_date" timestamp with time zone NOT NULL,
	"end_date" timestamp with time zone,
	"value" numeric(12, 3),
	"unit" text,
	"systolic" integer,
	"diastolic" integer,
	"pulse" integer,
	"glucose_context" text,
	"imported_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone,
	CONSTRAINT "healthkit_samples_metric_check" CHECK ("healthkit_samples"."metric_type" in ('steps', 'walking_distance', 'sleep', 'weight', 'blood_pressure', 'blood_glucose')),
	CONSTRAINT "healthkit_samples_glucose_context_check" CHECK ("healthkit_samples"."glucose_context" is null or "healthkit_samples"."glucose_context" in ('fasting', 'before_meal', 'after_meal', 'bedtime', 'random'))
);
--> statement-breakpoint
CREATE TABLE "healthkit_sync_runs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"family_id" uuid NOT NULL,
	"person_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"status" text NOT NULL,
	"started_at" timestamp with time zone NOT NULL,
	"finished_at" timestamp with time zone NOT NULL,
	"imported_count" integer DEFAULT 0 NOT NULL,
	"skipped_count" integer DEFAULT 0 NOT NULL,
	"failed_count" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "healthkit_sync_runs_status_check" CHECK ("healthkit_sync_runs"."status" in ('completed', 'failed'))
);
--> statement-breakpoint
CREATE TABLE "healthkit_sync_settings" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"family_id" uuid NOT NULL,
	"person_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"metric_type" text NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "healthkit_sync_settings_metric_check" CHECK ("healthkit_sync_settings"."metric_type" in ('steps', 'walking_distance', 'sleep', 'weight', 'blood_pressure', 'blood_glucose'))
);
--> statement-breakpoint
CREATE TABLE "health_metric_daily_summaries" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"family_id" uuid NOT NULL,
	"person_id" uuid NOT NULL,
	"metric_type" text NOT NULL,
	"date" date NOT NULL,
	"value" numeric(12, 3) NOT NULL,
	"unit" text NOT NULL,
	"source" text DEFAULT 'healthkit' NOT NULL,
	"sample_count" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "health_metric_daily_summary_metric_check" CHECK ("health_metric_daily_summaries"."metric_type" in ('steps', 'walking_distance', 'sleep', 'weight', 'blood_pressure', 'blood_glucose')),
	CONSTRAINT "health_metric_daily_summary_source_check" CHECK ("health_metric_daily_summaries"."source" = 'healthkit')
);
--> statement-breakpoint
ALTER TABLE "blood_glucose_readings" ADD COLUMN "source" text DEFAULT 'manual' NOT NULL;--> statement-breakpoint
ALTER TABLE "blood_glucose_readings" ADD COLUMN "source_sample_key" text;--> statement-breakpoint
ALTER TABLE "blood_glucose_readings" ADD COLUMN "imported_by_user_id" uuid;--> statement-breakpoint
ALTER TABLE "blood_glucose_readings" ADD COLUMN "imported_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "blood_glucose_readings" ADD COLUMN "sync_run_id" uuid;--> statement-breakpoint
ALTER TABLE "blood_pressure_readings" ADD COLUMN "source" text DEFAULT 'manual' NOT NULL;--> statement-breakpoint
ALTER TABLE "blood_pressure_readings" ADD COLUMN "source_sample_key" text;--> statement-breakpoint
ALTER TABLE "blood_pressure_readings" ADD COLUMN "imported_by_user_id" uuid;--> statement-breakpoint
ALTER TABLE "blood_pressure_readings" ADD COLUMN "imported_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "blood_pressure_readings" ADD COLUMN "sync_run_id" uuid;--> statement-breakpoint
ALTER TABLE "healthkit_samples" ADD CONSTRAINT "healthkit_samples_family_id_families_id_fk" FOREIGN KEY ("family_id") REFERENCES "public"."families"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "healthkit_samples" ADD CONSTRAINT "healthkit_samples_person_id_people_id_fk" FOREIGN KEY ("person_id") REFERENCES "public"."people"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "healthkit_samples" ADD CONSTRAINT "healthkit_samples_sync_run_id_healthkit_sync_runs_id_fk" FOREIGN KEY ("sync_run_id") REFERENCES "public"."healthkit_sync_runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "healthkit_sync_runs" ADD CONSTRAINT "healthkit_sync_runs_family_id_families_id_fk" FOREIGN KEY ("family_id") REFERENCES "public"."families"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "healthkit_sync_runs" ADD CONSTRAINT "healthkit_sync_runs_person_id_people_id_fk" FOREIGN KEY ("person_id") REFERENCES "public"."people"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "healthkit_sync_settings" ADD CONSTRAINT "healthkit_sync_settings_family_id_families_id_fk" FOREIGN KEY ("family_id") REFERENCES "public"."families"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "healthkit_sync_settings" ADD CONSTRAINT "healthkit_sync_settings_person_id_people_id_fk" FOREIGN KEY ("person_id") REFERENCES "public"."people"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "health_metric_daily_summaries" ADD CONSTRAINT "health_metric_daily_summaries_family_id_families_id_fk" FOREIGN KEY ("family_id") REFERENCES "public"."families"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "health_metric_daily_summaries" ADD CONSTRAINT "health_metric_daily_summaries_person_id_people_id_fk" FOREIGN KEY ("person_id") REFERENCES "public"."people"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "healthkit_samples_person_source_idx" ON "healthkit_samples" USING btree ("person_id","source_sample_key");--> statement-breakpoint
CREATE INDEX "healthkit_samples_family_person_metric_idx" ON "healthkit_samples" USING btree ("family_id","person_id","metric_type","start_date");--> statement-breakpoint
CREATE INDEX "healthkit_sync_runs_user_started_idx" ON "healthkit_sync_runs" USING btree ("user_id","started_at");--> statement-breakpoint
CREATE UNIQUE INDEX "healthkit_sync_settings_user_metric_idx" ON "healthkit_sync_settings" USING btree ("user_id","metric_type");--> statement-breakpoint
CREATE UNIQUE INDEX "health_metric_daily_summary_unique_idx" ON "health_metric_daily_summaries" USING btree ("person_id","metric_type","date","source");--> statement-breakpoint
CREATE INDEX "health_metric_daily_summary_family_person_idx" ON "health_metric_daily_summaries" USING btree ("family_id","person_id","date");--> statement-breakpoint
CREATE UNIQUE INDEX "glucose_healthkit_source_sample_idx" ON "blood_glucose_readings" USING btree ("person_id","source_sample_key") WHERE "blood_glucose_readings"."source" = 'healthkit' and "blood_glucose_readings"."source_sample_key" is not null;--> statement-breakpoint
CREATE UNIQUE INDEX "bp_healthkit_source_sample_idx" ON "blood_pressure_readings" USING btree ("person_id","source_sample_key") WHERE "blood_pressure_readings"."source" = 'healthkit' and "blood_pressure_readings"."source_sample_key" is not null;--> statement-breakpoint
ALTER TABLE "blood_glucose_readings" ADD CONSTRAINT "glucose_source_check" CHECK ("blood_glucose_readings"."source" in ('manual', 'healthkit'));--> statement-breakpoint
ALTER TABLE "blood_pressure_readings" ADD CONSTRAINT "bp_source_check" CHECK ("blood_pressure_readings"."source" in ('manual', 'healthkit'));
--> statement-breakpoint
ALTER TABLE "blood_glucose_readings" ADD CONSTRAINT "blood_glucose_readings_imported_by_user_id_users_id_fk" FOREIGN KEY ("imported_by_user_id") REFERENCES "auth"."users"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "blood_pressure_readings" ADD CONSTRAINT "blood_pressure_readings_imported_by_user_id_users_id_fk" FOREIGN KEY ("imported_by_user_id") REFERENCES "auth"."users"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "healthkit_samples" ADD CONSTRAINT "healthkit_samples_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "auth"."users"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "healthkit_sync_runs" ADD CONSTRAINT "healthkit_sync_runs_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "auth"."users"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "healthkit_sync_settings" ADD CONSTRAINT "healthkit_sync_settings_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "auth"."users"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE healthkit_samples ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE healthkit_sync_runs ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE healthkit_sync_settings ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE health_metric_daily_summaries ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY healthkit_samples_select_active_member ON healthkit_samples
  FOR SELECT
  USING (
    EXISTS (
      SELECT 1
      FROM family_memberships fm
      WHERE fm.family_id = healthkit_samples.family_id
        AND fm.user_id = auth.uid()
        AND fm.status = 'active'
    )
  );
--> statement-breakpoint
CREATE POLICY healthkit_samples_insert_self ON healthkit_samples
  FOR INSERT
  WITH CHECK (
    user_id = auth.uid()
    AND EXISTS (
      SELECT 1
      FROM people p
      WHERE p.id = healthkit_samples.person_id
        AND p.family_id = healthkit_samples.family_id
        AND p.linked_user_id = auth.uid()
        AND p.status = 'active'
    )
  );
--> statement-breakpoint
CREATE POLICY healthkit_sync_runs_select_active_member ON healthkit_sync_runs
  FOR SELECT
  USING (
    EXISTS (
      SELECT 1
      FROM family_memberships fm
      WHERE fm.family_id = healthkit_sync_runs.family_id
        AND fm.user_id = auth.uid()
        AND fm.status = 'active'
    )
  );
--> statement-breakpoint
CREATE POLICY healthkit_sync_runs_insert_self ON healthkit_sync_runs
  FOR INSERT
  WITH CHECK (
    user_id = auth.uid()
    AND EXISTS (
      SELECT 1
      FROM people p
      WHERE p.id = healthkit_sync_runs.person_id
        AND p.family_id = healthkit_sync_runs.family_id
        AND p.linked_user_id = auth.uid()
        AND p.status = 'active'
    )
  );
--> statement-breakpoint
CREATE POLICY healthkit_sync_runs_update_self ON healthkit_sync_runs
  FOR UPDATE
  USING (user_id = auth.uid())
  WITH CHECK (user_id = auth.uid());
--> statement-breakpoint
CREATE POLICY healthkit_sync_settings_select_active_member ON healthkit_sync_settings
  FOR SELECT
  USING (
    EXISTS (
      SELECT 1
      FROM family_memberships fm
      WHERE fm.family_id = healthkit_sync_settings.family_id
        AND fm.user_id = auth.uid()
        AND fm.status = 'active'
    )
  );
--> statement-breakpoint
CREATE POLICY healthkit_sync_settings_insert_self ON healthkit_sync_settings
  FOR INSERT
  WITH CHECK (
    user_id = auth.uid()
    AND EXISTS (
      SELECT 1
      FROM people p
      WHERE p.id = healthkit_sync_settings.person_id
        AND p.family_id = healthkit_sync_settings.family_id
        AND p.linked_user_id = auth.uid()
        AND p.status = 'active'
    )
  );
--> statement-breakpoint
CREATE POLICY healthkit_sync_settings_delete_self ON healthkit_sync_settings
  FOR DELETE
  USING (user_id = auth.uid());
--> statement-breakpoint
CREATE POLICY health_metric_daily_summaries_select_active_member ON health_metric_daily_summaries
  FOR SELECT
  USING (
    EXISTS (
      SELECT 1
      FROM family_memberships fm
      WHERE fm.family_id = health_metric_daily_summaries.family_id
        AND fm.user_id = auth.uid()
        AND fm.status = 'active'
    )
  );
--> statement-breakpoint
CREATE POLICY health_metric_daily_summaries_insert_self_linked_profile ON health_metric_daily_summaries
  FOR INSERT
  WITH CHECK (
    EXISTS (
      SELECT 1
      FROM people p
      WHERE p.id = health_metric_daily_summaries.person_id
        AND p.family_id = health_metric_daily_summaries.family_id
        AND p.linked_user_id = auth.uid()
        AND p.status = 'active'
    )
  );
--> statement-breakpoint
CREATE POLICY health_metric_daily_summaries_delete_self_linked_profile ON health_metric_daily_summaries
  FOR DELETE
  USING (
    EXISTS (
      SELECT 1
      FROM people p
      WHERE p.id = health_metric_daily_summaries.person_id
        AND p.family_id = health_metric_daily_summaries.family_id
        AND p.linked_user_id = auth.uid()
        AND p.status = 'active'
    )
  );
--> statement-breakpoint
CREATE TRIGGER healthkit_sync_settings_set_updated_at
BEFORE UPDATE ON healthkit_sync_settings
FOR EACH ROW
EXECUTE FUNCTION set_updated_at();
--> statement-breakpoint
CREATE TRIGGER health_metric_daily_summaries_set_updated_at
BEFORE UPDATE ON health_metric_daily_summaries
FOR EACH ROW
EXECUTE FUNCTION set_updated_at();
