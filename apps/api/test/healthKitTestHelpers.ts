import { createHash } from "node:crypto";
import {
  fingerprintScopeManifest,
  requiredScopeKeysForGroup,
  type HealthKitConsentGroup,
  type HealthKitSyncEvent
} from "@family-os/shared";
import { HEALTH_API_PREFIX } from "@family-os/shared";

function nodeSha256(data: Uint8Array): Uint8Array {
  return createHash("sha256").update(data).digest();
}

type Api = {
  request: (input: string, init?: RequestInit) => Response | Promise<Response>;
};

export async function seedHealthKitReadyGroup(
  api: Api,
  token: string,
  profileId: string,
  installationId: string,
  group: HealthKitConsentGroup,
  events: HealthKitSyncEvent[],
  timezoneVersion = 1
) {
  const sessionRes = await api.request(`${HEALTH_API_PREFIX}/healthkit/sessions`, {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify({
      installationId,
      personId: profileId,
      group,
      timezoneVersion
    })
  });
  if (!sessionRes.ok) {
    throw new Error(`create session failed: ${sessionRes.status} ${await sessionRes.text()}`);
  }
  const session = (await sessionRes.json()).data;
  const sessionId = session.sessionId as string;

  const tagged = events.map((event) => ({ ...event, sessionId }));
  if (tagged.length > 0) {
    const batch = await api.request(`${HEALTH_API_PREFIX}/healthkit/events:batch`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({
        installationId,
        personId: profileId,
        timezoneVersion,
        events: tagged
      })
    });
    if (!batch.ok) {
      throw new Error(`events batch failed: ${batch.status} ${await batch.text()}`);
    }
  }

  const scopes = (session.requiredScopeKeys as string[]) ?? requiredScopeKeysForGroup(group);
  for (const scopeKey of scopes) {
    const eventIds = tagged.filter((e) => e.scopeKey === scopeKey).map((e) => e.eventId);
    const manifestHash = fingerprintScopeManifest({ sessionId, scopeKey, eventIds }, nodeSha256);
    const put = await api.request(
      `${HEALTH_API_PREFIX}/healthkit/sessions/${sessionId}/scopes/${scopeKey}/manifest`,
      {
        method: "PUT",
        headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
        body: JSON.stringify({
          installationId,
          personId: profileId,
          timezoneVersion,
          eventCount: eventIds.length,
          manifestHash
        })
      }
    );
    if (!put.ok) {
      throw new Error(`manifest failed for ${scopeKey}: ${put.status} ${await put.text()}`);
    }
  }

  const complete = await api.request(`${HEALTH_API_PREFIX}/healthkit/sessions/${sessionId}/complete`, {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify({
      installationId,
      personId: profileId,
      timezoneVersion
    })
  });
  if (!complete.ok) {
    throw new Error(`complete session failed: ${complete.status} ${await complete.text()}`);
  }
  return sessionId;
}

export function stepsHourEvent(
  hourStartUtc: string,
  count: number,
  entityVersion = 1
): HealthKitSyncEvent {
  return {
    eventId: crypto.randomUUID(),
    entityKey: `steps_hour:${hourStartUtc}`,
    entityVersion,
    group: "activity",
    scopeKey: "steps",
    op: "upsert",
    payload: { kind: "steps_hour", hourStartUtc, count }
  };
}

export function sleepDayEvent(
  sleepDay: string,
  overrides: Partial<{
    totalMinutes: number;
    coreMinutes: number;
    deepMinutes: number;
    remMinutes: number;
    unspecifiedAsleepMinutes: number;
    awakeMinutes: number;
    inBedMinutes: number;
  }> = {}
): HealthKitSyncEvent {
  const totalMinutes = overrides.totalMinutes ?? 480;
  const coreMinutes = overrides.coreMinutes ?? 240;
  const deepMinutes = overrides.deepMinutes ?? 90;
  const remMinutes = overrides.remMinutes ?? 90;
  const unspecifiedAsleepMinutes = overrides.unspecifiedAsleepMinutes ?? 60;
  return {
    eventId: crypto.randomUUID(),
    entityKey: `sleep_day:${sleepDay}`,
    entityVersion: 1,
    group: "sleep",
    scopeKey: "sleep",
    op: "upsert",
    payload: {
      kind: "sleep_day",
      sleepDay,
      totalMinutes,
      coreMinutes,
      deepMinutes,
      remMinutes,
      unspecifiedAsleepMinutes,
      awakeMinutes: overrides.awakeMinutes ?? 0,
      inBedMinutes: overrides.inBedMinutes ?? totalMinutes
    }
  };
}

export function bloodPressureEvent(input: {
  sourceObjectKey: string;
  measuredAtUtc: string;
  systolic: number;
  diastolic: number;
  pulse?: number;
}): HealthKitSyncEvent {
  return {
    eventId: crypto.randomUUID(),
    entityKey: `blood_pressure:${input.sourceObjectKey}`,
    entityVersion: 1,
    group: "vitals",
    scopeKey: "blood_pressure",
    op: "upsert",
    payload: {
      kind: "blood_pressure",
      sourceObjectKey: input.sourceObjectKey,
      measuredAtUtc: input.measuredAtUtc,
      systolic: input.systolic,
      diastolic: input.diastolic,
      pulse: input.pulse
    }
  };
}
