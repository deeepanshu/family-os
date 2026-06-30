import { sql } from "drizzle-orm";
import { boolean, check, date, index, integer, jsonb, numeric, pgTable, text, time, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";

export const families = pgTable("families", {
  id: uuid("id").primaryKey().defaultRandom(),
  name: text("name").notNull(),
  createdByUserId: uuid("created_by_user_id").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow()
});

export const familyMemberships = pgTable(
  "family_memberships",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    familyId: uuid("family_id")
      .notNull()
      .references(() => families.id, { onDelete: "cascade" }),
    userId: uuid("user_id").notNull(),
    role: text("role", { enum: ["manager", "member"] }).notNull(),
    status: text("status", { enum: ["active", "invited", "removed"] }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow()
  },
  (table) => [
    uniqueIndex("family_memberships_family_user_idx").on(table.familyId, table.userId),
    uniqueIndex("family_memberships_one_active_family_per_user_idx")
      .on(table.userId)
      .where(sql`${table.status} = 'active'`),
    check("family_memberships_role_check", sql`${table.role} in ('manager', 'member')`),
    check("family_memberships_status_check", sql`${table.status} in ('active', 'invited', 'removed')`)
  ]
);

export const familyInvites = pgTable(
  "family_invites",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    familyId: uuid("family_id")
      .notNull()
      .references(() => families.id, { onDelete: "cascade" }),
    invitedByUserId: uuid("invited_by_user_id").notNull(),
    email: text("email"),
    tokenHash: text("token_hash").notNull(),
    role: text("role", { enum: ["manager", "member"] }).notNull(),
    status: text("status", { enum: ["pending", "accepted", "revoked", "expired"] }).notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    acceptedByUserId: uuid("accepted_by_user_id"),
    acceptedAt: timestamp("accepted_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow()
  },
  (table) => [
    uniqueIndex("family_invites_token_hash_idx").on(table.tokenHash),
    check("family_invites_role_check", sql`${table.role} in ('manager', 'member')`),
    check("family_invites_status_check", sql`${table.status} in ('pending', 'accepted', 'revoked', 'expired')`)
  ]
);

export const people = pgTable(
  "people",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    familyId: uuid("family_id")
      .notNull()
      .references(() => families.id, { onDelete: "cascade" }),
    linkedUserId: uuid("linked_user_id"),
    createdByUserId: uuid("created_by_user_id").notNull(),
    displayName: text("display_name").notNull(),
    relationshipLabel: text("relationship_label"),
    dateOfBirth: date("date_of_birth"),
    status: text("status", { enum: ["active", "inactive"] }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow()
  },
  (table) => [
    check("people_status_check", sql`${table.status} in ('active', 'inactive')`)
  ]
);

export const bloodPressureReadings = pgTable(
  "blood_pressure_readings",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    familyId: uuid("family_id")
      .notNull()
      .references(() => families.id, { onDelete: "cascade" }),
    personId: uuid("person_id")
      .notNull()
      .references(() => people.id, { onDelete: "cascade" }),
    recordedByUserId: uuid("recorded_by_user_id").notNull(),
    systolic: integer("systolic").notNull(),
    diastolic: integer("diastolic").notNull(),
    pulse: integer("pulse"),
    measuredAt: timestamp("measured_at", { withTimezone: true }).notNull(),
    context: text("context"),
    notes: text("notes"),
    source: text("source", { enum: ["manual", "healthkit"] }).notNull().default("manual"),
    sourceSampleKey: text("source_sample_key"),
    importedByUserId: uuid("imported_by_user_id"),
    importedAt: timestamp("imported_at", { withTimezone: true }),
    syncRunId: uuid("sync_run_id"),
    deletedAt: timestamp("deleted_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow()
  },
  (table) => [
    check("bp_systolic_check", sql`${table.systolic} between 50 and 260`),
    check("bp_diastolic_check", sql`${table.diastolic} between 30 and 180`),
    check("bp_pulse_check", sql`${table.pulse} is null or ${table.pulse} between 30 and 220`),
    check("bp_source_check", sql`${table.source} in ('manual', 'healthkit')`),
    index("bp_family_person_measured_idx")
      .on(table.familyId, table.personId, table.measuredAt)
      .where(sql`${table.deletedAt} is null`),
    uniqueIndex("bp_healthkit_source_sample_idx")
      .on(table.personId, table.sourceSampleKey)
      .where(sql`${table.source} = 'healthkit' and ${table.sourceSampleKey} is not null`)
  ]
);

export const bloodGlucoseReadings = pgTable(
  "blood_glucose_readings",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    familyId: uuid("family_id")
      .notNull()
      .references(() => families.id, { onDelete: "cascade" }),
    personId: uuid("person_id")
      .notNull()
      .references(() => people.id, { onDelete: "cascade" }),
    recordedByUserId: uuid("recorded_by_user_id").notNull(),
    value: numeric("value", { precision: 6, scale: 2 }).notNull(),
    unit: text("unit", { enum: ["mg/dL"] }).notNull(),
    context: text("context", { enum: ["fasting", "before_meal", "after_meal", "bedtime", "random"] }).notNull(),
    measuredAt: timestamp("measured_at", { withTimezone: true }).notNull(),
    notes: text("notes"),
    source: text("source", { enum: ["manual", "healthkit"] }).notNull().default("manual"),
    sourceSampleKey: text("source_sample_key"),
    importedByUserId: uuid("imported_by_user_id"),
    importedAt: timestamp("imported_at", { withTimezone: true }),
    syncRunId: uuid("sync_run_id"),
    deletedAt: timestamp("deleted_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow()
  },
  (table) => [
    check("glucose_value_check", sql`${table.value} between 20 and 700`),
    check("glucose_unit_check", sql`${table.unit} = 'mg/dL'`),
    check("glucose_context_check", sql`${table.context} in ('fasting', 'before_meal', 'after_meal', 'bedtime', 'random')`),
    check("glucose_source_check", sql`${table.source} in ('manual', 'healthkit')`),
    index("glucose_family_person_measured_idx")
      .on(table.familyId, table.personId, table.measuredAt)
      .where(sql`${table.deletedAt} is null`),
    uniqueIndex("glucose_healthkit_source_sample_idx")
      .on(table.personId, table.sourceSampleKey)
      .where(sql`${table.source} = 'healthkit' and ${table.sourceSampleKey} is not null`)
  ]
);

export const healthKitSyncSettings = pgTable(
  "healthkit_sync_settings",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    familyId: uuid("family_id")
      .notNull()
      .references(() => families.id, { onDelete: "cascade" }),
    personId: uuid("person_id")
      .notNull()
      .references(() => people.id, { onDelete: "cascade" }),
    userId: uuid("user_id").notNull(),
    metricType: text("metric_type").notNull(),
    enabled: boolean("enabled").notNull().default(true),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow()
  },
  (table) => [
    uniqueIndex("healthkit_sync_settings_user_metric_idx").on(table.userId, table.metricType),
    check("healthkit_sync_settings_metric_check", sql`${table.metricType} in ('steps', 'walking_distance', 'sleep', 'weight', 'blood_pressure', 'blood_glucose')`)
  ]
);

