import { SignJWT } from "jose";
import { describe, expect, it } from "vitest";
import { HEALTH_API_PREFIX } from "@family-os/shared";
import { createApp } from "../src/app";
import { InMemoryFamilyRepository } from "../src/repositories/families";

const jwtSecret = "test-supabase-jwt-secret-with-enough-length";
const supabaseUrl = "https://project.supabase.co";
const managerId = "00000000-0000-4000-8000-000000000801";
const memberId = "00000000-0000-4000-8000-000000000802";
const strangerId = "00000000-0000-4000-8000-000000000803";

function app() {
  return createApp({
    config: {
      NODE_ENV: "test",
      PORT: 3001,
      HEALTH_API_ENABLE_DEV_AUTH: false,
      SUPABASE_JWT_SECRET: jwtSecret,
      SUPABASE_URL: supabaseUrl
    },
    familyRepository: new InMemoryFamilyRepository()
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

async function setup(api: ReturnType<typeof app>) {
  const managerToken = await jwtFor(managerId);
  const memberToken = await jwtFor(memberId, "member@example.com");
  await api.request(`${HEALTH_API_PREFIX}/families`, {
    method: "POST",
    headers: { authorization: `Bearer ${managerToken}`, "content-type": "application/json" },
    body: JSON.stringify({ name: "Jain Family" })
  });
  const invite = await (
    await api.request(`${HEALTH_API_PREFIX}/invites`, {
      method: "POST",
      headers: { authorization: `Bearer ${managerToken}`, "content-type": "application/json" },
      body: JSON.stringify({ email: "member@example.com", role: "member" })
    })
  ).json();
  await api.request(`${HEALTH_API_PREFIX}/invites/${invite.data.token}/accept`, {
    method: "POST",
    headers: { authorization: `Bearer ${memberToken}` }
  });
  return { managerToken, memberToken };
}

describe("audit logs", () => {
  it("lets managers list family audit logs for health operations", async () => {
    const api = app();
    const { managerToken, memberToken } = await setup(api);
    const profile = await (
      await api.request(`${HEALTH_API_PREFIX}/people`, {
        method: "POST",
        headers: { authorization: `Bearer ${managerToken}`, "content-type": "application/json" },
        body: JSON.stringify({ displayName: "Mom" })
      })
    ).json();
    await api.request(`${HEALTH_API_PREFIX}/readings/blood-pressure`, {
      method: "POST",
      headers: { authorization: `Bearer ${memberToken}`, "content-type": "application/json" },
      body: JSON.stringify({
        personId: profile.data.id,
        systolic: 121,
        diastolic: 79,
        measuredAt: "2026-06-21T10:00:00.000Z"
      })
    });
    await api.request(`${HEALTH_API_PREFIX}/reminders`, {
      method: "POST",
      headers: { authorization: `Bearer ${memberToken}`, "content-type": "application/json" },
      body: JSON.stringify({
        subjectPersonId: profile.data.id,
        type: "blood_pressure",
        title: "BP check",
        message: "Check BP",
        scheduleKind: "daily",
        timeOfDay: "08:00",
        timezone: "UTC",
        recipientUserIds: [memberId]
      })
    });
    await api.request(`${HEALTH_API_PREFIX}/devices`, {
      method: "POST",
      headers: { authorization: `Bearer ${memberToken}`, "content-type": "application/json" },
      body: JSON.stringify({ platform: "ios", deviceToken: "c".repeat(64) })
    });

    const response = await api.request(`${HEALTH_API_PREFIX}/audit-logs?limit=20`, {
      headers: { authorization: `Bearer ${managerToken}` }
    });

    expect(response.status).toBe(200);
    const body = await response.json();
    const actions = body.data.map((entry: { action: string }) => entry.action);
    expect(actions).toEqual(
      expect.arrayContaining([
        "family.created",
        "invite.created",
        "invite.accepted",
        "profile.created",
        "blood_pressure.created",
        "reminder.created",
        "device.registered"
      ])
    );
  });

  it("blocks members and non-members from listing audit logs", async () => {
    const api = app();
    const { memberToken } = await setup(api);

    const memberResponse = await api.request(`${HEALTH_API_PREFIX}/audit-logs`, {
      headers: { authorization: `Bearer ${memberToken}` }
    });
    expect(memberResponse.status).toBe(403);

    const strangerResponse = await api.request(`${HEALTH_API_PREFIX}/audit-logs`, {
      headers: { authorization: `Bearer ${await jwtFor(strangerId)}` }
    });
    expect(strangerResponse.status).toBe(403);
  });
});
