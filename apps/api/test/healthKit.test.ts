import { SignJWT } from "jose";
import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import {
  HEALTH_API_PREFIX,
  HEALTHKIT_FROZEN_FINGERPRINTS,
  assertFrozenFingerprintsStable,
  fingerprintHealthEvent,
  fingerprintScopeManifest,
  requiredScopeKeysForGroup,
  type HealthKitSyncEvent
} from "@family-os/shared";
import { createApp } from "../src/app";
import { InMemoryFamilyRepository } from "../src/repositories/families";

const jwtSecret = "test-supabase-jwt-secret-with-enough-length";
const supabaseUrl = "https://project.supabase.co";
const userId = "00000000-0000-4000-8000-000000001001";
const installationId = "53064303-35cf-4db0-a5d3-8af7d8f747e1";
const otherInstallationId = "63064303-35cf-4db0-a5d3-8af7d8f747e2";

function nodeSha256(data: Uint8Array): Uint8Array {
  return createHash("sha256").update(data).digest();
}

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
      enabledGroups: ["activity", "sleep", "vitals"],
      healthTimezone: "UTC",
      installationId,
      ...overrides
    })
  });
}

function stepsEvent(overrides: Partial<HealthKitSyncEvent> = {}): HealthKitSyncEvent {
  return {
    eventId: overrides.eventId ?? crypto.randomUUID(),
    entityKey: overrides.entityKey ?? "steps_hour:2026-07-25T14:00:00.000Z",
    entityVersion: overrides.entityVersion ?? 1,
    group: overrides.group ?? "activity",
    scopeKey: overrides.scopeKey ?? "steps",
    op: overrides.op ?? "upsert",
    sessionId: overrides.sessionId ?? null,
    payload:
      overrides.payload === undefined
        ? {
            kind: "steps_hour",
            hourStartUtc: "2026-07-25T14:00:00.000Z",
            count: 1200
          }
        : overrides.payload
  };
}

describe("HealthKit canonical fingerprints", () => {
  it("keeps frozen fixture digests stable", () => {
    assertFrozenFingerprintsStable();
    expect(HEALTHKIT_FROZEN_FINGERPRINTS.stepsHourUpsert).toMatch(/^[a-f0-9]{64}$/);
    expect(HEALTHKIT_FROZEN_FINGERPRINTS.scopeManifest).toMatch(/^[a-f0-9]{64}$/);
  });
});

