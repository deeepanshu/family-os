import { SignJWT } from "jose";
import { describe, expect, it } from "vitest";
import {
  HEALTH_API_PREFIX,
  HEALTHKIT_FROZEN_FINGERPRINTS,
  assertFrozenFingerprintsStable,
  bloodPressureNaturalKey
} from "@family-os/shared";
import { createApp } from "../src/app";
import { InMemoryFamilyRepository } from "../src/repositories/families";
import { bloodPressureDeleteOp, bloodPressureOp } from "./healthKitTestHelpers";

const jwtSecret = "test-supabase-jwt-secret-with-enough-length";
const supabaseUrl = "https://project.supabase.co";
const userId = "00000000-0000-4000-8000-000000001001";
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
      enabledGroups: ["vitals"],
      healthTimezone: "UTC",
      installationId,
      ...overrides
    })
  });
}

describe("HealthKit canonical fingerprints", () => {
  it("keeps frozen fixture digests stable for historical serializers", () => {
    assertFrozenFingerprintsStable();
    expect(HEALTHKIT_FROZEN_FINGERPRINTS.stepsHourUpsert).toMatch(/^[a-f0-9]{64}$/);
  });
});

describe("HealthKit ops:batch (BP milestone)", () => {
  it("applies blood pressure upsert by natural key", async () => {
    const api = app();
    const { token, profileId } = await setup(api);
    await putSettings(api, token, profileId);

    const sourceObjectKey = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
    const op = bloodPressureOp({
      sourceObjectKey,
      measuredAtUtc: "2026-07-20T08:00:00.000Z",
      systolic: 120,
      diastolic: 80,
      pulse: 70
    });

    const res = await api.request(`${HEALTH_API_PREFIX}/healthkit/ops:batch`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({
        installationId,
        personId: profileId,
        timezoneVersion: 1,
        ops: [op]
      })
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data.results).toEqual([{ opId: op.opId, result: "applied" }]);
    expect(op.naturalKey).toBe(bloodPressureNaturalKey(sourceObjectKey));
  });

  it("returns duplicate for the same op_id without double truth", async () => {
    const api = app();
    const { token, profileId } = await setup(api);
    await putSettings(api, token, profileId);

    const op = bloodPressureOp({
      sourceObjectKey: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
      measuredAtUtc: "2026-07-20T09:00:00.000Z",
      systolic: 118,
      diastolic: 76
    });

    const payload = {
      installationId,
      personId: profileId,
      timezoneVersion: 1,
      ops: [op]
    };

    const first = await api.request(`${HEALTH_API_PREFIX}/healthkit/ops:batch`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify(payload)
    });
    expect(first.status).toBe(200);
    expect((await first.json()).data.results[0].result).toBe("applied");

    const second = await api.request(`${HEALTH_API_PREFIX}/healthkit/ops:batch`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify(payload)
    });
    expect(second.status).toBe(200);
    expect((await second.json()).data.results[0].result).toBe("duplicate");
  });

  it("upserts again with a new op_id overwrites natural key", async () => {
    const api = app();
    const { token, profileId } = await setup(api);
    await putSettings(api, token, profileId);

    const sourceObjectKey = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
    const first = bloodPressureOp({
      sourceObjectKey,
      measuredAtUtc: "2026-07-20T10:00:00.000Z",
      systolic: 130,
      diastolic: 85
    });
    const second = bloodPressureOp({
      sourceObjectKey,
      measuredAtUtc: "2026-07-20T10:00:00.000Z",
      systolic: 125,
      diastolic: 82
    });

    for (const op of [first, second]) {
      const res = await api.request(`${HEALTH_API_PREFIX}/healthkit/ops:batch`, {
        method: "POST",
        headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
        body: JSON.stringify({
          installationId,
          personId: profileId,
          timezoneVersion: 1,
          ops: [op]
        })
      });
      expect(res.status).toBe(200);
      expect((await res.json()).data.results[0].result).toBe("applied");
    }

    await api.request(`${HEALTH_API_PREFIX}/healthkit/groups/vitals/ready`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({ installationId, personId: profileId, timezoneVersion: 1 })
    });

    const readings = await (
      await api.request(
        `${HEALTH_API_PREFIX}/readings/blood-pressure?personId=${profileId}`,
        { headers: { authorization: `Bearer ${token}` } }
      )
    ).json();
    const bp = readings.data.find((r: { id: string }) => r.id === sourceObjectKey) ?? readings.data[0];
    expect(bp.systolic).toBe(125);
    expect(bp.diastolic).toBe(82);
  });

  it("deletes BP by natural key", async () => {
    const api = app();
    const { token, profileId } = await setup(api);
    await putSettings(api, token, profileId);
    const sourceObjectKey = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
    const upsert = bloodPressureOp({
      sourceObjectKey,
      measuredAtUtc: "2026-07-20T11:00:00.000Z",
      systolic: 140,
      diastolic: 90
    });
    await api.request(`${HEALTH_API_PREFIX}/healthkit/ops:batch`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({
        installationId,
        personId: profileId,
        timezoneVersion: 1,
        ops: [upsert]
      })
    });

    const del = bloodPressureDeleteOp(sourceObjectKey);
    const res = await api.request(`${HEALTH_API_PREFIX}/healthkit/ops:batch`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({
        installationId,
        personId: profileId,
        timezoneVersion: 1,
        ops: [del]
      })
    });
    expect(res.status).toBe(200);
    expect((await res.json()).data.results[0].result).toBe("applied");
  });

  it("rejects invalid BP payload without failing fencing of valid ops", async () => {
    const api = app();
    const { token, profileId } = await setup(api);
    await putSettings(api, token, profileId);

    const good = bloodPressureOp({
      measuredAtUtc: "2026-07-20T12:00:00.000Z",
      systolic: 110,
      diastolic: 70
    });
    const bad = {
      ...bloodPressureOp({
        measuredAtUtc: "2026-07-20T12:05:00.000Z",
        systolic: 90,
        diastolic: 100
      }),
      naturalKey: "blood_pressure:eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee",
      payload: {
        kind: "blood_pressure" as const,
        sourceObjectKey: "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee",
        measuredAtUtc: "2026-07-20T12:05:00.000Z",
        systolic: 90,
        diastolic: 100
      }
    };

    const res = await api.request(`${HEALTH_API_PREFIX}/healthkit/ops:batch`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({
        installationId,
        personId: profileId,
        timezoneVersion: 1,
        ops: [good, bad]
      })
    });
    expect(res.status).toBe(200);
    const results = (await res.json()).data.results;
    expect(results[0].result).toBe("applied");
    expect(results[1].result).toBe("rejected");
  });

  it("start-import sets syncing; ready gates status", async () => {
    const api = app();
    const { token, profileId } = await setup(api);
    await putSettings(api, token, profileId);

    const start = await api.request(`${HEALTH_API_PREFIX}/healthkit/groups/vitals/start-import`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({ installationId, personId: profileId, timezoneVersion: 1 })
    });
    expect(start.status).toBe(200);
    expect((await start.json()).data.status).toBe("syncing");

    const mid = await api.request(`${HEALTH_API_PREFIX}/healthkit/groups/vitals/status`, {
      headers: { authorization: `Bearer ${token}` }
    });
    expect((await mid.json()).data.status).toBe("syncing");

    const ready = await api.request(`${HEALTH_API_PREFIX}/healthkit/groups/vitals/ready`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({ installationId, personId: profileId, timezoneVersion: 1 })
    });
    expect(ready.status).toBe(200);
    expect((await ready.json()).data.status).toBe("ready");
  });

  it("installation replace forces never_synced", async () => {
    const api = app();
    const { token, profileId } = await setup(api);
    await putSettings(api, token, profileId);
    await api.request(`${HEALTH_API_PREFIX}/healthkit/groups/vitals/ready`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({ installationId, personId: profileId, timezoneVersion: 1 })
    });

    const replaced = await putSettings(api, token, profileId, {
      installationId: otherInstallationId,
      replaceActiveInstallation: true
    });
    expect(replaced.status).toBe(200);
    const settings = await replaced.json();
    const vitals = settings.data.groups.find((g: { group: string }) => g.group === "vitals");
    expect(vitals.status).toBe("never_synced");
    expect(settings.data.activeInstallationId).toBe(otherInstallationId);
  });

  it("rejects inactive installation on ops batch", async () => {
    const api = app();
    const { token, profileId } = await setup(api);
    await putSettings(api, token, profileId);

    const op = bloodPressureOp({
      measuredAtUtc: "2026-07-20T13:00:00.000Z",
      systolic: 120,
      diastolic: 80
    });
    const res = await api.request(`${HEALTH_API_PREFIX}/healthkit/ops:batch`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({
        installationId: otherInstallationId,
        personId: profileId,
        timezoneVersion: 1,
        ops: [op]
      })
    });
    expect(res.status).toBe(403);
    expect((await res.json()).error.code).toBe("installation_inactive");
  });
});
