import {
  HEALTH_API_PREFIX,
  bloodPressureNaturalKey,
  type HealthKitConsentGroup,
  type HealthKitRunBeginResult,
  type HealthKitRunKind,
  type HealthKitSyncOp
} from "@family-os/shared";

type Api = {
  request: (input: string, init?: RequestInit) => Response | Promise<Response>;
};

export async function beginRun(
  api: Api,
  token: string,
  profileId: string,
  installationId: string,
  group: HealthKitConsentGroup,
  kind: HealthKitRunKind,
  timezoneVersion = 1
) {
  return api.request(`${HEALTH_API_PREFIX}/healthkit/groups/${group}/runs/begin`, {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify({ installationId, personId: profileId, timezoneVersion, kind })
  });
}

export async function completeRun(
  api: Api,
  token: string,
  profileId: string,
  installationId: string,
  group: HealthKitConsentGroup,
  body: Record<string, unknown>,
  timezoneVersion = 1
) {
  return api.request(`${HEALTH_API_PREFIX}/healthkit/groups/${group}/runs/complete`, {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify({ installationId, personId: profileId, timezoneVersion, ...body })
  });
}


export async function postOps(
  api: Api,
  token: string,
  profileId: string,
  installationId: string,
  ops: HealthKitSyncOp[],
  timezoneVersion = 1
) {
  return api.request(`${HEALTH_API_PREFIX}/healthkit/ops:batch`, {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify({ installationId, personId: profileId, timezoneVersion, ops })
  });
}

/** Runs a full initial import through the generic run contract and ends ready. */
export async function seedHealthKitReadyGroup(
  api: Api,
  token: string,
  profileId: string,
  installationId: string,
  group: HealthKitConsentGroup,
  ops: HealthKitSyncOp[],
  timezoneVersion = 1
) {
  const begin = await beginRun(api, token, profileId, installationId, group, "initial_import", timezoneVersion);
  if (!begin.ok) {
    throw new Error(`runs/begin failed: ${begin.status} ${await begin.text()}`);
  }
  const descriptor = (await begin.json()).data as HealthKitRunBeginResult;

  if (ops.length > 0) {
    const batch = await postOps(api, token, profileId, installationId, ops, timezoneVersion);
    if (!batch.ok) {
      throw new Error(`ops batch failed: ${batch.status} ${await batch.text()}`);
    }
  }

  const complete = await completeRun(
    api,
    token,
    profileId,
    installationId,
    group,
    {
      kind: "initial_import",
      rangeStartAt: descriptor.rangeStartAt,
      rangeEndAt: descriptor.rangeEndAt
    },
    timezoneVersion
  );
  if (!complete.ok) {
    throw new Error(`runs/complete failed: ${complete.status} ${await complete.text()}`);
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

export function workoutOp(input: {
  sourceSampleKey?: string;
  workoutType?: string;
  startedAtUtc: string;
  endedAtUtc: string;
  durationSeconds: number;
  activeEnergyKcal?: number;
  distanceMeters?: number;
}): HealthKitSyncOp {
  const sourceSampleKey = input.sourceSampleKey ?? crypto.randomUUID();
  return {
    opId: crypto.randomUUID(),
    naturalKey: `workout:${sourceSampleKey}`,
    group: "workouts",
    scopeKey: "workout",
    op: "upsert",
    payload: {
      kind: "workout",
      sourceSampleKey,
      workoutType: input.workoutType ?? "running",
      startedAtUtc: input.startedAtUtc,
      endedAtUtc: input.endedAtUtc,
      durationSeconds: input.durationSeconds,
      activeEnergyKcal: input.activeEnergyKcal,
      distanceMeters: input.distanceMeters
    }
  };
}

/** @deprecated Use stepsHourOp. */
export const stepsHourEvent = stepsHourOp;
/** @deprecated Use sleepDayOp. */
export const sleepDayEvent = sleepDayOp;

/** @deprecated Use bloodPressureOp. */
export const bloodPressureEvent = bloodPressureOp;
