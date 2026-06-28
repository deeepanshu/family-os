CREATE TABLE "audit_logs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"family_id" uuid NOT NULL,
	"actor_user_id" uuid,
	"action" text NOT NULL,
	"resource_type" text NOT NULL,
	"resource_id" uuid NOT NULL,
	"metadata" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "blood_glucose_readings" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"family_id" uuid NOT NULL,
	"person_id" uuid NOT NULL,
	"recorded_by_user_id" uuid NOT NULL,
	"value" numeric(6, 2) NOT NULL,
	"unit" text NOT NULL,
	"context" text NOT NULL,
	"measured_at" timestamp with time zone NOT NULL,
	"notes" text,
	"deleted_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "glucose_value_check" CHECK ("blood_glucose_readings"."value" between 20 and 700),
	CONSTRAINT "glucose_unit_check" CHECK ("blood_glucose_readings"."unit" = 'mg/dL'),
	CONSTRAINT "glucose_context_check" CHECK ("blood_glucose_readings"."context" in ('fasting', 'before_meal', 'after_meal', 'bedtime', 'random'))
);
--> statement-breakpoint
CREATE TABLE "blood_pressure_readings" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"family_id" uuid NOT NULL,
	"person_id" uuid NOT NULL,
	"recorded_by_user_id" uuid NOT NULL,
	"systolic" integer NOT NULL,
	"diastolic" integer NOT NULL,
	"pulse" integer,
	"measured_at" timestamp with time zone NOT NULL,
	"context" text,
	"notes" text,
	"deleted_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "bp_systolic_check" CHECK ("blood_pressure_readings"."systolic" between 50 and 260),
	CONSTRAINT "bp_diastolic_check" CHECK ("blood_pressure_readings"."diastolic" between 30 and 180),
	CONSTRAINT "bp_pulse_check" CHECK ("blood_pressure_readings"."pulse" is null or "blood_pressure_readings"."pulse" between 30 and 220)
);
--> statement-breakpoint
CREATE TABLE "families" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"created_by_user_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "family_invites" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"family_id" uuid NOT NULL,
	"invited_by_user_id" uuid NOT NULL,
	"email" text,
	"token_hash" text NOT NULL,
	"role" text NOT NULL,
	"status" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"accepted_by_user_id" uuid,
	"accepted_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "family_invites_role_check" CHECK ("family_invites"."role" in ('manager', 'member')),
	CONSTRAINT "family_invites_status_check" CHECK ("family_invites"."status" in ('pending', 'accepted', 'revoked', 'expired'))
);
--> statement-breakpoint
CREATE TABLE "family_memberships" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"family_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"role" text NOT NULL,
	"status" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "family_memberships_role_check" CHECK ("family_memberships"."role" in ('manager', 'member')),
	CONSTRAINT "family_memberships_status_check" CHECK ("family_memberships"."status" in ('active', 'invited', 'removed'))
);
--> statement-breakpoint
CREATE TABLE "notification_deliveries" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"reminder_id" uuid NOT NULL,
	"recipient_user_id" uuid NOT NULL,
	"status" text NOT NULL,
	"scheduled_for" timestamp with time zone NOT NULL,
	"sent_at" timestamp with time zone,
	"opened_at" timestamp with time zone,
	"error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "notification_deliveries_status_check" CHECK ("notification_deliveries"."status" in ('pending', 'sent', 'failed', 'opened'))
);
--> statement-breakpoint
CREATE TABLE "notification_devices" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"device_token" text NOT NULL,
	"platform" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "notification_devices_platform_check" CHECK ("notification_devices"."platform" = 'ios')
);
--> statement-breakpoint
CREATE TABLE "people" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"family_id" uuid NOT NULL,
	"linked_user_id" uuid,
	"created_by_user_id" uuid NOT NULL,
	"display_name" text NOT NULL,
	"relationship_label" text,
	"date_of_birth" date,
	"status" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "people_status_check" CHECK ("people"."status" in ('active', 'inactive'))
);
--> statement-breakpoint
CREATE TABLE "reminder_recipients" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"reminder_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"disabled_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "reminders" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"family_id" uuid NOT NULL,
	"subject_person_id" uuid,
	"created_by_user_id" uuid NOT NULL,
	"type" text NOT NULL,
	"title" text NOT NULL,
	"message" text NOT NULL,
	"schedule_kind" text NOT NULL,
	"time_of_day" time,
	"timezone" text NOT NULL,
	"days_of_week" integer[],
	"starts_on" date,
	"ends_on" date,
	"enabled" boolean DEFAULT true NOT NULL,
	"deleted_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "reminders_type_check" CHECK ("reminders"."type" in ('generic', 'blood_glucose', 'blood_pressure')),
	CONSTRAINT "reminders_schedule_kind_check" CHECK ("reminders"."schedule_kind" in ('once', 'daily', 'weekly', 'custom_days'))
);
--> statement-breakpoint
ALTER TABLE "audit_logs" ADD CONSTRAINT "audit_logs_family_id_families_id_fk" FOREIGN KEY ("family_id") REFERENCES "public"."families"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "blood_glucose_readings" ADD CONSTRAINT "blood_glucose_readings_family_id_families_id_fk" FOREIGN KEY ("family_id") REFERENCES "public"."families"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "blood_glucose_readings" ADD CONSTRAINT "blood_glucose_readings_person_id_people_id_fk" FOREIGN KEY ("person_id") REFERENCES "public"."people"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "blood_pressure_readings" ADD CONSTRAINT "blood_pressure_readings_family_id_families_id_fk" FOREIGN KEY ("family_id") REFERENCES "public"."families"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "blood_pressure_readings" ADD CONSTRAINT "blood_pressure_readings_person_id_people_id_fk" FOREIGN KEY ("person_id") REFERENCES "public"."people"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "family_invites" ADD CONSTRAINT "family_invites_family_id_families_id_fk" FOREIGN KEY ("family_id") REFERENCES "public"."families"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "family_memberships" ADD CONSTRAINT "family_memberships_family_id_families_id_fk" FOREIGN KEY ("family_id") REFERENCES "public"."families"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notification_deliveries" ADD CONSTRAINT "notification_deliveries_reminder_id_reminders_id_fk" FOREIGN KEY ("reminder_id") REFERENCES "public"."reminders"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "people" ADD CONSTRAINT "people_family_id_families_id_fk" FOREIGN KEY ("family_id") REFERENCES "public"."families"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reminder_recipients" ADD CONSTRAINT "reminder_recipients_reminder_id_reminders_id_fk" FOREIGN KEY ("reminder_id") REFERENCES "public"."reminders"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reminders" ADD CONSTRAINT "reminders_family_id_families_id_fk" FOREIGN KEY ("family_id") REFERENCES "public"."families"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reminders" ADD CONSTRAINT "reminders_subject_person_id_people_id_fk" FOREIGN KEY ("subject_person_id") REFERENCES "public"."people"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "audit_logs_family_created_idx" ON "audit_logs" USING btree ("family_id","created_at");--> statement-breakpoint
CREATE INDEX "audit_logs_resource_idx" ON "audit_logs" USING btree ("resource_type","resource_id");--> statement-breakpoint
CREATE INDEX "glucose_family_person_measured_idx" ON "blood_glucose_readings" USING btree ("family_id","person_id","measured_at") WHERE "blood_glucose_readings"."deleted_at" is null;--> statement-breakpoint
CREATE INDEX "bp_family_person_measured_idx" ON "blood_pressure_readings" USING btree ("family_id","person_id","measured_at") WHERE "blood_pressure_readings"."deleted_at" is null;--> statement-breakpoint
CREATE UNIQUE INDEX "family_invites_token_hash_idx" ON "family_invites" USING btree ("token_hash");--> statement-breakpoint
CREATE UNIQUE INDEX "family_memberships_family_user_idx" ON "family_memberships" USING btree ("family_id","user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "family_memberships_one_active_family_per_user_idx" ON "family_memberships" USING btree ("user_id") WHERE "family_memberships"."status" = 'active';--> statement-breakpoint
CREATE UNIQUE INDEX "notification_devices_user_token_idx" ON "notification_devices" USING btree ("user_id","device_token");--> statement-breakpoint
CREATE UNIQUE INDEX "reminder_recipients_reminder_user_idx" ON "reminder_recipients" USING btree ("reminder_id","user_id");