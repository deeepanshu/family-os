import { SignJWT } from "jose";
import { describe, expect, it } from "vitest";
import { HEALTH_API_PREFIX } from "@family-os/shared";
import { createApp } from "../src/app";
import { InMemoryFamilyRepository } from "../src/repositories/families";

const jwtSecret = "test-supabase-jwt-secret-with-enough-length";
const supabaseUrl = "https://project.supabase.co";
const userId = "00000000-0000-4000-8000-000000000401";
const installationId = "53064303-35cf-4db0-a5d3-8af7d8f747e1";

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

async function setupHealthKitBp(api: ReturnType<typeof app>) {
  const token = await jwtFor(userId);
  await api.request(`${HEALTH_API_PREFIX}/bootstrap`, {
    method: "POST",
    headers: { authorization: `Bearer ${token}` }
  });
  const profile = await (
    await api.request(`${HEALTH_API_PREFIX}/me/profile`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({ displayName: "Deepanshu" })
    })
  ).json();
  const profileId = profile.data.id as string;
  await api.request(`${HEALTH_API_PREFIX}/healthkit/settings`, {
    method: "PUT",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify({
      personId: profileId,
      consentVersion: "1",
      enabledMetrics: ["blood_pressure"],
      healthTimezone: "UTC",
      installationId
    })
  });
  await api.request(`${HEALTH_API_PREFIX}/healthkit/sync`, {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify({
      syncId: "7afbe594-7e1d-4b31-a9a1-420b7fba42c1",
      installationId,
      personId: profileId,
      timezoneVersion: 1,
      operations: [
        {
          kind: "blood_pressure_upsert",
          sourceSampleKey: "5e1ed621-4a6c-4e09-969e-31c6f0872c24",
          measuredAtUtc: "2026-07-25T01:10:00.000Z",
          systolic: 118,
          diastolic: 76
        }
      ]
    })
  });
  return { token, profileId };
}

describe("blood pressure readings", () => {
  it("is read-only over HealthKit-synced BP and rejects manual create/update/delete", async () => {
    const api = app();
    const { token, profileId } = await setupHealthKitBp(api);

    const list = await api.request(`${HEALTH_API_PREFIX}/readings/blood-pressure?personId=${profileId}`, {
      headers: { authorization: `Bearer ${token}` }
    });
    expect(list.status).toBe(200);
    const body = await list.json();
    expect(body.data).toHaveLength(1);
    expect(body.data[0]).toMatchObject({ systolic: 118, diastolic: 76, source: "healthkit" });
    const readingId = body.data[0].id as string;

    const create = await api.request(`${HEALTH_API_PREFIX}/readings/blood-pressure`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({
        personId: profileId,
        systolic: 120,
        diastolic: 80,
        measuredAt: "2026-07-25T02:00:00.000Z"
      })
    });
    expect(create.status).toBe(404);

    const patch = await api.request(`${HEALTH_API_PREFIX}/readings/blood-pressure/${readingId}`, {
      method: "PATCH",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({ systolic: 130 })
    });
    expect(patch.status).toBe(404);

    const del = await api.request(`${HEALTH_API_PREFIX}/readings/blood-pressure/${readingId}`, {
      method: "DELETE",
      headers: { authorization: `Bearer ${token}` }
    });
    expect(del.status).toBe(404);

    const stillThere = await (
      await api.request(`${HEALTH_API_PREFIX}/readings/blood-pressure?personId=${profileId}`, {
        headers: { authorization: `Bearer ${token}` }
      })
    ).json();
    expect(stillThere.data).toHaveLength(1);
    expect(stillThere.data[0].systolic).toBe(118);
  });
});
