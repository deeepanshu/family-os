import { SignJWT } from "jose";
import { describe, expect, it } from "vitest";
import { HEALTH_API_PREFIX } from "@family-os/shared";
import { createApp } from "../src/app";
import { InMemoryFamilyRepository } from "../src/repositories/families";

const jwtSecret = "test-supabase-jwt-secret-with-enough-length";
const supabaseUrl = "https://project.supabase.co";
const userId = "00000000-0000-4000-8000-000000001001";
const otherUserId = "00000000-0000-4000-8000-000000001002";
const installationId = "53064303-35cf-4db0-a5d3-8af7d8f747e1";
const otherInstallationId = "63064303-35cf-4db0-a5d3-8af7d8f747e2";

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
  return { token, profileId: profile.data.id as string };
}

async function putSettings(
  api: ReturnType<typeof app>,
  token: string,
  profileId: string,
  overrides: Record<string, unknown> = {}
) {
  return api.request(`${HEALTH_API_PREFIX}/healthkit/settings`, {
    method: "PUT",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify({
      personId: profileId,
      consentVersion: "2026-07-25",
      enabledMetrics: ["steps", "sleep", "blood_pressure"],
      healthTimezone: "UTC",
      installationId,
      ...overrides
    })
  });
}

describe("HealthKit background sync", () => {
  it("requires a self profile before settings", async () => {
    const api = app();
    const token = await jwtFor(userId);
    await api.request(`${HEALTH_API_PREFIX}/bootstrap`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}` }
    });

    const response = await putSettings(api, token, "00000000-0000-4000-8000-000000000099");
    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toMatchObject({
      error: { code: "healthkit_self_profile_required" }
    });
  });

  it("stores settings, accepts idempotent sync, and isolates per-metric freshness", async () => {
    const api = app();
    const { token, profileId } = await setup(api);

    const settings = await putSettings(api, token, profileId);
    expect(settings.status).toBe(200);
    const settingsBody = await settings.json();
    expect(settingsBody.data).toMatchObject({
      personId: profileId,
      healthTimezone: "UTC",
      healthTimezoneVersion: 1,
      enabledMetrics: ["steps", "sleep", "blood_pressure"],
      activeInstallationId: installationId
    });

    const syncId = "7afbe594-7e1d-4b31-a9a1-420b7fba42a7";
    const syncPayload = {
      syncId,
      installationId,
      personId: profileId,
      timezoneVersion: 1,
      operations: [
        { kind: "steps_hour_upsert", hourStartUtc: "2026-07-25T02:00:00.000Z", count: 842 },
        {
          kind: "blood_pressure_upsert",
          sourceSampleKey: "5e1ed621-4a6c-4e09-969e-31c6f0872c24",
          measuredAtUtc: "2026-07-25T01:10:00.000Z",
          systolic: 118,
          diastolic: 76,
          pulse: 64
        }
      ]
    };

    const first = await api.request(`${HEALTH_API_PREFIX}/healthkit/sync`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify(syncPayload)
    });
    expect(first.status).toBe(200);
    const firstBody = await first.json();
    expect(firstBody.data).toMatchObject({
      syncId,
      accepted: true,
      operationCount: 2,
      metricsAffected: expect.arrayContaining(["steps", "blood_pressure"])
    });
    expect(JSON.stringify(firstBody)).not.toContain("118");
    expect(JSON.stringify(firstBody)).not.toContain("842");

    const replay = await api.request(`${HEALTH_API_PREFIX}/healthkit/sync`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({
        ...syncPayload,
        operations: [{ kind: "steps_hour_upsert", hourStartUtc: "2026-07-25T03:00:00.000Z", count: 1 }]
      })
    });
    expect(replay.status).toBe(200);
    await expect(replay.json()).resolves.toEqual(firstBody);

    const status = await (
      await api.request(`${HEALTH_API_PREFIX}/healthkit/settings?personId=${profileId}`, {
        headers: { authorization: `Bearer ${token}` }
      })
    ).json();
    const stepsState = status.data.metrics.find((m: { metric: string }) => m.metric === "steps");
    const sleepState = status.data.metrics.find((m: { metric: string }) => m.metric === "sleep");
    expect(stepsState.lastSuccessfulAt).toBeTruthy();
    expect(sleepState.lastSuccessfulAt).toBeFalsy();
  });

  it("rejects inactive installation and disabled metrics", async () => {
    const api = app();
    const { token, profileId } = await setup(api);
    await putSettings(api, token, profileId);

    const stale = await api.request(`${HEALTH_API_PREFIX}/healthkit/sync`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({
        syncId: "8afbe594-7e1d-4b31-a9a1-420b7fba42a8",
        installationId: otherInstallationId,
        personId: profileId,
        timezoneVersion: 1,
        operations: [{ kind: "steps_hour_upsert", hourStartUtc: "2026-07-25T02:00:00.000Z", count: 10 }]
      })
    });
    expect(stale.status).toBe(403);
    await expect(stale.json()).resolves.toMatchObject({
      error: { code: "healthkit_installation_inactive" }
    });

    await putSettings(api, token, profileId, {
      enabledMetrics: ["sleep"],
      replaceActiveInstallation: false
    });
    const disabled = await api.request(`${HEALTH_API_PREFIX}/healthkit/sync`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({
        syncId: "9afbe594-7e1d-4b31-a9a1-420b7fba42a9",
        installationId,
        personId: profileId,
        timezoneVersion: 1,
        operations: [{ kind: "steps_hour_upsert", hourStartUtc: "2026-07-25T02:00:00.000Z", count: 10 }]
      })
    });
    expect(disabled.status).toBe(403);
    await expect(disabled.json()).resolves.toMatchObject({
      error: { code: "healthkit_metric_disabled" }
    });
  });

  it("fences the previous phone when replacing the active installation", async () => {
    const api = app();
    const { token, profileId } = await setup(api);
    await putSettings(api, token, profileId);

    const withoutFlag = await putSettings(api, token, profileId, {
      installationId: otherInstallationId
    });
    expect(withoutFlag.status).toBe(409);

    const replaced = await putSettings(api, token, profileId, {
      installationId: otherInstallationId,
      replaceActiveInstallation: true
    });
    expect(replaced.status).toBe(200);
    await expect(replaced.json()).resolves.toMatchObject({
      data: { activeInstallationId: otherInstallationId }
    });

    const oldPhone = await api.request(`${HEALTH_API_PREFIX}/healthkit/sync`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({
        syncId: "aafbe594-7e1d-4b31-a9a1-420b7fba42aa",
        installationId,
        personId: profileId,
        timezoneVersion: 1,
        operations: [{ kind: "steps_hour_upsert", hourStartUtc: "2026-07-25T02:00:00.000Z", count: 10 }]
      })
    });
    expect(oldPhone.status).toBe(403);
  });

  it("runs a chunked repair and rejects incomplete completion", async () => {
    const api = app();
    const { token, profileId } = await setup(api);
    await putSettings(api, token, profileId);

    const created = await api.request(`${HEALTH_API_PREFIX}/healthkit/repairs`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({
        installationId,
        personId: profileId,
        metric: "steps",
        timezoneVersion: 1
      })
    });
    expect(created.status).toBe(201);
    const repair = (await created.json()).data;
    expect(repair.repairId).toBeTruthy();

    const incomplete = await api.request(`${HEALTH_API_PREFIX}/healthkit/repairs/${repair.repairId}/complete`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({ expectedChunkCount: 1 })
    });
    expect(incomplete.status).toBe(409);
    await expect(incomplete.json()).resolves.toMatchObject({
      error: { code: "healthkit_repair_incomplete" }
    });

    const chunkSyncId = "bafbe594-7e1d-4b31-a9a1-420b7fba42ab";
    const chunk = await api.request(`${HEALTH_API_PREFIX}/healthkit/sync`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({
        syncId: chunkSyncId,
        installationId,
        personId: profileId,
        timezoneVersion: 1,
        repairId: repair.repairId,
        chunkIndex: 0,
        operations: [{ kind: "steps_hour_upsert", hourStartUtc: "2026-07-20T02:00:00.000Z", count: 100 }]
      })
    });
    expect(chunk.status).toBe(200);

    const replayChunk = await api.request(`${HEALTH_API_PREFIX}/healthkit/sync`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({
        syncId: "cafbe594-7e1d-4b31-a9a1-420b7fba42ac",
        installationId,
        personId: profileId,
        timezoneVersion: 1,
        repairId: repair.repairId,
        chunkIndex: 0,
        operations: [{ kind: "steps_hour_upsert", hourStartUtc: "2026-07-20T03:00:00.000Z", count: 1 }]
      })
    });
    expect(replayChunk.status).toBe(200);
    const chunkBody = await chunk.json();
    await expect(replayChunk.json()).resolves.toEqual(chunkBody);

    const complete = await api.request(`${HEALTH_API_PREFIX}/healthkit/repairs/${repair.repairId}/complete`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({ expectedChunkCount: 1 })
    });
    expect(complete.status).toBe(200);
    await expect(complete.json()).resolves.toMatchObject({
      data: { completed: true, expectedChunkCount: 1, completedChunkCount: 1 }
    });
  });

  it("stores profile-local sleep day bounds on repairs and validates sleep against them", async () => {
    const api = app();
    const { token, profileId } = await setup(api);
    await putSettings(api, token, profileId, { healthTimezone: "America/Los_Angeles" });

    const created = await (
      await api.request(`${HEALTH_API_PREFIX}/healthkit/repairs`, {
        method: "POST",
        headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
        body: JSON.stringify({
          installationId,
          personId: profileId,
          metric: "sleep",
          timezoneVersion: 1
        })
      })
    ).json();
    expect(created.data.rangeStartDay).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(created.data.rangeEndDay).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(created.data.rangeStartDay <= created.data.rangeEndDay).toBe(true);

    const outside = await api.request(`${HEALTH_API_PREFIX}/healthkit/sync`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({
        syncId: "b2fbe594-7e1d-4b31-a9a1-420b7fba42b2",
        installationId,
        personId: profileId,
        timezoneVersion: 1,
        repairId: created.data.repairId,
        chunkIndex: 0,
        operations: [{ kind: "sleep_day_upsert", sleepDay: "2019-01-01", durationMinutes: 400 }]
      })
    });
    expect(outside.status).toBe(400);
    await expect(outside.json()).resolves.toMatchObject({
      error: { code: "healthkit_operation_invalid" }
    });

    const insideDay = created.data.rangeEndDay as string;
    const ok = await api.request(`${HEALTH_API_PREFIX}/healthkit/sync`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({
        syncId: "b3fbe594-7e1d-4b31-a9a1-420b7fba42b3",
        installationId,
        personId: profileId,
        timezoneVersion: 1,
        repairId: created.data.repairId,
        chunkIndex: 0,
        operations: [{ kind: "sleep_day_upsert", sleepDay: insideDay, durationMinutes: 400 }]
      })
    });
    expect(ok.status).toBe(200);
  });

  it("rejects repair chunks outside the server 90-day range and completion after metric disable", async () => {
    const api = app();
    const { token, profileId } = await setup(api);
    await putSettings(api, token, profileId);

    const created = await (
      await api.request(`${HEALTH_API_PREFIX}/healthkit/repairs`, {
        method: "POST",
        headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
        body: JSON.stringify({
          installationId,
          personId: profileId,
          metric: "steps",
          timezoneVersion: 1
        })
      })
    ).json();
    const repairId = created.data.repairId as string;

    const tooOld = await api.request(`${HEALTH_API_PREFIX}/healthkit/sync`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({
        syncId: "b0fbe594-7e1d-4b31-a9a1-420b7fba42b0",
        installationId,
        personId: profileId,
        timezoneVersion: 1,
        repairId,
        chunkIndex: 0,
        operations: [{ kind: "steps_hour_upsert", hourStartUtc: "2020-01-01T00:00:00.000Z", count: 100 }]
      })
    });
    expect(tooOld.status).toBe(400);
    await expect(tooOld.json()).resolves.toMatchObject({
      error: { code: "healthkit_operation_invalid" }
    });

    const okChunk = await api.request(`${HEALTH_API_PREFIX}/healthkit/sync`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({
        syncId: "b1fbe594-7e1d-4b31-a9a1-420b7fba42b1",
        installationId,
        personId: profileId,
        timezoneVersion: 1,
        repairId,
        chunkIndex: 0,
        operations: [{ kind: "steps_hour_upsert", hourStartUtc: "2026-07-20T02:00:00.000Z", count: 100 }]
      })
    });
    expect(okChunk.status).toBe(200);

    await putSettings(api, token, profileId, { enabledMetrics: ["sleep"] });
    const completeAfterDisable = await api.request(`${HEALTH_API_PREFIX}/healthkit/repairs/${repairId}/complete`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({ expectedChunkCount: 1 })
    });
    expect(completeAfterDisable.status).toBe(403);
    await expect(completeAfterDisable.json()).resolves.toMatchObject({
      error: { code: "healthkit_metric_disabled" }
    });
  });

  it("upserts and hard-deletes HealthKit blood pressure by correlation UUID", async () => {
    const api = app();
    const { token, profileId } = await setup(api);
    await putSettings(api, token, profileId);
    const sourceSampleKey = "5e1ed621-4a6c-4e09-969e-31c6f0872c24";

    await api.request(`${HEALTH_API_PREFIX}/healthkit/sync`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({
        syncId: "dafbe594-7e1d-4b31-a9a1-420b7fba42ad",
        installationId,
        personId: profileId,
        timezoneVersion: 1,
        operations: [
          {
            kind: "blood_pressure_upsert",
            sourceSampleKey,
            measuredAtUtc: "2026-07-25T01:10:00.000Z",
            systolic: 118,
            diastolic: 76
          }
        ]
      })
    });

    const list1 = await (
      await api.request(`${HEALTH_API_PREFIX}/readings/blood-pressure?personId=${profileId}`, {
        headers: { authorization: `Bearer ${token}` }
      })
    ).json();
    expect(list1.data).toHaveLength(1);
    expect(list1.data[0]).toMatchObject({ systolic: 118, source: "healthkit" });

    await api.request(`${HEALTH_API_PREFIX}/healthkit/sync`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({
        syncId: "eafbe594-7e1d-4b31-a9a1-420b7fba42ae",
        installationId,
        personId: profileId,
        timezoneVersion: 1,
        operations: [
          {
            kind: "blood_pressure_upsert",
            sourceSampleKey,
            measuredAtUtc: "2026-07-25T01:10:00.000Z",
            systolic: 122,
            diastolic: 78
          }
        ]
      })
    });
    const list2 = await (
      await api.request(`${HEALTH_API_PREFIX}/readings/blood-pressure?personId=${profileId}`, {
        headers: { authorization: `Bearer ${token}` }
      })
    ).json();
    expect(list2.data).toHaveLength(1);
    expect(list2.data[0].systolic).toBe(122);

    await api.request(`${HEALTH_API_PREFIX}/healthkit/sync`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({
        syncId: "fafbe594-7e1d-4b31-a9a1-420b7fba42af",
        installationId,
        personId: profileId,
        timezoneVersion: 1,
        operations: [{ kind: "blood_pressure_delete", sourceSampleKey }]
      })
    });
    const list3 = await (
      await api.request(`${HEALTH_API_PREFIX}/readings/blood-pressure?personId=${profileId}`, {
        headers: { authorization: `Bearer ${token}` }
      })
    ).json();
    expect(list3.data).toHaveLength(0);
  });

  it("rejects non-self profile and another family member targeting the manager profile", async () => {
    const api = app();
    const { token, profileId } = await setup(api);

    const otherProfile = await (
      await api.request(`${HEALTH_API_PREFIX}/people`, {
        method: "POST",
        headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
        body: JSON.stringify({ displayName: "Mom", relationshipLabel: "Mother" })
      })
    ).json();

    const nonSelf = await putSettings(api, token, otherProfile.data.id);
    expect(nonSelf.status).toBe(409);

    const invite = await (
      await api.request(`${HEALTH_API_PREFIX}/invites`, {
        method: "POST",
        headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
        body: JSON.stringify({ email: `${otherUserId}@example.com`, role: "member" })
      })
    ).json();
    await api.request(`${HEALTH_API_PREFIX}/invites/${invite.data.token}/accept`, {
      method: "POST",
      headers: { authorization: `Bearer ${await jwtFor(otherUserId)}` }
    });
    await api.request(`${HEALTH_API_PREFIX}/me/profile`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${await jwtFor(otherUserId)}`,
        "content-type": "application/json"
      },
      body: JSON.stringify({ displayName: "Other" })
    });

    const hijack = await putSettings(api, await jwtFor(otherUserId), profileId);
    expect(hijack.status).toBe(409);
  });

  it("rejects non-hour-boundary step ops and unknown fields", async () => {
    const api = app();
    const { token, profileId } = await setup(api);
    await putSettings(api, token, profileId);

    const badHour = await api.request(`${HEALTH_API_PREFIX}/healthkit/sync`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({
        syncId: "1afbe594-7e1d-4b31-a9a1-420b7fba4211",
        installationId,
        personId: profileId,
        timezoneVersion: 1,
        operations: [{ kind: "steps_hour_upsert", hourStartUtc: "2026-07-25T02:15:00.000Z", count: 10 }]
      })
    });
    expect(badHour.status).toBe(400);

    const unknownField = await api.request(`${HEALTH_API_PREFIX}/healthkit/sync`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({
        syncId: "2afbe594-7e1d-4b31-a9a1-420b7fba4212",
        installationId,
        personId: profileId,
        timezoneVersion: 1,
        familyId: "00000000-0000-4000-8000-000000000001",
        operations: []
      })
    });
    expect(unknownField.status).toBe(400);
  });
});
