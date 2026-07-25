import { sql } from "drizzle-orm";
import { boolean, check, date, index, integer, jsonb, numeric, pgTable, text, time, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";

export const families = pgTable(
  "families",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    name: text("name").notNull(),
    kind: text("kind", { enum: ["personal", "family"] }).notNull().default("family"),
    createdByUserId: uuid("created_by_user_id").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow()
  },
  (table) => [check("families_kind_check", sql`${table.kind} in ('personal', 'family')`)]
);

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

export const healthStepHours = pgTable(
  "health_step_hours",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    familyId: uuid("family_id")
      .notNull()
      .references(() => families.id, { onDelete: "cascade" }),
    personId: uuid("person_id")
      .notNull()
      .references(() => people.id, { onDelete: "cascade" }),
    hourStartUtc: timestamp("hour_start_utc", { withTimezone: true }).notNull(),
    count: integer("count").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow()
  },
  (table) => [
    uniqueIndex("health_step_hours_person_hour_idx").on(table.personId, table.hourStartUtc),
    index("health_step_hours_family_person_hour_idx").on(table.familyId, table.personId, table.hourStartUtc),
    check("health_step_hours_count_check", sql`${table.count} >= 0`)
  ]
);

export const healthSleepDays = pgTable(
  "health_sleep_days",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    familyId: uuid("family_id")
      .notNull()
      .references(() => families.id, { onDelete: "cascade" }),
    personId: uuid("person_id")
      .notNull()
      .references(() => people.id, { onDelete: "cascade" }),
    sleepDay: date("sleep_day").notNull(),
    timezoneVersion: integer("timezone_version").notNull(),
    durationMinutes: integer("duration_minutes").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow()
  },
  (table) => [
    uniqueIndex("health_sleep_days_person_day_version_idx").on(table.personId, table.sleepDay, table.timezoneVersion),
    index("health_sleep_days_family_person_day_idx").on(table.familyId, table.personId, table.sleepDay),
    check("health_sleep_days_duration_check", sql`${table.durationMinutes} >= 0`),
    check("health_sleep_days_timezone_version_check", sql`${table.timezoneVersion} >= 1`)
  ]
);

export const healthkitSyncProfileSettings = pgTable(
  "healthkit_sync_profile_settings",
  {
    personId: uuid("person_id")
      .primaryKey()
      .references(() => people.id, { onDelete: "cascade" }),
    familyId: uuid("family_id")
      .notNull()
      .references(() => families.id, { onDelete: "cascade" }),
    userId: uuid("user_id").notNull(),
    consentVersion: text("consent_version"),
    consentedAt: timestamp("consented_at", { withTimezone: true }),
    healthTimezone: text("health_timezone").notNull(),
    healthTimezoneVersion: integer("health_timezone_version").notNull().default(1),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow()
  },
  (table) => [check("healthkit_sync_profile_settings_tz_version_check", sql`${table.healthTimezoneVersion} >= 1`)]
);

export const healthkitSyncMetrics = pgTable(
  "healthkit_sync_metrics",
  {
    personId: uuid("person_id")
      .notNull()
      .references(() => people.id, { onDelete: "cascade" }),
    familyId: uuid("family_id")
      .notNull()
      .references(() => families.id, { onDelete: "cascade" }),
    metric: text("metric").notNull(),
    enabled: boolean("enabled").notNull().default(false),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow()
  },
  (table) => [
    uniqueIndex("healthkit_sync_metrics_person_metric_idx").on(table.personId, table.metric),
    check("healthkit_sync_metrics_metric_check", sql`${table.metric} in ('steps', 'sleep', 'blood_pressure')`)
  ]
);

export const healthMetricSyncState = pgTable(
  "health_metric_sync_state",
  {
    personId: uuid("person_id")
      .notNull()
      .references(() => people.id, { onDelete: "cascade" }),
    familyId: uuid("family_id")
      .notNull()
      .references(() => families.id, { onDelete: "cascade" }),
    metric: text("metric").notNull(),
    lastSuccessfulAt: timestamp("last_successful_at", { withTimezone: true }),
    lastAttemptAt: timestamp("last_attempt_at", { withTimezone: true }),
    lastErrorCode: text("last_error_code"),
    coverageStartAt: timestamp("coverage_start_at", { withTimezone: true }),
    coverageEndAt: timestamp("coverage_end_at", { withTimezone: true }),
    status: text("status").notNull().default("never_synced"),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow()
  },
  (table) => [
    uniqueIndex("health_metric_sync_state_person_metric_idx").on(table.personId, table.metric),
    check("health_metric_sync_state_metric_check", sql`${table.metric} in ('steps', 'sleep', 'blood_pressure')`),
    check(
      "health_metric_sync_state_status_check",
      sql`${table.status} in ('never_synced', 'ready', 'repairing', 'repair_needed', 'error', 'disabled')`
    )
  ]
);

