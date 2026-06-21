import { SignJWT } from "jose";
import { describe, expect, it } from "vitest";
import { HEALTH_API_PREFIX } from "@family-os/shared";
import { createApp } from "../src/app";
import { InMemoryFamilyRepository } from "../src/repositories/families";

const jwtSecret = "test-supabase-jwt-secret-with-enough-length";
const supabaseUrl = "https://project.supabase.co";
const managerId = "00000000-0000-4000-8000-000000000501";
const memberId = "00000000-0000-4000-8000-000000000502";
const otherId = "00000000-0000-4000-8000-000000000503";

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

async function createReading(api: ReturnType<typeof app>, token: string, personId: string) {
  return api.request(`${HEALTH_API_PREFIX}/readings/blood-glucose`, {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify({
      personId,
      value: 105,
      unit: "mg/dL",
      context: "fasting",
      measuredAt: "2026-06-21T10:00:00.000Z",
      notes: "before breakfast"
    })
  });
}

describe("blood sugar readings", () => {
  it("lets active members create and list glucose readings", async () => {
    const api = app();
    const { memberToken, profileId } = await setup(api);
    const created = await createReading(api, memberToken, profileId);

    expect(created.status).toBe(201);
    const body = await created.json();
    expect(body.data).toMatchObject({
      personId: profileId,
      recordedByUserId: memberId,
      value: 105,
      unit: "mg/dL",
      context: "fasting"
    });

    const list = await api.request(`${HEALTH_API_PREFIX}/readings/blood-glucose?personId=${profileId}`, {
      headers: { authorization: `Bearer ${memberToken}` }
    });
    await expect(list.json()).resolves.toMatchObject({ data: [{ id: body.data.id }] });
  });

  it("validates glucose value, unit, context, and timestamp", async () => {
    const api = app();
    const { memberToken, profileId } = await setup(api);
    const response = await api.request(`${HEALTH_API_PREFIX}/readings/blood-glucose`, {
      method: "POST",
      headers: { authorization: `Bearer ${memberToken}`, "content-type": "application/json" },
      body: JSON.stringify({
        personId: profileId,
        value: 800,
        unit: "mmol/L",
        context: "bad",
        measuredAt: "nope"
      })
    });

    expect(response.status).toBe(400);
  });

  it("enforces owner-or-manager update/delete permissions and hides deleted readings", async () => {
    const api = app();
    const { managerToken, memberToken, profileId } = await setup(api);
    const created = await (await createReading(api, memberToken, profileId)).json();

    const managerPatch = await api.request(`${HEALTH_API_PREFIX}/readings/blood-glucose/${created.data.id}`, {
      method: "PATCH",
      headers: { authorization: `Bearer ${managerToken}`, "content-type": "application/json" },
      body: JSON.stringify({ value: 110 })
    });
    expect(managerPatch.status).toBe(200);

    const otherToken = await jwtFor(otherId);
    await api.request(`${HEALTH_API_PREFIX}/families`, {
      method: "POST",
      headers: { authorization: `Bearer ${otherToken}`, "content-type": "application/json" },
      body: JSON.stringify({ name: "Other Family" })
    });
    const forbidden = await api.request(`${HEALTH_API_PREFIX}/readings/blood-glucose/${created.data.id}`, {
      method: "PATCH",
      headers: { authorization: `Bearer ${otherToken}`, "content-type": "application/json" },
      body: JSON.stringify({ value: 130 })
    });
    expect(forbidden.status).toBe(404);

    const deleted = await api.request(`${HEALTH_API_PREFIX}/readings/blood-glucose/${created.data.id}`, {
      method: "DELETE",
      headers: { authorization: `Bearer ${memberToken}` }
    });
    expect(deleted.status).toBe(204);
    const list = await api.request(`${HEALTH_API_PREFIX}/readings/blood-glucose?personId=${profileId}`, {
      headers: { authorization: `Bearer ${memberToken}` }
    });
    await expect(list.json()).resolves.toEqual({ data: [] });
  });
});
