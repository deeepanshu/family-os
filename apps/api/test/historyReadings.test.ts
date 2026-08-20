import { SignJWT } from "jose";
import { describe, expect, it } from "vitest";
import { HEALTH_API_PREFIX } from "@family-os/shared";
import { createApp } from "../src/app";
import { InMemoryFamilyRepository } from "../src/repositories/families";
import { seedHealthKitReadyGroup, sleepDayOp, stepsHourOp, workoutOp } from "./healthKitTestHelpers";

const jwtSecret = "test-supabase-jwt-secret-with-enough-length";
const supabaseUrl = "https://project.supabase.co";
const userId = "00000000-0000-4000-8000-000000000501";
const strangerId = "00000000-0000-4000-8000-000000000502";
const installationId = "53064303-35cf-4db0-a5d3-8af7d8f747e1";

function app(repo = new InMemoryFamilyRepository()) {
  return {
    api: createApp({
      config: {
        NODE_ENV: "test",
        PORT: 3001,
        HEALTH_API_ENABLE_DEV_AUTH: false,
        SUPABASE_JWT_SECRET: jwtSecret,
        SUPABASE_URL: supabaseUrl
      },
      familyRepository: repo
    }),
    repo
  };
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

async function setupSyncedProfile() {
  const { api } = app();
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
      enabledGroups: ["activity", "sleep", "workouts"],
      healthTimezone: "Asia/Bangkok",
      installationId
    })
  });
  await seedHealthKitReadyGroup(api, token, profileId, installationId, "sleep", [
    sleepDayOp("2026-08-19", { totalMinutes: 432, deepMinutes: 80, remMinutes: 90 })
  ]);
  await seedHealthKitReadyGroup(api, token, profileId, installationId, "activity", [
    stepsHourOp("2026-08-20T10:00:00.000Z", 100),
    stepsHourOp("2026-08-20T11:00:00.000Z", 50),
    stepsHourOp("2026-08-20T17:00:00.000Z", 10)
  ]);
  await seedHealthKitReadyGroup(api, token, profileId, installationId, "workouts", [
    workoutOp({
      sourceSampleKey: "e9758548-5fab-4e47-a4ac-9a05693bea71",
      workoutType: "running",
      startedAtUtc: "2026-08-19T01:40:00.000Z",
      endedAtUtc: "2026-08-19T02:12:00.000Z",
      durationSeconds: 1920,
      activeEnergyKcal: 280
    })
  ]);
  return { api, token, profileId };
}

describe("history reading lists", () => {
  it("lists sleep days newest first", async () => {
    const { api, token, profileId } = await setupSyncedProfile();
    const res = await api.request(
      `${HEALTH_API_PREFIX}/readings/sleep?personId=${profileId}&from=2026-08-01&to=2026-08-20`,
      { headers: { authorization: `Bearer ${token}` } }
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data).toEqual([
      expect.objectContaining({
        sleepDay: "2026-08-19",
        totalMinutes: 432,
        deepMinutes: 80,
        remMinutes: 90
      })
    ]);
  });

  it("rolls step hours into local days using the profile timezone", async () => {
    const { api, token, profileId } = await setupSyncedProfile();
    const res = await api.request(
      `${HEALTH_API_PREFIX}/readings/steps?personId=${profileId}&from=2026-08-20&to=2026-08-21`,
      { headers: { authorization: `Bearer ${token}` } }
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data).toEqual([
      { localDay: "2026-08-21", count: 10 },
      { localDay: "2026-08-20", count: 150 }
    ]);
  });

  it("lists workouts newest first inside the local-day window", async () => {
    const { api, token, profileId } = await setupSyncedProfile();
    const res = await api.request(
      `${HEALTH_API_PREFIX}/readings/workouts?personId=${profileId}&from=2026-08-19&to=2026-08-19`,
      { headers: { authorization: `Bearer ${token}` } }
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data).toHaveLength(1);
    expect(body.data[0]).toMatchObject({
      workoutType: "running",
      durationSeconds: 1920,
      activeEnergyKcal: 280,
      startedAtUtc: "2026-08-19T01:40:00.000Z"
    });
  });

  it("rejects a stranger listing another profile", async () => {
    const { api, profileId } = await setupSyncedProfile();
    const strangerToken = await jwtFor(strangerId);
    await api.request(`${HEALTH_API_PREFIX}/bootstrap`, {
      method: "POST",
      headers: { authorization: `Bearer ${strangerToken}` }
    });
    await api.request(`${HEALTH_API_PREFIX}/me/profile`, {
      method: "POST",
      headers: { authorization: `Bearer ${strangerToken}`, "content-type": "application/json" },
      body: JSON.stringify({ displayName: "Stranger" })
    });
    const res = await api.request(
      `${HEALTH_API_PREFIX}/readings/sleep?personId=${profileId}&from=2026-08-01&to=2026-08-20`,
      { headers: { authorization: `Bearer ${strangerToken}` } }
    );
    expect(res.status).toBe(403);
  });
});
