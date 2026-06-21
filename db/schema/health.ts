import { sql } from "drizzle-orm";
import { check, pgSchema, pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";

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
