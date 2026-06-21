import { sql } from "drizzle-orm";
import { check, date, index, integer, pgSchema, pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";

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
