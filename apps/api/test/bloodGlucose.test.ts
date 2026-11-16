import { SignJWT } from "jose";
import { describe, expect, it } from "vitest";
import { HEALTH_API_PREFIX } from "@family-os/shared";
import { createApp } from "../src/app";
import { InMemoryFamilyRepository } from "../src/repositories/families";
import { bloodGlucoseOp, postOps, seedHealthKitReadyGroup } from "./healthKitTestHelpers";
import { setupHousehold, setupSoloUser } from "./soloSetup";

const jwtSecret = "test-supabase-jwt-secret-with-enough-length";
const supabaseUrl = "https://project.supabase.co";
const userId = "00000000-0000-4000-8000-000000000701";
const joinerId = "00000000-0000-4000-8000-000000000702";
const strangerId = "00000000-0000-4000-8000-000000000703";
const installationId = "53064303-35cf-4db0-a5d3-8af7d8f747e1";
const sourceSampleKey = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";

function app(repo = new InMemoryFamilyRepository()) {
  return createApp({
    config: {
      NODE_ENV: "test",
      PORT: 3001,
      HEALTH_API_ENABLE_DEV_AUTH: false,
      SUPABASE_JWT_SECRET: jwtSecret,
      SUPABASE_URL: supabaseUrl
    },
    familyRepository: repo
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

async function setupSyncedSelf(api: ReturnType<typeof app>, subject = userId) {
  const token = await jwtFor(subject);
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
      enabledGroups: ["vitals"],
      healthTimezone: "UTC",
      installationId
    })
  });
  return { token, profileId };
}

describe("blood glucose HealthKit ingest", () => {
  it("round-trips mealTime and is idempotent on the natural key", async () => {
    const api = app();
    const { token, profileId } = await setupSyncedSelf(api);
    await seedHealthKitReadyGroup(api, token, profileId, installationId, "vitals", [
      bloodGlucoseOp({
        sourceSampleKey,
        measuredAtUtc: "2026-08-19T11:00:00.000Z",
        valueMgDl: 104,
        mealTime: "preprandial"
      })
    ]);

    const listed = await (
      await api.request(
        `${HEALTH_API_PREFIX}/readings/blood-glucose?personId=${profileId}&from=2026-08-19&to=2026-08-19`,
        { headers: { authorization: `Bearer ${token}` } }
      )
    ).json();
    expect(listed.data).toEqual([
      expect.objectContaining({
        value: 104,
        unit: "mg/dL",
        mealTime: "preprandial",
        source: "healthkit"
      })
    ]);
    expect(listed.data[0]).not.toHaveProperty("context");

    const second = await postOps(api, token, profileId, installationId, [
      bloodGlucoseOp({
        sourceSampleKey,
        measuredAtUtc: "2026-08-19T11:00:00.000Z",
        valueMgDl: 118,
        mealTime: "postprandial"
      })
    ]);
    expect(second.status).toBe(200);
    expect((await second.json()).data.results[0].result).toBe("applied");

    const updated = await (
      await api.request(
        `${HEALTH_API_PREFIX}/readings/blood-glucose?personId=${profileId}&from=2026-08-19&to=2026-08-19`,
        { headers: { authorization: `Bearer ${token}` } }
      )
    ).json();
    expect(updated.data).toHaveLength(1);
    expect(updated.data[0]).toMatchObject({ value: 118, mealTime: "postprandial" });
  });

  it("omits mealTime when HealthKit metadata is absent", async () => {
    const api = app();
    const { token, profileId } = await setupSyncedSelf(api);
    await seedHealthKitReadyGroup(api, token, profileId, installationId, "vitals", [
      bloodGlucoseOp({
        sourceSampleKey,
        measuredAtUtc: "2026-08-19T09:18:00.000Z",
        valueMgDl: 98
      })
    ]);
    const listed = await (
      await api.request(
        `${HEALTH_API_PREFIX}/readings/blood-glucose?personId=${profileId}&from=2026-08-19&to=2026-08-19`,
        { headers: { authorization: `Bearer ${token}` } }
      )
    ).json();
    expect(listed.data).toHaveLength(1);
    expect(listed.data[0].value).toBe(98);
    expect(listed.data[0].mealTime).toBeUndefined();
  });

  it("has no manual POST or PATCH", async () => {
    const api = app();
    const { token, profileId } = await setupSyncedSelf(api);
    const create = await api.request(`${HEALTH_API_PREFIX}/readings/blood-glucose`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({
        personId: profileId,
        value: 105,
        unit: "mg/dL",
        measuredAt: "2026-08-19T10:00:00.000Z"
      })
    });
    expect(create.status).toBe(404);

    const patch = await api.request(`${HEALTH_API_PREFIX}/readings/blood-glucose/${sourceSampleKey}`, {
      method: "PATCH",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({ value: 90 })
    });
    expect(patch.status).toBe(404);
  });
});

