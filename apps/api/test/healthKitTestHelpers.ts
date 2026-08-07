import { HEALTH_API_PREFIX, bloodPressureNaturalKey, type HealthKitConsentGroup, type HealthKitSyncOp } from "@family-os/shared";

type Api = {
  request: (input: string, init?: RequestInit) => Response | Promise<Response>;
};

export async function seedHealthKitReadyGroup(
  api: Api,
  token: string,
  profileId: string,
  installationId: string,
  group: HealthKitConsentGroup,
  ops: HealthKitSyncOp[],
  timezoneVersion = 1
) {
  const start = await api.request(`${HEALTH_API_PREFIX}/healthkit/groups/${group}/start-import`, {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify({
      installationId,
      personId: profileId,
      timezoneVersion
    })
  });
  if (!start.ok) {
    throw new Error(`start-import failed: ${start.status} ${await start.text()}`);
  }

  if (ops.length > 0) {
    const batch = await api.request(`${HEALTH_API_PREFIX}/healthkit/ops:batch`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({
        installationId,
        personId: profileId,
        timezoneVersion,
        ops
      })
    });
    if (!batch.ok) {
      throw new Error(`ops batch failed: ${batch.status} ${await batch.text()}`);
    }
  }

  const ready = await api.request(`${HEALTH_API_PREFIX}/healthkit/groups/${group}/ready`, {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify({
      installationId,
      personId: profileId,
      timezoneVersion
    })
  });
  if (!ready.ok) {
    throw new Error(`ready failed: ${ready.status} ${await ready.text()}`);
  }
}

export function stepsHourOp(hourStartUtc: string, count: number): HealthKitSyncOp {
  return {
    opId: crypto.randomUUID(),
    naturalKey: `steps_hour:${hourStartUtc}`,
    group: "activity",
    scopeKey: "steps",
    op: "upsert",
    payload: { kind: "steps_hour", hourStartUtc, count }
  };
}

export function sleepDayOp(
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
): HealthKitSyncOp {
  const totalMinutes = overrides.totalMinutes ?? 480;
  const coreMinutes = overrides.coreMinutes ?? 240;
  const deepMinutes = overrides.deepMinutes ?? 90;
  const remMinutes = overrides.remMinutes ?? 90;
  const unspecifiedAsleepMinutes = overrides.unspecifiedAsleepMinutes ?? 60;
  return {
    opId: crypto.randomUUID(),
    naturalKey: `sleep_day:${sleepDay}`,
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

export function bloodPressureOp(input: {
  sourceObjectKey?: string;
  measuredAtUtc: string;
  systolic: number;
  diastolic: number;
  pulse?: number;
}): HealthKitSyncOp {
  const sourceObjectKey = input.sourceObjectKey ?? crypto.randomUUID();
  return {
    opId: crypto.randomUUID(),
    naturalKey: bloodPressureNaturalKey(sourceObjectKey),
    group: "vitals",
    scopeKey: "blood_pressure",
    op: "upsert",
    payload: {
      kind: "blood_pressure",
      sourceObjectKey,
      measuredAtUtc: input.measuredAtUtc,
      systolic: input.systolic,
      diastolic: input.diastolic,
      pulse: input.pulse
    }
  };
}

export function bloodPressureDeleteOp(sourceObjectKey: string): HealthKitSyncOp {
  return {
    opId: crypto.randomUUID(),
    naturalKey: bloodPressureNaturalKey(sourceObjectKey),
    group: "vitals",
    scopeKey: "blood_pressure",
    op: "delete",
    payload: null
  };
}

/** @deprecated Use stepsHourOp. */
export const stepsHourEvent = stepsHourOp;
/** @deprecated Use sleepDayOp. */
export const sleepDayEvent = sleepDayOp;

/** @deprecated Use bloodPressureOp. */
export const bloodPressureEvent = bloodPressureOp;
