import postgres from "postgres";
import { SignJWT } from "jose";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { HEALTH_API_PREFIX } from "@family-os/shared";
import { createApp } from "../src/app";

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
        blood_glucose_readings,
        blood_pressure_readings,
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
        blood_glucose_readings,
        blood_pressure_readings,
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

    const profile = await (await api.request(`${HEALTH_API_PREFIX}/people`, {
      method: "POST",
      headers: { authorization: `Bearer ${managerToken}`, "content-type": "application/json" },
      body: JSON.stringify({ displayName: "Mom", relationshipLabel: "Mother" })
    })).json();

    const bp = await api.request(`${HEALTH_API_PREFIX}/readings/blood-pressure`, {
      method: "POST",
      headers: { authorization: `Bearer ${memberToken}`, "content-type": "application/json" },
      body: JSON.stringify({
        personId: profile.data.id,
        systolic: 121,
        diastolic: 79,
        measuredAt: "2026-06-21T10:00:00.000Z"
      })
    });
    expect(bp.status).toBe(201);

    const history = await api.request(`${HEALTH_API_PREFIX}/readings/blood-pressure?personId=${profile.data.id}`, {
      headers: { authorization: `Bearer ${managerToken}` }
    });
    await expect(history.json()).resolves.toMatchObject({
      data: [{ systolic: 121, diastolic: 79, personId: profile.data.id }]
    });
  });

});