describe("blood glucose household access", () => {
  it("lets a member read another Self but not write it, and denies strangers and departed members", async () => {
    const api = app();
    const creatorToken = await jwtFor(userId);
    const joinerToken = await jwtFor(joinerId);
    const strangerToken = await jwtFor(strangerId);
    const creator = await setupSoloUser(api, creatorToken, "Deepanshu");
    await setupHousehold(api, creatorToken);
    await setupSoloUser(api, joinerToken, "Riya");
    await setupSoloUser(api, strangerToken, "Stranger");

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
      bloodGlucoseOp({
        sourceSampleKey,
        measuredAtUtc: "2026-08-19T11:00:00.000Z",
        valueMgDl: 104,
        mealTime: "preprandial"
      })
    ]);

    const minted = await api.request(`${HEALTH_API_PREFIX}/invites`, {
      method: "POST",
      headers: { authorization: `Bearer ${creatorToken}`, "content-type": "application/json" },
      body: JSON.stringify({})
    });
    const invite = await minted.json();
    expect(
      (
        await api.request(`${HEALTH_API_PREFIX}/invites/${invite.data.token}/accept`, {
          method: "POST",
          headers: { authorization: `Bearer ${joinerToken}`, "content-type": "application/json" },
          body: JSON.stringify({ relationshipLabel: "Father" })
        })
      ).status
    ).toBe(200);

    const readable = await api.request(
      `${HEALTH_API_PREFIX}/readings/blood-glucose?personId=${creator.profileId}&from=2026-08-19&to=2026-08-19`,
      { headers: { authorization: `Bearer ${joinerToken}` } }
    );
    expect(readable.status).toBe(200);
    expect((await readable.json()).data).toEqual([
      expect.objectContaining({ personId: creator.profileId, value: 104, mealTime: "preprandial" })
    ]);

    const stranger = await api.request(
      `${HEALTH_API_PREFIX}/readings/blood-glucose?personId=${creator.profileId}&from=2026-08-19&to=2026-08-19`,
      { headers: { authorization: `Bearer ${strangerToken}` } }
    );
    expect(stranger.status).toBe(403);

    const write = await postOps(api, joinerToken, creator.profileId, installationId, [
      bloodGlucoseOp({
        sourceSampleKey: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
        measuredAtUtc: "2026-08-19T12:00:00.000Z",
        valueMgDl: 90
      })
    ]);
    expect(write.status).toBe(403);

    expect(
      (
        await api.request(`${HEALTH_API_PREFIX}/families/leave`, {
          method: "POST",
          headers: { authorization: `Bearer ${joinerToken}` }
        })
      ).status
    ).toBe(204);
    const afterLeave = await api.request(
      `${HEALTH_API_PREFIX}/readings/blood-glucose?personId=${creator.profileId}&from=2026-08-19&to=2026-08-19`,
      { headers: { authorization: `Bearer ${joinerToken}` } }
    );
    expect(afterLeave.status).toBe(403);
  });
});