export const healthKitSyncRuns = pgTable(
  "healthkit_sync_runs",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    familyId: uuid("family_id")
      .notNull()
      .references(() => families.id, { onDelete: "cascade" }),
    personId: uuid("person_id")
      .notNull()
      .references(() => people.id, { onDelete: "cascade" }),
    userId: uuid("user_id").notNull(),
    status: text("status").notNull(),
    startedAt: timestamp("started_at", { withTimezone: true }).notNull(),
    finishedAt: timestamp("finished_at", { withTimezone: true }).notNull(),
    importedCount: integer("imported_count").notNull().default(0),
    skippedCount: integer("skipped_count").notNull().default(0),
    failedCount: integer("failed_count").notNull().default(0),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow()
  },
  (table) => [
    index("healthkit_sync_runs_user_started_idx").on(table.userId, table.startedAt),
    check("healthkit_sync_runs_status_check", sql`${table.status} in ('completed', 'failed')`)
  ]
);

export const healthKitSamples = pgTable(
  "healthkit_samples",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    familyId: uuid("family_id")
      .notNull()
      .references(() => families.id, { onDelete: "cascade" }),
    personId: uuid("person_id")
      .notNull()
      .references(() => people.id, { onDelete: "cascade" }),
    userId: uuid("user_id").notNull(),
    syncRunId: uuid("sync_run_id")
      .notNull()
      .references(() => healthKitSyncRuns.id, { onDelete: "cascade" }),
    metricType: text("metric_type").notNull(),
    sourceSampleKey: text("source_sample_key").notNull(),
    startDate: timestamp("start_date", { withTimezone: true }).notNull(),
    endDate: timestamp("end_date", { withTimezone: true }),
    value: numeric("value", { precision: 12, scale: 3 }),
    unit: text("unit"),
    systolic: integer("systolic"),
    diastolic: integer("diastolic"),
    pulse: integer("pulse"),
    glucoseContext: text("glucose_context"),
    importedAt: timestamp("imported_at", { withTimezone: true }).notNull().defaultNow(),
    deletedAt: timestamp("deleted_at", { withTimezone: true })
  },
  (table) => [
    uniqueIndex("healthkit_samples_person_source_idx").on(table.personId, table.sourceSampleKey),
    index("healthkit_samples_family_person_metric_idx").on(table.familyId, table.personId, table.metricType, table.startDate),
    check("healthkit_samples_metric_check", sql`${table.metricType} in ('steps', 'walking_distance', 'sleep', 'weight', 'blood_pressure', 'blood_glucose')`),
    check("healthkit_samples_glucose_context_check", sql`${table.glucoseContext} is null or ${table.glucoseContext} in ('fasting', 'before_meal', 'after_meal', 'bedtime', 'random')`)
  ]
);

