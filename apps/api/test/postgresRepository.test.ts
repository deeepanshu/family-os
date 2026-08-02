import postgres from "postgres";
import { SignJWT } from "jose";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { HEALTH_API_PREFIX } from "@family-os/shared";
import { createApp } from "../src/app";
import { PostgresFamilyRepository } from "../src/repositories/postgres";
import { seedHealthKitReadyGroup } from "./healthKitTestHelpers";

const databaseUrl = process.env.DATABASE_URL ?? "postgres://family_os:family_os@localhost:5432/family_os";
const jwtSecret = "test-supabase-jwt-secret-with-enough-length";
const supabaseUrl = "https://project.supabase.co";
const managerId = "00000000-0000-4000-8000-000000009001";
const memberId = "00000000-0000-4000-8000-000000009002";

const sql = postgres(databaseUrl, { prepare: false, max: 1 });

function app() {
  return createApp({
    config: {
      NODE_ENV: "test",
      PORT: 3001,
      DATABASE_URL: databaseUrl,
      HEALTH_API_REPOSITORY: "postgres",
      HEALTH_API_SYNC_LOCAL_AUTH_USERS: true,
      SUPABASE_JWT_SECRET: jwtSecret,
      SUPABASE_URL: supabaseUrl
    }
  });
}

async function jwtFor(subject: string, email = `${subject}@example.com`) {
  return new SignJWT({ role: "authenticated", email })
    .setProtectedHeader({ alg: "HS256" })
    .setSubject(subject)
    .setIssuer(`${supabaseUrl}/auth/v1`)
    .setAudience("authenticated")
    .setIssuedAt()
    .setExpirationTime("1h")
    .sign(new TextEncoder().encode(jwtSecret));
}

describe("Postgres RLS policies", () => {
  beforeAll(async () => {
    await sql`
      do $$
      begin
        if not exists (select from pg_roles where rolname = 'authenticated') then
          create role authenticated;
        end if;
      end
      $$
    `;
    await sql`grant usage on schema public to authenticated`;
    await sql`grant usage on schema auth to authenticated`;
    await sql`grant select, insert, update, delete on all tables in schema public to authenticated`;
    await sql`grant select, insert, update, delete on all tables in schema auth to authenticated`;
    await sql`grant execute on function auth.uid() to authenticated`;
  });

  beforeEach(async () => {
    await sql`
      truncate
        audit_logs,
        notification_deliveries,
        notification_devices,
        reminder_recipients,
        reminders,
        healthkit_backfill_scope_manifests,
        healthkit_backfill_sessions,
        healthkit_sync_events,
        healthkit_sync_entities,
        healthkit_sync_state,
        healthkit_sync_groups,
        healthkit_sync_installations,
        healthkit_sync_profile_settings,
        health_step_hours,
        health_sleep_days,
        health_daily_metrics,
        health_blood_glucose_readings,
        health_blood_pressure_readings,
        health_workouts,
        people,
        family_invites,
        family_memberships,
        families,
        auth.users
      restart identity cascade
    `;
  });

  it("allows self-profile insert and blocks arbitrary member profile insert", async () => {
    const userId = "00000000-0000-4000-8000-000000009001";
    const otherUserId = "00000000-0000-4000-8000-000000009002";
    const familyId = "00000000-0000-4000-8000-000000000001";

    await sql`insert into auth.users (id) values (${userId})`;
    await sql`insert into families (id, name, kind, created_by_user_id) values (${familyId}, 'My Health', 'personal', ${userId})`;
    await sql`insert into family_memberships (id, family_id, user_id, role, status) values (gen_random_uuid(), ${familyId}, ${userId}, 'member', 'active')`;

    const selfInsert = await sql.begin(async (tx) => {
      await tx`set local role authenticated`;
      await tx`select set_config('request.jwt.claim.sub', ${userId}, true)`;
      return await tx`
        insert into people (family_id, linked_user_id, created_by_user_id, display_name, relationship_label, status)
        values (${familyId}, ${userId}, ${userId}, 'Me', 'Self', 'active')
        returning id
      `;
    });
    expect(selfInsert.length).toBe(1);

    await expect(
      sql.begin(async (tx) => {
        await tx`set local role authenticated`;
        await tx`select set_config('request.jwt.claim.sub', ${userId}, true)`;
        await tx`
          insert into people (family_id, linked_user_id, created_by_user_id, display_name, relationship_label, status)
          values (${familyId}, ${otherUserId}, ${userId}, 'Other', 'Friend', 'active')
        `;
      })
    ).rejects.toThrow();
  });

  it("blocks self-profile insert without active membership", async () => {
    const userId = "00000000-0000-4000-8000-000000009003";
    const familyId = "00000000-0000-4000-8000-000000000002";

    await sql`insert into auth.users (id) values (${userId})`;
    await sql`insert into families (id, name, kind, created_by_user_id) values (${familyId}, 'Orphan', 'personal', ${userId})`;

    await expect(
      sql.begin(async (tx) => {
        await tx`set local role authenticated`;
        await tx`select set_config('request.jwt.claim.sub', ${userId}, true)`;
        await tx`
          insert into people (family_id, linked_user_id, created_by_user_id, display_name, relationship_label, status)
          values (${familyId}, ${userId}, ${userId}, 'Me', 'Self', 'active')
        `;
      })
    ).rejects.toThrow();
  });
});