export const healthkitSyncInstallations = pgTable(
  "healthkit_sync_installations",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    personId: uuid("person_id")
      .notNull()
      .references(() => people.id, { onDelete: "cascade" }),
    familyId: uuid("family_id")
      .notNull()
      .references(() => families.id, { onDelete: "cascade" }),
    installationId: uuid("installation_id").notNull(),
    activatedAt: timestamp("activated_at", { withTimezone: true }).notNull().defaultNow(),
    revokedAt: timestamp("revoked_at", { withTimezone: true })
  },
  (table) => [
    uniqueIndex("healthkit_sync_installations_person_installation_idx").on(table.personId, table.installationId),
    uniqueIndex("healthkit_sync_installations_one_active_per_person_idx")
      .on(table.personId)
      .where(sql`${table.revokedAt} is null`)
  ]
);

export const healthkitRepairs = pgTable(
  "healthkit_repairs",
  {
    repairId: uuid("repair_id").primaryKey().defaultRandom(),
    personId: uuid("person_id")
      .notNull()
      .references(() => people.id, { onDelete: "cascade" }),
    familyId: uuid("family_id")
      .notNull()
      .references(() => families.id, { onDelete: "cascade" }),
    metric: text("metric").notNull(),
    installationId: uuid("installation_id").notNull(),
    timezoneVersion: integer("timezone_version").notNull(),
    rangeStart: timestamp("range_start", { withTimezone: true }).notNull(),
    rangeEnd: timestamp("range_end", { withTimezone: true }).notNull(),
    rangeStartDay: date("range_start_day").notNull(),
    rangeEndDay: date("range_end_day").notNull(),
    expectedChunkCount: integer("expected_chunk_count"),
    completedAt: timestamp("completed_at", { withTimezone: true }),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow()
  },
  (table) => [
    index("healthkit_repairs_person_metric_idx").on(table.personId, table.metric, table.createdAt),
    check("healthkit_repairs_metric_check", sql`${table.metric} in ('steps', 'sleep', 'blood_pressure')`),
    check("healthkit_repairs_tz_version_check", sql`${table.timezoneVersion} >= 1`),
    check("healthkit_repairs_day_order_check", sql`${table.rangeStartDay} <= ${table.rangeEndDay}`)
  ]
);

export const healthkitRepairChunks = pgTable(
  "healthkit_repair_chunks",
  {
    repairId: uuid("repair_id")
      .notNull()
      .references(() => healthkitRepairs.repairId, { onDelete: "cascade" }),
    chunkIndex: integer("chunk_index").notNull(),
    syncId: uuid("sync_id").notNull(),
    responseJson: jsonb("response_json").notNull(),
    completedAt: timestamp("completed_at", { withTimezone: true }).notNull().defaultNow()
  },
  (table) => [
    uniqueIndex("healthkit_repair_chunks_repair_chunk_idx").on(table.repairId, table.chunkIndex),
    check("healthkit_repair_chunks_index_check", sql`${table.chunkIndex} >= 0`)
  ]
);

export const healthkitSyncReceipts = pgTable(
  "healthkit_sync_receipts",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id").notNull(),
    personId: uuid("person_id")
      .notNull()
      .references(() => people.id, { onDelete: "cascade" }),
    familyId: uuid("family_id")
      .notNull()
      .references(() => families.id, { onDelete: "cascade" }),
    syncId: uuid("sync_id").notNull(),
    responseJson: jsonb("response_json").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow()
  },
  (table) => [uniqueIndex("healthkit_sync_receipts_user_person_sync_idx").on(table.userId, table.personId, table.syncId)]
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

export const mcpConnectionGrants = pgTable(
  "mcp_connection_grants",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id").notNull(),
    oauthClientId: text("oauth_client_id").notNull(),
    capabilities: text("capabilities").array().notNull(),
    consentVersion: text("consent_version").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    expiresAt: timestamp("expires_at", { withTimezone: true }),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow()
  },
  (table) => [
    index("mcp_connection_grants_user_client_idx").on(table.userId, table.oauthClientId),
    index("mcp_connection_grants_user_created_idx").on(table.userId, table.createdAt),
    check(
      "mcp_connection_grants_capabilities_check",
      sql`cardinality(${table.capabilities}) > 0 and ${table.capabilities} <@ array['health_read']::text[]`
    )
  ]
);