export const healthMetricDailySummaries = pgTable(
  "health_metric_daily_summaries",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    familyId: uuid("family_id")
      .notNull()
      .references(() => families.id, { onDelete: "cascade" }),
    personId: uuid("person_id")
      .notNull()
      .references(() => people.id, { onDelete: "cascade" }),
    metricType: text("metric_type").notNull(),
    date: date("date").notNull(),
    value: numeric("value", { precision: 12, scale: 3 }).notNull(),
    unit: text("unit").notNull(),
    source: text("source").notNull().default("healthkit"),
    sampleCount: integer("sample_count").notNull().default(0),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow()
  },
  (table) => [
    uniqueIndex("health_metric_daily_summary_unique_idx").on(table.personId, table.metricType, table.date, table.source),
    index("health_metric_daily_summary_family_person_idx").on(table.familyId, table.personId, table.date),
    check("health_metric_daily_summary_metric_check", sql`${table.metricType} in ('steps', 'walking_distance', 'sleep', 'weight', 'blood_pressure', 'blood_glucose')`),
    check("health_metric_daily_summary_source_check", sql`${table.source} = 'healthkit'`)
  ]
);

export const reminders = pgTable(
  "reminders",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    familyId: uuid("family_id")
      .notNull()
      .references(() => families.id, { onDelete: "cascade" }),
    subjectPersonId: uuid("subject_person_id").references(() => people.id),
    createdByUserId: uuid("created_by_user_id").notNull(),
    type: text("type", { enum: ["generic", "blood_glucose", "blood_pressure"] }).notNull(),
    title: text("title").notNull(),
    message: text("message").notNull(),
    scheduleKind: text("schedule_kind", { enum: ["once", "daily", "weekly", "custom_days"] }).notNull(),
    timeOfDay: time("time_of_day"),
    timezone: text("timezone").notNull(),
    daysOfWeek: integer("days_of_week").array(),
    startsOn: date("starts_on"),
    endsOn: date("ends_on"),
    enabled: boolean("enabled").notNull().default(true),
    deletedAt: timestamp("deleted_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow()
  },
  (table) => [
    check("reminders_type_check", sql`${table.type} in ('generic', 'blood_glucose', 'blood_pressure')`),
    check("reminders_schedule_kind_check", sql`${table.scheduleKind} in ('once', 'daily', 'weekly', 'custom_days')`)
  ]
);

export const reminderRecipients = pgTable(
  "reminder_recipients",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    reminderId: uuid("reminder_id")
      .notNull()
      .references(() => reminders.id, { onDelete: "cascade" }),
    userId: uuid("user_id").notNull(),
    enabled: boolean("enabled").notNull().default(true),
    disabledAt: timestamp("disabled_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow()
  },
  (table) => [uniqueIndex("reminder_recipients_reminder_user_idx").on(table.reminderId, table.userId)]
);

export const notificationDevices = pgTable(
  "notification_devices",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id").notNull(),
    deviceToken: text("device_token").notNull(),
    platform: text("platform", { enum: ["ios"] }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    lastSeenAt: timestamp("last_seen_at", { withTimezone: true }).notNull().defaultNow()
  },
  (table) => [
    uniqueIndex("notification_devices_user_token_idx").on(table.userId, table.deviceToken),
    check("notification_devices_platform_check", sql`${table.platform} = 'ios'`)
  ]
);

export const notificationDeliveries = pgTable(
  "notification_deliveries",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    reminderId: uuid("reminder_id")
      .notNull()
      .references(() => reminders.id, { onDelete: "cascade" }),
    recipientUserId: uuid("recipient_user_id").notNull(),
    status: text("status", { enum: ["pending", "sent", "failed", "opened"] }).notNull(),
    scheduledFor: timestamp("scheduled_for", { withTimezone: true }).notNull(),
    sentAt: timestamp("sent_at", { withTimezone: true }),
    openedAt: timestamp("opened_at", { withTimezone: true }),
    error: text("error"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow()
  },
  (table) => [
    check("notification_deliveries_status_check", sql`${table.status} in ('pending', 'sent', 'failed', 'opened')`)
  ]
);

export const auditLogs = pgTable(
  "audit_logs",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    familyId: uuid("family_id")
      .notNull()
      .references(() => families.id, { onDelete: "cascade" }),
    actorUserId: uuid("actor_user_id"),
    action: text("action").notNull(),
    resourceType: text("resource_type").notNull(),
    resourceId: uuid("resource_id").notNull(),
    metadata: jsonb("metadata"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow()
  },
  (table) => [
    index("audit_logs_family_created_idx").on(table.familyId, table.createdAt),
    index("audit_logs_resource_idx").on(table.resourceType, table.resourceId)
  ]
);