describe("Postgres repository wiring", () => {
  beforeEach(async () => {
    await sql`
      truncate
        audit_logs,
        notification_deliveries,
        notification_devices,
        reminder_recipients,
        reminders,
        healthkit_backfill_scope_manifests,
        healthkit_backfill_sessions,
        healthkit_sync_events,
        healthkit_sync_entities,
        healthkit_sync_state,
        healthkit_sync_groups,
        healthkit_sync_installations,
        healthkit_sync_profile_settings,
        health_step_hours,
        health_sleep_days,
        health_daily_metrics,
        health_blood_glucose_readings,
        health_blood_pressure_readings,
        health_workouts,
        people,
        family_invites,
        family_memberships,
        families,
        auth.users
      restart identity cascade
    `;
  });

  it("persists the core family health flow through the API DI path", async () => {
    const api = app();
    const managerToken = await jwtFor(managerId, "manager@example.com");
    const memberToken = await jwtFor(memberId, "member@example.com");

    const family = await api.request(`${HEALTH_API_PREFIX}/families`, {
      method: "POST",
      headers: { authorization: `Bearer ${managerToken}`, "content-type": "application/json" },
      body: JSON.stringify({ name: "Jain Family" })
    });
    expect(family.status).toBe(201);

    const invite = await (await api.request(`${HEALTH_API_PREFIX}/invites`, {
      method: "POST",
      headers: { authorization: `Bearer ${managerToken}`, "content-type": "application/json" },
      body: JSON.stringify({ email: "member@example.com", role: "member" })
    })).json();

    const accept = await api.request(`${HEALTH_API_PREFIX}/invites/${invite.data.token}/accept`, {
      method: "POST",
      headers: { authorization: `Bearer ${memberToken}` }
    });
    expect(accept.status).toBe(200);

    const profile = await (await api.request(`${HEALTH_API_PREFIX}/me/profile`, {
      method: "POST",
      headers: { authorization: `Bearer ${managerToken}`, "content-type": "application/json" },
      body: JSON.stringify({ displayName: "Manager" })
    })).json();

    const settings = await api.request(`${HEALTH_API_PREFIX}/healthkit/settings`, {
      method: "PUT",
      headers: { authorization: `Bearer ${managerToken}`, "content-type": "application/json" },
      body: JSON.stringify({
        personId: profile.data.id,
        enabledGroups: ["vitals"],
        healthTimezone: "UTC",
        installationId: "00000000-0000-4000-8000-000000009010",
        consentVersion: "healthkit-v1"
      })
    });
    expect(settings.status).toBe(200);

    const installationId = "00000000-0000-4000-8000-000000009010";
    await seedHealthKitReadyGroup(api, managerToken, profile.data.id, installationId, "vitals", [
      {
        opId: "00000000-0000-4000-8000-000000009011",
        naturalKey: "blood_glucose:00000000-0000-4000-8000-000000009012",
        group: "vitals",
        scopeKey: "blood_glucose",
        op: "upsert",
        payload: {
          kind: "blood_glucose",
          sourceSampleKey: "00000000-0000-4000-8000-000000009012",
          measuredAtUtc: "2026-06-21T10:00:00.000Z",
          valueMgDl: 104
        }
      }
    ]);

    const repository = PostgresFamilyRepository.fromDatabaseUrl(databaseUrl, { syncLocalAuthUsers: true });
    const readings = await repository.listHealthKitBloodGlucose(
      managerId,
      profile.data.id,
      "2026-06-21T00:00:00.000Z",
      "2026-06-22T00:00:00.000Z",
      10
    );
    expect(readings).toMatchObject([{ value: 104, personId: profile.data.id, source: "healthkit" }]);
  });

  it("treats concurrent retries of the same event as a duplicate", async () => {
    const api = app();
    const token = await jwtFor(managerId, "manager@example.com");
    await api.request(`${HEALTH_API_PREFIX}/bootstrap`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}` }
    });
    const profile = await (
      await api.request(`${HEALTH_API_PREFIX}/me/profile`, {
        method: "POST",
        headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
        body: JSON.stringify({ displayName: "Manager" })
      })
    ).json();
    const profileId = profile.data.id as string;
    const installationId = "00000000-0000-4000-8000-000000009010";
    const settings = await api.request(`${HEALTH_API_PREFIX}/healthkit/settings`, {
      method: "PUT",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({
        personId: profileId,
        enabledGroups: ["activity"],
        healthTimezone: "UTC",
        installationId,
        consentVersion: "healthkit-v1"
      })
    });
    expect(settings.status).toBe(200);

    const event = {
      opId: "00000000-0000-4000-8000-000000009020",
      naturalKey: "steps_hour:2026-07-25T14:00:00.000Z",
      group: "activity",
      scopeKey: "steps",
      op: "upsert",
      payload: {
        kind: "steps_hour",
        hourStartUtc: "2026-07-25T14:00:00.000Z",
        count: 1200
      }
    };
    const request = () =>
      api.request(`${HEALTH_API_PREFIX}/healthkit/ops:batch`, {
        method: "POST",
        headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
        body: JSON.stringify({
          installationId,
          personId: profileId,
          timezoneVersion: 1,
          ops: [event]
        })
      });

    const responses = await Promise.all([request(), request()]);
    expect(responses.map((response) => response.status)).toEqual([200, 200]);
    const results = await Promise.all(responses.map(async (response) => (await response.json()).data.results[0].result));
    expect(results.sort()).toEqual(["applied", "duplicate"]);

    const receipts = await sql`
      select op_id from healthkit_op_receipts where op_id = ${event.opId}
    `;
    expect(receipts).toHaveLength(1);
    const steps = await sql`
      select count from health_step_hours
      where person_id = ${profileId} and hour_start_utc = ${event.payload.hourStartUtc}
    `;
    expect(steps).toEqual([{ count: 1200 }]);
  });

  it("returns canonical ISO sleep days from Postgres", async () => {
    const familyId = "00000000-0000-4000-8000-000000000003";
    const profileId = "00000000-0000-4000-8000-000000000004";
    await sql`insert into auth.users (id) values (${managerId})`;
    await sql`
      insert into families (id, name, kind, created_by_user_id)
      values (${familyId}, 'My Health', 'personal', ${managerId})
    `;
    await sql`
      insert into family_memberships (id, family_id, user_id, role, status)
      values (gen_random_uuid(), ${familyId}, ${managerId}, 'manager', 'active')
    `;
    await sql`
      insert into people (id, family_id, linked_user_id, created_by_user_id, display_name, relationship_label, status)
      values (${profileId}, ${familyId}, ${managerId}, ${managerId}, 'Me', 'Self', 'active')
    `;
    await sql`
      insert into health_sleep_days (
        family_id, person_id, sleep_day, timezone_version, total_minutes,
        core_minutes, deep_minutes, rem_minutes, unspecified_asleep_minutes, awake_minutes, in_bed_minutes
      ) values (${familyId}, ${profileId}, '2026-07-25'::date, 1, 480, 200, 100, 100, 80, 0, 480)
    `;

    const repository = PostgresFamilyRepository.fromDatabaseUrl(databaseUrl, { syncLocalAuthUsers: true });
    const rows = await repository.listSleepDays(managerId, profileId, "2026-07-19", "2026-07-25");
    expect(rows).toEqual([
      expect.objectContaining({ sleepDay: "2026-07-25", totalMinutes: 480, timezoneVersion: 1 })
    ]);
  });

});
