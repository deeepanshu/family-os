import { SignJWT } from "jose";
import { describe, expect, it } from "vitest";
import { HEALTH_API_PREFIX } from "@family-os/shared";
import { createApp } from "../src/app";
import { InMemoryFamilyRepository } from "../src/repositories/families";

const jwtSecret = "test-supabase-jwt-secret-with-enough-length";
const supabaseUrl = "https://project.supabase.co";
const userId = "00000000-0000-4000-8000-000000001001";
const otherUserId = "00000000-0000-4000-8000-000000001002";

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

async function jwtFor(subject: string) {
  return new SignJWT({ role: "authenticated", email: `${subject}@example.com` })
    .setProtectedHeader({ alg: "HS256" })
    .setSubject(subject)
    .setIssuer(`${supabaseUrl}/auth/v1`)
    .setAudience("authenticated")
    .setIssuedAt()
    .setExpirationTime("1h")
    .sign(new TextEncoder().encode(jwtSecret));
}

async function setup(api: ReturnType<typeof app>) {
  const token = await jwtFor(userId);
  await api.request(`${HEALTH_API_PREFIX}/families`, {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify({ name: "Jain Family" })
  });
  const profile = await (await api.request(`${HEALTH_API_PREFIX}/people`, {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify({ displayName: "Deepanshu", relationshipLabel: "Self" })
  })).json();
  return { token, profileId: profile.data.id };
}

describe("HealthKit sync", () => {
  it("requires a linked profile before import", async () => {
    const api = app();
    const { token } = await setup(api);

    const response = await api.request(`${HEALTH_API_PREFIX}/healthkit/samples/batch`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({ samples: [] })
    });

    expect(response.status).toBe(409);
  });

  it("links a profile, stores settings, imports samples, dedupes, and exposes summaries", async () => {
    const api = app();
    const { token, profileId } = await setup(api);

    const link = await api.request(`${HEALTH_API_PREFIX}/healthkit/link-profile`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({ personId: profileId })
    });
    expect(link.status).toBe(200);

    const settings = await api.request(`${HEALTH_API_PREFIX}/healthkit/sync/settings`, {
      method: "PATCH",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({ enabledMetrics: ["steps", "walking_distance", "sleep", "weight", "blood_pressure", "blood_glucose"] })
    });
    expect(settings.status).toBe(200);

    const imported = await api.request(`${HEALTH_API_PREFIX}/healthkit/samples/batch`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({
        samples: [
          {
            metricType: "steps",
            sourceSampleKey: "steps-1",
            startDate: "2026-06-30T00:00:00.000Z",
            endDate: "2026-06-30T23:59:00.000Z",
            value: 8000,
            unit: "count"
          },
          {
            metricType: "walking_distance",
            sourceSampleKey: "distance-1",
            startDate: "2026-06-30T00:00:00.000Z",
            value: 5600,
            unit: "m"
          },
          {
            metricType: "sleep",
            sourceSampleKey: "sleep-1",
            startDate: "2026-06-30T00:00:00.000Z",
            value: 420,
            unit: "min"
          },
          {
            metricType: "weight",
            sourceSampleKey: "weight-1",
            startDate: "2026-06-30T08:00:00.000Z",
            value: 75,
            unit: "kg"
          },
          {
            metricType: "blood_pressure",
            sourceSampleKey: "bp-1",
            startDate: "2026-06-30T09:00:00.000Z",
            systolic: 121,
            diastolic: 79,
            pulse: 70
          },
          {
            metricType: "blood_glucose",
            sourceSampleKey: "glucose-1",
            startDate: "2026-06-30T09:05:00.000Z",
            value: 104,
            unit: "mg/dL",
            glucoseContext: "fasting"
          }
        ]
      })
    });
    expect(imported.status).toBe(201);
    await expect(imported.json()).resolves.toMatchObject({
      data: {
        importedCount: 6,
        skippedCount: 0,
        failedCount: 0
      }
    });

    const duplicate = await api.request(`${HEALTH_API_PREFIX}/healthkit/samples/batch`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({
        samples: [{ metricType: "steps", sourceSampleKey: "steps-1", startDate: "2026-06-30T00:00:00.000Z", value: 8000 }]
      })
    });
    await expect(duplicate.json()).resolves.toMatchObject({
      data: {
        importedCount: 0,
        skippedCount: 1,
        failedCount: 0
      }
    });

    const bpHistory = await (await api.request(`${HEALTH_API_PREFIX}/readings/blood-pressure?personId=${profileId}`, {
      headers: { authorization: `Bearer ${token}` }
    })).json();
    expect(bpHistory.data[0]).toMatchObject({ systolic: 121, source: "healthkit" });

    const glucoseHistory = await (await api.request(`${HEALTH_API_PREFIX}/readings/blood-glucose?personId=${profileId}`, {
      headers: { authorization: `Bearer ${token}` }
    })).json();
    expect(glucoseHistory.data[0]).toMatchObject({ value: 104, source: "healthkit" });

    const summaries = await (await api.request(`${HEALTH_API_PREFIX}/healthkit/metrics/daily?personId=${profileId}`, {
      headers: { authorization: `Bearer ${token}` }
    })).json();
    expect(summaries.data).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ metricType: "steps", value: 8000, unit: "count" }),
        expect.objectContaining({ metricType: "walking_distance", value: 5600, unit: "m" }),
        expect.objectContaining({ metricType: "sleep", value: 420, unit: "min" }),
        expect.objectContaining({ metricType: "weight", value: 75, unit: "kg" })
      ])
    );
  });

  it("blocks non-members from linking someone else's profile", async () => {
    const api = app();
    const { profileId } = await setup(api);

    const response = await api.request(`${HEALTH_API_PREFIX}/healthkit/link-profile`, {
      method: "POST",
      headers: { authorization: `Bearer ${await jwtFor(otherUserId)}`, "content-type": "application/json" },
      body: JSON.stringify({ personId: profileId })
    });

    expect(response.status).toBe(403);
  });

  it("blocks another family member from linking an already linked profile", async () => {
    const api = app();
    const { token, profileId } = await setup(api);

    const invite = await (await api.request(`${HEALTH_API_PREFIX}/invites`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({ email: `${otherUserId}@example.com`, role: "member" })
    })).json();
    await api.request(`${HEALTH_API_PREFIX}/invites/${invite.data.token}/accept`, {
      method: "POST",
      headers: { authorization: `Bearer ${await jwtFor(otherUserId)}` }
    });

    const firstLink = await api.request(`${HEALTH_API_PREFIX}/healthkit/link-profile`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({ personId: profileId })
    });
    expect(firstLink.status).toBe(200);

    const secondLink = await api.request(`${HEALTH_API_PREFIX}/healthkit/link-profile`, {
      method: "POST",
      headers: { authorization: `Bearer ${await jwtFor(otherUserId)}`, "content-type": "application/json" },
      body: JSON.stringify({ personId: profileId })
    });

    expect(secondLink.status).toBe(409);
  });
});
