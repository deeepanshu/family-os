import postgres from "postgres";
import { SignJWT } from "jose";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { HEALTH_API_PREFIX } from "@family-os/shared";
import { createApp } from "../src/app";
import { PostgresFamilyRepository } from "../src/repositories/postgres";
import { beginRun, completeRun, seedHealthKitReadyGroup } from "./healthKitTestHelpers";
import { setupHousehold, setupSoloUser } from "./soloSetup";

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
        healthkit_op_receipts,
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
        health_workout_sets,
        health_workout_exercises,


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
        healthkit_op_receipts,
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
        health_workout_sets,
        health_workout_exercises,

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
      body: JSON.stringify({})
    })).json();

    const accept = await api.request(`${HEALTH_API_PREFIX}/invites/${invite.data.token}/accept`, {
      method: "POST",
      headers: { authorization: `Bearer ${memberToken}`, "content-type": "application/json" },
      body: JSON.stringify({ relationshipLabel: "Father" })
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

  it("enforces one pending invite and unique active membership", async () => {
    const api = app();
    const creatorToken = await jwtFor(managerId, "manager@example.com");
    const joinerToken = await jwtFor(memberId, "member@example.com");
    await setupSoloUser(api, creatorToken, "Deepanshu");
    await setupHousehold(api, creatorToken, "Jain Family");

    const first = await (
      await api.request(`${HEALTH_API_PREFIX}/invites`, {
        method: "POST",
        headers: { authorization: `Bearer ${creatorToken}`, "content-type": "application/json" },
        body: JSON.stringify({})
      })
    ).json();
    const second = await (
      await api.request(`${HEALTH_API_PREFIX}/invites`, {
        method: "POST",
        headers: { authorization: `Bearer ${creatorToken}`, "content-type": "application/json" },
        body: JSON.stringify({})
      })
    ).json();
    const firstPreview = await (
      await api.request(`${HEALTH_API_PREFIX}/invites/${first.data.token}`)
    ).json();
    expect(firstPreview.data.status).toBe("revoked");

    await setupSoloUser(api, joinerToken, "Riya");
    const accept = await api.request(`${HEALTH_API_PREFIX}/invites/${second.data.token}/accept`, {
      method: "POST",
      headers: { authorization: `Bearer ${joinerToken}`, "content-type": "application/json" },
      body: JSON.stringify({ relationshipLabel: "Father" })
    });
    expect(accept.status).toBe(200);

    const secondFamily = await api.request(`${HEALTH_API_PREFIX}/families`, {
      method: "POST",
      headers: { authorization: `Bearer ${joinerToken}`, "content-type": "application/json" },
      body: JSON.stringify({ name: "Second" })
    });
    expect(secondFamily.status).toBe(409);

    const live = await (
      await api.request(`${HEALTH_API_PREFIX}/invites`, {
        method: "POST",
        headers: { authorization: `Bearer ${creatorToken}`, "content-type": "application/json" },
        body: JSON.stringify({})
      })
    ).json();
    const removed = await api.request(`${HEALTH_API_PREFIX}/families/members/${memberId}`, {
      method: "DELETE",
      headers: { authorization: `Bearer ${creatorToken}` }
    });
    expect(removed.status).toBe(204);
    const afterKick = await (await api.request(`${HEALTH_API_PREFIX}/invites/${live.data.token}`)).json();
    expect(afterKick.data.status).toBe("revoked");
  });

  it("deletes the household row without deleting the creator's health", async () => {
    const api = app();
    const creatorToken = await jwtFor(managerId, "manager@example.com");
    const creator = await setupSoloUser(api, creatorToken, "Deepanshu");
    const created = await (
      await api.request(`${HEALTH_API_PREFIX}/families`, {
        method: "POST",
        headers: { authorization: `Bearer ${creatorToken}`, "content-type": "application/json" },
        body: JSON.stringify({ name: "Jain Family" })
      })
    ).json();
    const familyId = created.data.family.id as string;
    const installationId = "00000000-0000-4000-8000-000000009020";
    await api.request(`${HEALTH_API_PREFIX}/healthkit/settings`, {
      method: "PUT",
      headers: { authorization: `Bearer ${creatorToken}`, "content-type": "application/json" },
      body: JSON.stringify({
        personId: creator.profileId,
        consentVersion: "1",
        enabledGroups: ["vitals"],
        healthTimezone: "UTC",
        installationId
      })
    });
    await seedHealthKitReadyGroup(api, creatorToken, creator.profileId, installationId, "vitals", [
      {
        opId: crypto.randomUUID(),
        naturalKey: "blood_pressure:00000000-0000-4000-8000-000000009021",
        group: "vitals",
        scopeKey: "blood_pressure",
        op: "upsert",
        payload: {
          kind: "blood_pressure",
          sourceObjectKey: "00000000-0000-4000-8000-000000009021",
          measuredAtUtc: "2026-06-21T10:00:00.000Z",
          systolic: 118,
          diastolic: 76
        }
      }
    ]);

    const deleted = await api.request(`${HEALTH_API_PREFIX}/families/current`, {
      method: "DELETE",
      headers: { authorization: `Bearer ${creatorToken}` }
    });
    expect(deleted.status).toBe(204);

    const leftover = await sql`select id from families where id = ${familyId}`;
    expect(leftover).toHaveLength(0);
    const samples = await sql`
      select systolic from health_blood_pressure_readings
      where person_id = ${creator.profileId}
    `;
    expect(samples).toHaveLength(1);
    expect(Number(samples[0]?.systolic)).toBe(118);

    const current = await api.request(`${HEALTH_API_PREFIX}/families/current`, {
      headers: { authorization: `Bearer ${creatorToken}` }
    });
    await expect(current.json()).resolves.toEqual({ data: null });
  });

  it("treats leftover personal workspaces as solo so a real family can be created", async () => {
    const userId = "00000000-0000-4000-8000-000000009030";
    const familyId = "00000000-0000-4000-8000-000000009031";
    await sql`insert into auth.users (id) values (${userId})`;
    await sql`insert into families (id, name, kind, created_by_user_id) values (${familyId}, 'My Health', 'personal', ${userId})`;
    await sql`insert into family_memberships (family_id, user_id, role, status) values (${familyId}, ${userId}, 'manager', 'active')`;

    const api = app();
    const token = await jwtFor(userId, "solo@example.com");
    const current = await api.request(`${HEALTH_API_PREFIX}/families/current`, {
      headers: { authorization: `Bearer ${token}` }
    });
    await expect(current.json()).resolves.toEqual({ data: null });

    const created = await api.request(`${HEALTH_API_PREFIX}/families`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({ name: "Jain Family" })
    });
    expect(created.status).toBe(201);
    const body = await created.json();
    expect(body.data.family.kind).toBe("family");
    expect(body.data.family.name).toBe("Jain Family");
  });

  it("preserves completed coverage when a routine sync completes", async () => {
    const api = app();
    const token = await jwtFor(managerId, "manager@example.com");
    const { profileId } = await setupSoloUser(api, token);
    const installationId = "00000000-0000-4000-8000-000000009010";

    const settings = await api.request(`${HEALTH_API_PREFIX}/healthkit/settings`, {
      method: "PUT",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({
        personId: profileId,
        enabledGroups: ["vitals"],
        healthTimezone: "UTC",
        installationId,
        consentVersion: "healthkit-v1"
      })
    });
    expect(settings.status).toBe(200);
    await seedHealthKitReadyGroup(api, token, profileId, installationId, "vitals", []);

    const beforeSettings = await api.request(`${HEALTH_API_PREFIX}/healthkit/settings`, {
      headers: { authorization: `Bearer ${token}` }
    });
    const before = (await beforeSettings.json()).data.groups.find((group: { group: string }) => group.group === "vitals");

    const begin = await beginRun(api, token, profileId, installationId, "vitals", "sync");
    expect(begin.status).toBe(200);
    const descriptor = (await begin.json()).data;
    const complete = await completeRun(api, token, profileId, installationId, "vitals", {
      kind: "sync",
      rangeStartAt: descriptor.rangeStartAt,
      rangeEndAt: descriptor.rangeEndAt
    });
    expect(complete.status).toBe(200);
    const done = (await complete.json()).data;

    expect(done.coverageStartAt).toBe(before.coverageStartAt);
    expect(Date.parse(done.coverageEndAt)).toBeGreaterThanOrEqual(Date.parse(before.coverageEndAt));
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

  it("repair reconciliation deletes only absent keys inside the exact window (postgres)", async () => {
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
        enabledGroups: ["vitals", "sleep"],
        healthTimezone: "UTC",
        installationId,
        consentVersion: "healthkit-v1"
      })
    });
    expect(settings.status).toBe(200);

    const dayMs = 24 * 60 * 60 * 1000;
    const isoDaysAgo = (days: number) => new Date(Date.now() - days * dayMs).toISOString();
    const bp = (key: string, daysAgo: number) => ({
      opId: crypto.randomUUID(),
      naturalKey: `blood_pressure:${key}`,
      group: "vitals" as const,
      scopeKey: "blood_pressure",
      op: "upsert" as const,
      payload: {
        kind: "blood_pressure" as const,
        sourceObjectKey: key,
        measuredAtUtc: isoDaysAgo(daysAgo),
        systolic: 120,
        diastolic: 80
      }
    });
    const keepIn = "00000000-0000-4000-8000-000000009030";
    const dropIn = "00000000-0000-4000-8000-000000009031";
    const keepOut = "00000000-0000-4000-8000-000000009032";
    await seedHealthKitReadyGroup(api, token, profileId, installationId, "vitals", [
      bp(keepIn, 5),
      bp(dropIn, 20),
      bp(keepOut, 100)
    ]);

    const begin = await api.request(`${HEALTH_API_PREFIX}/healthkit/groups/vitals/runs/begin`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({ installationId, personId: profileId, timezoneVersion: 1, kind: "repair_import" })
    });
    expect(begin.status).toBe(200);
    const descriptor = (await begin.json()).data;
    expect(descriptor.allowDeletes).toBe(true);

    const complete = await api.request(`${HEALTH_API_PREFIX}/healthkit/groups/vitals/runs/complete`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({
        installationId,
        personId: profileId,
        timezoneVersion: 1,
        kind: "repair_import",
        rangeStartAt: descriptor.rangeStartAt,
        rangeEndAt: descriptor.rangeEndAt,
        completeSnapshot: true,
        presentNaturalKeys: [`blood_pressure:${keepIn}`]
      })
    });
    expect(complete.status).toBe(200);
    expect((await complete.json()).data.deletedCount).toBe(1);

    const remaining = await sql`
      select source_sample_key from health_blood_pressure_readings where person_id = ${profileId} order by 1
    `;
    expect(remaining.map((row) => row.source_sample_key).sort()).toEqual([keepIn, keepOut].sort());

    // Sleep: absent in-window day is removed; out-of-window day survives.
    const sleepDay = (day: string) => ({
      opId: crypto.randomUUID(),
      naturalKey: `sleep_day:${day}`,
      group: "sleep" as const,
      scopeKey: "sleep",
      op: "upsert" as const,
      payload: {
        kind: "sleep_day" as const,
        sleepDay: day,
        totalMinutes: 480,
        coreMinutes: 240,
        deepMinutes: 90,
        remMinutes: 90,
        unspecifiedAsleepMinutes: 60,
        awakeMinutes: 0,
        inBedMinutes: 480
      }
    });
    const keepDay = isoDaysAgo(3).slice(0, 10);
    const dropDay = isoDaysAgo(30).slice(0, 10);
    const outsideDay = isoDaysAgo(100).slice(0, 10);
    await seedHealthKitReadyGroup(api, token, profileId, installationId, "sleep", [
      sleepDay(keepDay),
      sleepDay(dropDay),
      sleepDay(outsideDay)
    ]);

    const beginSleep = await api.request(`${HEALTH_API_PREFIX}/healthkit/groups/sleep/runs/begin`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({ installationId, personId: profileId, timezoneVersion: 1, kind: "repair_import" })
    });
    const sleepDescriptor = (await beginSleep.json()).data;
    const completeSleep = await api.request(`${HEALTH_API_PREFIX}/healthkit/groups/sleep/runs/complete`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({
        installationId,
        personId: profileId,
        timezoneVersion: 1,
        kind: "repair_import",
        rangeStartAt: sleepDescriptor.rangeStartAt,
        rangeEndAt: sleepDescriptor.rangeEndAt,
        completeSnapshot: true,
        presentNaturalKeys: [`sleep_day:${keepDay}`]
      })
    });
    expect(completeSleep.status).toBe(200);
    expect((await completeSleep.json()).data.deletedCount).toBe(1);

    const sleepRows = await sql`
      select sleep_day from health_sleep_days where person_id = ${profileId} order by 1
    `;
    expect(sleepRows.map((row) => row.sleep_day.toISOString().slice(0, 10))).toEqual([outsideDay, keepDay].sort());
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
