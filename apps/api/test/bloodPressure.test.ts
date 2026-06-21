import { SignJWT } from "jose";
import { describe, expect, it } from "vitest";
import { HEALTH_API_PREFIX } from "@family-os/shared";
import { createApp } from "../src/app";
import { InMemoryFamilyRepository } from "../src/repositories/families";

const jwtSecret = "test-supabase-jwt-secret-with-enough-length";
const supabaseUrl = "https://project.supabase.co";
const managerId = "00000000-0000-4000-8000-000000000401";
const memberId = "00000000-0000-4000-8000-000000000402";
const strangerId = "00000000-0000-4000-8000-000000000403";

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
  const profile = await (
    await api.request(`${HEALTH_API_PREFIX}/people`, {
      method: "POST",
      headers: { authorization: `Bearer ${managerToken}`, "content-type": "application/json" },
      body: JSON.stringify({ displayName: "Mom" })
    })
  ).json();
  return { managerToken, memberToken, profileId: profile.data.id };
}

async function addMember(api: ReturnType<typeof app>, managerToken: string, userId: string, email: string) {
  const token = await jwtFor(userId, email);
  const invite = await (
    await api.request(`${HEALTH_API_PREFIX}/invites`, {
      method: "POST",
      headers: { authorization: `Bearer ${managerToken}`, "content-type": "application/json" },
      body: JSON.stringify({ email, role: "member" })
    })
  ).json();
  await api.request(`${HEALTH_API_PREFIX}/invites/${invite.data.token}/accept`, {
    method: "POST",
    headers: { authorization: `Bearer ${token}` }
  });
  return token;
}

async function createReading(api: ReturnType<typeof app>, token: string, personId: string) {
  return api.request(`${HEALTH_API_PREFIX}/readings/blood-pressure`, {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify({
      personId,
      systolic: 121,
      diastolic: 79,
      pulse: 72,
      measuredAt: "2026-06-21T10:00:00.000Z",
      context: "morning",
      notes: "after walk"
    })
  });
}

describe("blood pressure readings", () => {
  it("lets active members create and list BP readings for a family profile", async () => {
    const api = app();
    const { memberToken, profileId } = await setup(api);

    const created = await createReading(api, memberToken, profileId);

    expect(created.status).toBe(201);
    const body = await created.json();
    expect(body.data).toMatchObject({
      personId: profileId,
      recordedByUserId: memberId,
      systolic: 121,
      diastolic: 79
    });

    const list = await api.request(`${HEALTH_API_PREFIX}/readings/blood-pressure?personId=${profileId}`, {
      headers: { authorization: `Bearer ${memberToken}` }
    });
    await expect(list.json()).resolves.toMatchObject({ data: [{ id: body.data.id }] });
  });

  it("validates BP ranges", async () => {
    const api = app();
    const { memberToken, profileId } = await setup(api);
    const response = await api.request(`${HEALTH_API_PREFIX}/readings/blood-pressure`, {
      method: "POST",
      headers: { authorization: `Bearer ${memberToken}`, "content-type": "application/json" },
      body: JSON.stringify({
        personId: profileId,
        systolic: 20,
        diastolic: 79,
        measuredAt: "2026-06-21T10:00:00.000Z"
      })
    });

    expect(response.status).toBe(400);
  });

  it("allows recorders and managers, but not other members, to update/delete readings", async () => {
    const api = app();
    const { managerToken, memberToken, profileId } = await setup(api);
    const created = await (await createReading(api, memberToken, profileId)).json();

    const managerPatch = await api.request(`${HEALTH_API_PREFIX}/readings/blood-pressure/${created.data.id}`, {
      method: "PATCH",
      headers: { authorization: `Bearer ${managerToken}`, "content-type": "application/json" },
      body: JSON.stringify({ systolic: 122 })
    });
    expect(managerPatch.status).toBe(200);

    const sameFamilyOtherToken = await addMember(api, managerToken, strangerId, "other@example.com");
    const forbidden = await api.request(`${HEALTH_API_PREFIX}/readings/blood-pressure/${created.data.id}`, {
      method: "PATCH",
      headers: { authorization: `Bearer ${sameFamilyOtherToken}`, "content-type": "application/json" },
      body: JSON.stringify({ systolic: 130 })
    });
    expect(forbidden.status).toBe(403);

    const deleted = await api.request(`${HEALTH_API_PREFIX}/readings/blood-pressure/${created.data.id}`, {
      method: "DELETE",
      headers: { authorization: `Bearer ${memberToken}` }
    });
    expect(deleted.status).toBe(204);

    const detail = await api.request(`${HEALTH_API_PREFIX}/readings/blood-pressure/${created.data.id}`, {
      headers: { authorization: `Bearer ${memberToken}` }
    });
    expect(detail.status).toBe(404);

    const list = await api.request(`${HEALTH_API_PREFIX}/readings/blood-pressure?personId=${profileId}`, {
      headers: { authorization: `Bearer ${memberToken}` }
    });
    await expect(list.json()).resolves.toEqual({ data: [] });
  });

  it("does not allow creating BP readings for another family's profile", async () => {
    const api = app();
    const { memberToken } = await setup(api);
    const otherToken = await jwtFor(strangerId);
    await api.request(`${HEALTH_API_PREFIX}/families`, {
      method: "POST",
      headers: { authorization: `Bearer ${otherToken}`, "content-type": "application/json" },
      body: JSON.stringify({ name: "Other Family" })
    });
    const otherProfile = await (
      await api.request(`${HEALTH_API_PREFIX}/people`, {
        method: "POST",
        headers: { authorization: `Bearer ${otherToken}`, "content-type": "application/json" },
        body: JSON.stringify({ displayName: "Other" })
      })
    ).json();

    const response = await createReading(api, memberToken, otherProfile.data.id);

    expect(response.status).toBe(404);
  });
});