describe("HealthKit outbox sync API", () => {
  it("aligns activity backfill starts to a UTC hour without extending the 90-day window", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-25T10:34:56.789Z"));
    try {
      const api = app();
      const { token, profileId } = await setup(api);
      await putSettings(api, token, profileId);

      const response = await api.request(`${HEALTH_API_PREFIX}/healthkit/sessions`, {
        method: "POST",
        headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
        body: JSON.stringify({
          installationId,
          personId: profileId,
          group: "activity",
          timezoneVersion: 1
        })
      });
      expect(response.status).toBe(201);
      const body = await response.json();
      expect(body.data.rangeStart).toBe("2026-04-26T11:00:00.000Z");
      expect(body.data.rangeEnd).toBe("2026-07-25T10:34:56.789Z");
      expect(body.data.status).toBe("open");
      expect(body.data.requiredScopeKeys).toEqual(requiredScopeKeysForGroup("activity"));
    } finally {
      vi.useRealTimers();
    }
  });

  it("applies, duplicates, and supersedes immutable events by entity version", async () => {
    const api = app();
    const { token, profileId } = await setup(api);
    await putSettings(api, token, profileId);

    const eventId = "11111111-1111-4111-8111-111111111111";
    const first = stepsEvent({
      eventId,
      entityVersion: 1,
      payload: { kind: "steps_hour", hourStartUtc: "2026-07-25T14:00:00.000Z", count: 100 }
    });

    const batch1 = await api.request(`${HEALTH_API_PREFIX}/healthkit/events:batch`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({
        installationId,
        personId: profileId,
        timezoneVersion: 1,
        events: [first]
      })
    });
    expect(batch1.status).toBe(200);
    expect((await batch1.json()).data.results[0].result).toBe("applied");

    const dup = await api.request(`${HEALTH_API_PREFIX}/healthkit/events:batch`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({
        installationId,
        personId: profileId,
        timezoneVersion: 1,
        events: [first]
      })
    });
    expect((await dup.json()).data.results[0].result).toBe("duplicate");

    const newer = stepsEvent({
      eventId: crypto.randomUUID(),
      entityVersion: 3,
      payload: { kind: "steps_hour", hourStartUtc: "2026-07-25T14:00:00.000Z", count: 300 }
    });
    const older = stepsEvent({
      eventId: crypto.randomUUID(),
      entityVersion: 2,
      payload: { kind: "steps_hour", hourStartUtc: "2026-07-25T14:00:00.000Z", count: 200 }
    });

    const ordered = await api.request(`${HEALTH_API_PREFIX}/healthkit/events:batch`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({
        installationId,
        personId: profileId,
        timezoneVersion: 1,
        events: [newer, older]
      })
    });
    const results = (await ordered.json()).data.results;
    expect(results[0].result).toBe("applied");
    expect(results[1].result).toBe("superseded");
  });

  it("returns event_conflict when event id is reused with different fingerprint", async () => {
    const api = app();
    const { token, profileId } = await setup(api);
    await putSettings(api, token, profileId);

    const eventId = crypto.randomUUID();
    const a = stepsEvent({
      eventId,
      payload: { kind: "steps_hour", hourStartUtc: "2026-07-25T14:00:00.000Z", count: 1 }
    });
    await api.request(`${HEALTH_API_PREFIX}/healthkit/events:batch`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({
        installationId,
        personId: profileId,
        timezoneVersion: 1,
        events: [a]
      })
    });

    const b = stepsEvent({
      eventId,
      payload: { kind: "steps_hour", hourStartUtc: "2026-07-25T14:00:00.000Z", count: 999 }
    });
    const conflict = await api.request(`${HEALTH_API_PREFIX}/healthkit/events:batch`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({
        installationId,
        personId: profileId,
        timezoneVersion: 1,
        events: [b]
      })
    });
    const body = await conflict.json();
    expect(body.data.results[0].result).toBe("event_conflict");
  });

  it("rejects inactive installation and stale timezone", async () => {
    const api = app();
    const { token, profileId } = await setup(api);
    await putSettings(api, token, profileId);

    const inactive = await api.request(`${HEALTH_API_PREFIX}/healthkit/events:batch`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({
        installationId: otherInstallationId,
        personId: profileId,
        timezoneVersion: 1,
        events: [stepsEvent()]
      })
    });
    expect(inactive.status).toBe(403);
    expect((await inactive.json()).error.code).toBe("installation_inactive");

    const stale = await api.request(`${HEALTH_API_PREFIX}/healthkit/events:batch`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({
        installationId,
        personId: profileId,
        timezoneVersion: 99,
        events: [stepsEvent()]
      })
    });
    expect(stale.status).toBe(409);
    expect((await stale.json()).error.code).toBe("timezone_stale");
  });

  it("completes a backfill session only after all scope manifests validate", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-25T12:00:00.000Z"));
    try {
      const api = app();
      const { token, profileId } = await setup(api);
      await putSettings(api, token, profileId, { enabledGroups: ["activity"] });

      const sessionRes = await api.request(`${HEALTH_API_PREFIX}/healthkit/sessions`, {
        method: "POST",
        headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
        body: JSON.stringify({
          installationId,
          personId: profileId,
          group: "activity",
          timezoneVersion: 1
        })
      });
      const session = (await sessionRes.json()).data;
      const sessionId = session.sessionId as string;
      const scopes = session.requiredScopeKeys as string[];

      // Upload empty manifests for every activity scope (no data is valid).
      for (const scopeKey of scopes) {
        const eventIds: string[] = [];
        const manifestHash = fingerprintScopeManifest({ sessionId, scopeKey, eventIds }, nodeSha256);
        const put = await api.request(
          `${HEALTH_API_PREFIX}/healthkit/sessions/${sessionId}/scopes/${scopeKey}/manifest`,
          {
            method: "PUT",
            headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
            body: JSON.stringify({
              installationId,
              personId: profileId,
              timezoneVersion: 1,
              eventCount: 0,
              manifestHash
            })
          }
        );
        expect(put.status).toBe(200);
      }

      const complete = await api.request(`${HEALTH_API_PREFIX}/healthkit/sessions/${sessionId}/complete`, {
        method: "POST",
        headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
        body: JSON.stringify({
          installationId,
          personId: profileId,
          timezoneVersion: 1
        })
      });
      expect(complete.status).toBe(200);
      expect((await complete.json()).data.completed).toBe(true);

      const settings = await (
        await api.request(`${HEALTH_API_PREFIX}/healthkit/settings?personId=${profileId}`, {
          headers: { authorization: `Bearer ${token}` }
        })
      ).json();
      const activity = settings.data.groups.find((g: { group: string }) => g.group === "activity");
      expect(activity.status).toBe("ready");
    } finally {
      vi.useRealTimers();
    }
  });

  it("rejects sleep stage incoherence as payload_invalid", async () => {
    const api = app();
    const { token, profileId } = await setup(api);
    await putSettings(api, token, profileId);

    const event: HealthKitSyncEvent = {
      eventId: crypto.randomUUID(),
      entityKey: "sleep_day:2026-07-24",
      entityVersion: 1,
      group: "sleep",
      scopeKey: "sleep",
      op: "upsert",
      payload: {
        kind: "sleep_day",
        sleepDay: "2026-07-24",
        totalMinutes: 400,
        coreMinutes: 100,
        deepMinutes: 100,
        remMinutes: 100,
        unspecifiedAsleepMinutes: 50,
        awakeMinutes: 10,
        inBedMinutes: 420
      }
    };

    const res = await api.request(`${HEALTH_API_PREFIX}/healthkit/events:batch`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({
        installationId,
        personId: profileId,
        timezoneVersion: 1,
        events: [event]
      })
    });
    const body = await res.json();
    expect(body.data.results[0].result).toBe("payload_invalid");
  });

  it("server fingerprint matches shared serializer", () => {
    const event = stepsEvent({
      eventId: "11111111-1111-4111-8111-111111111111",
      entityKey: "steps_hour:2026-07-25T14:00:00.000Z",
      entityVersion: 1,
      payload: {
        kind: "steps_hour",
        hourStartUtc: "2026-07-25T14:00:00.000Z",
        count: 1200
      }
    });
    expect(fingerprintHealthEvent(event, nodeSha256)).toBe(HEALTHKIT_FROZEN_FINGERPRINTS.stepsHourUpsert);
  });
});
