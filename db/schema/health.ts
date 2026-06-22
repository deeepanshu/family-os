import { sql } from "drizzle-orm";
import { boolean, check, date, index, integer, jsonb, numeric, pgSchema, pgTable, text, time, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";

const authSchema = pgSchema("auth");

export const authUsers = authSchema.table("users", {
  id: uuid("id").primaryKey()
});

export const families = pgTable("families", {
  id: uuid("id").primaryKey().defaultRandom(),
  name: text("name").notNull(),
  createdByUserId: uuid("created_by_user_id")
    .notNull()
    .references(() => authUsers.id),
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
    userId: uuid("user_id").notNull().references(() => authUsers.id),
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
    invitedByUserId: uuid("invited_by_user_id")
      .notNull()
      .references(() => authUsers.id),
    email: text("email"),
    tokenHash: text("token_hash").notNull(),
    role: text("role", { enum: ["manager", "member"] }).notNull(),
    status: text("status", { enum: ["pending", "accepted", "revoked", "expired"] }).notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    acceptedByUserId: uuid("accepted_by_user_id").references(() => authUsers.id),
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
    linkedUserId: uuid("linked_user_id").references(() => authUsers.id),
    createdByUserId: uuid("created_by_user_id")
      .notNull()
      .references(() => authUsers.id),
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
    recordedByUserId: uuid("recorded_by_user_id")
      .notNull()
      .references(() => authUsers.id),
    systolic: integer("systolic").notNull(),
    diastolic: integer("diastolic").notNull(),
    pulse: integer("pulse"),
    measuredAt: timestamp("measured_at", { withTimezone: true }).notNull(),
    context: text("context"),
    notes: text("notes"),
    deletedAt: timestamp("deleted_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow()
  },
  (table) => [
    check("bp_systolic_check", sql`${table.systolic} between 50 and 260`),
    check("bp_diastolic_check", sql`${table.diastolic} between 30 and 180`),
    check("bp_pulse_check", sql`${table.pulse} is null or ${table.pulse} between 30 and 220`),
    index("bp_family_person_measured_idx")
      .on(table.familyId, table.personId, table.measuredAt)
      .where(sql`${table.deletedAt} is null`)
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
    recordedByUserId: uuid("recorded_by_user_id")
      .notNull()
      .references(() => authUsers.id),
    value: numeric("value", { precision: 6, scale: 2 }).notNull(),
    unit: text("unit", { enum: ["mg/dL"] }).notNull(),
    context: text("context", { enum: ["fasting", "before_meal", "after_meal", "bedtime", "random"] }).notNull(),
    measuredAt: timestamp("measured_at", { withTimezone: true }).notNull(),
    notes: text("notes"),
    deletedAt: timestamp("deleted_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow()
  },
  (table) => [
    check("glucose_value_check", sql`${table.value} between 20 and 700`),
    check("glucose_unit_check", sql`${table.unit} = 'mg/dL'`),
    check("glucose_context_check", sql`${table.context} in ('fasting', 'before_meal', 'after_meal', 'bedtime', 'random')`),
    index("glucose_family_person_measured_idx")
      .on(table.familyId, table.personId, table.measuredAt)
      .where(sql`${table.deletedAt} is null`)
  ]
);

export const reminders = pgTable("reminders", {
  id: uuid("id").primaryKey().defaultRandom(),
  familyId: uuid("family_id")
    .notNull()
    .references(() => families.id, { onDelete: "cascade" }),
  subjectPersonId: uuid("subject_person_id").references(() => people.id),
  createdByUserId: uuid("created_by_user_id")
    .notNull()
    .references(() => authUsers.id),
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
});

export const reminderRecipients = pgTable(
  "reminder_recipients",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    reminderId: uuid("reminder_id")
      .notNull()
      .references(() => reminders.id, { onDelete: "cascade" }),
    userId: uuid("user_id")
      .notNull()
      .references(() => authUsers.id),
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
    userId: uuid("user_id")
      .notNull()
      .references(() => authUsers.id),
    deviceToken: text("device_token").notNull(),
    platform: text("platform", { enum: ["ios"] }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    lastSeenAt: timestamp("last_seen_at", { withTimezone: true }).notNull().defaultNow()
  },
  (table) => [uniqueIndex("notification_devices_user_token_idx").on(table.userId, table.deviceToken)]
);

export const notificationDeliveries = pgTable("notification_deliveries", {
  id: uuid("id").primaryKey().defaultRandom(),
  reminderId: uuid("reminder_id")
    .notNull()
    .references(() => reminders.id, { onDelete: "cascade" }),
  recipientUserId: uuid("recipient_user_id")
    .notNull()
    .references(() => authUsers.id),
  status: text("status", { enum: ["pending", "sent", "failed", "opened"] }).notNull(),
  scheduledFor: timestamp("scheduled_for", { withTimezone: true }).notNull(),
  sentAt: timestamp("sent_at", { withTimezone: true }),
  openedAt: timestamp("opened_at", { withTimezone: true }),
  error: text("error"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow()
});

export const auditLogs = pgTable(
  "audit_logs",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    familyId: uuid("family_id")
      .notNull()
      .references(() => families.id, { onDelete: "cascade" }),
    actorUserId: uuid("actor_user_id").references(() => authUsers.id),
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
