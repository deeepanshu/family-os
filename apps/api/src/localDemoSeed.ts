import { createHash } from "node:crypto";
import {
  bloodGlucoseNaturalKey,
  bloodPressureNaturalKey,
  type HealthKitConsentGroup,
  type HealthKitSyncOp
} from "@family-os/shared";
import type { AppRepositories } from "./repositories/contracts";

export const LOCAL_DEMO_USER_ID = "00000000-0000-4000-8000-000000000001";
export const LOCAL_DEMO_MEMBER_USER_ID = "00000000-0000-4000-8000-000000000002";
export const LOCAL_DEMO_INSTALLATION_ID = "00000000-0000-4000-8000-000000005eed";
export const LOCAL_DEMO_MEMBER_INSTALLATION_ID = "00000000-0000-4000-8000-000000005ee2";
export const LOCAL_DEMO_TIMEZONE = "UTC";
export const LOCAL_DEMO_FAMILY_NAME = "Demo Family";
export const LOCAL_DEMO_MEMBER_NAME = "Jamie";
export const LOCAL_DEMO_DAY_COUNT = 14;

const ENABLED_GROUPS = ["activity", "sleep", "vitals", "workouts"] as const satisfies readonly HealthKitConsentGroup[];


const STRENGTH_START_HOUR = 18;
const RUN_START_HOUR = 7;
const WALK_START_HOUR = 17;

export type LocalDemoSeedStores = Pick<AppRepositories, "families" | "profiles" | "healthKit" | "invites">;

export type LocalDemoSeedOptions = {
  userId?: string;
  asOf?: Date;
  displayName?: string;
};

export type LocalDemoSeedResult = {
  userId: string;
  profileId: string;
  profileName: string;
  memberProfileId: string | null;
  memberProfileName: string | null;
  familyId: string;
  familyName: string;
  asOf: string;
};

export async function seedLocalDemo(
  stores: LocalDemoSeedStores,
  options: LocalDemoSeedOptions = {}
): Promise<LocalDemoSeedResult> {
  const userId = options.userId ?? LOCAL_DEMO_USER_ID;
  const asOf = options.asOf ?? new Date();
  const displayName = options.displayName ?? "Alex";

  await stores.families.bootstrap(userId);
  const profile = await stores.profiles.createSelfProfile(userId, displayName);

  let family = await stores.families.getCurrentFamily(userId);
  if (!family) {
    family = await stores.families.createFamily({ userId, name: LOCAL_DEMO_FAMILY_NAME });
  }
  if (!family) {
    throw new Error("Local demo seed failed to create or load a household.");
  }

  const member = await ensureDemoMember(stores, userId);

  const existingSettings = await stores.healthKit.getHealthKitSettings(userId, profile.id);
  const installationId = existingSettings.activeInstallationId ?? LOCAL_DEMO_INSTALLATION_ID;
  const settings = await stores.healthKit.putHealthKitSettings(userId, {
    personId: profile.id,
    consentVersion: "local-demo-2026-08-23",
    enabledGroups: [...ENABLED_GROUPS],
    healthTimezone: LOCAL_DEMO_TIMEZONE,
    installationId
  });

  const days = utcDaysEndingOn(asOf, LOCAL_DEMO_DAY_COUNT);
  const firstDay = days[0];
  const lastDay = days[days.length - 1];
  if (!firstDay || !lastDay) {
    throw new Error("Demo seed window is empty.");
  }

  const opsByGroup = buildDemoOps(userId, days, lastDay);
  for (const group of ENABLED_GROUPS) {
    await applyOps(stores, {
      userId,
      profileId: profile.id,
      installationId,
      timezoneVersion: settings.healthTimezoneVersion,
      group,
      ops: opsByGroup[group]
    });
  }

  const workouts = await stores.healthKit.listHealthKitWorkouts(
    userId,
    profile.id,
    `${firstDay}T00:00:00.000Z`,
    `${lastDay}T23:59:59.999Z`,
    50
  );
  const strength = workouts.find(
    (workout) =>
      workout.workoutType === "traditional_strength_training" &&
      workout.startedAtUtc.startsWith(`${lastDay}T${String(STRENGTH_START_HOUR).padStart(2, "0")}:00`)
  );
  if (!strength) {
    throw new Error("Demo seed did not find the strength workout after applying ops.");
  }
  await stores.healthKit.putHealthKitWorkoutExercises(userId, strength.id, [
    {
      name: "Bench Press",
      sets: [
        { reps: 8, weightKg: 60 },
        { reps: 8, weightKg: 60 },
        { reps: 6, weightKg: 65 }
      ]
    },
    {
      name: "Arnold Press",
      sets: [
        { reps: 10, weightKg: 14 },
        { reps: 10, weightKg: 14 },
        { reps: 8, weightKg: 16 }
      ]
    }
  ]);

  for (const group of ENABLED_GROUPS) {
    await stores.healthKit.markHealthKitGroupReady(userId, group, {
      installationId,
      personId: profile.id,
      timezoneVersion: settings.healthTimezoneVersion,
      coverageStartAt: `${firstDay}T00:00:00.000Z`,
      coverageEndAt: asOf.toISOString()
    });
  }

  if (member) {
    await seedVitalsOnly(stores, {
      userId: member.userId,
      profileId: member.profileId,
      fallbackInstallationId: LOCAL_DEMO_MEMBER_INSTALLATION_ID,
      days,
      asOf
    });
  }

  return {
    userId,
    profileId: profile.id,
    profileName: profile.displayName,
    memberProfileId: member?.profileId ?? null,
    memberProfileName: member?.displayName ?? null,
    familyId: family.family.id,
    familyName: family.family.name,
    asOf: lastDay
  };
}

async function ensureDemoMember(
  stores: LocalDemoSeedStores,
  creatorUserId: string
): Promise<{ userId: string; profileId: string; displayName: string } | null> {
  const current = await stores.families.getCurrentFamily(creatorUserId);
  if (!current || current.family.createdByUserId !== creatorUserId) {
    return null;
  }

  const members = await stores.families.listMembers(creatorUserId);
  const alreadyJoined = members.some((member) => member.membership.userId === LOCAL_DEMO_MEMBER_USER_ID);
  await stores.families.bootstrap(LOCAL_DEMO_MEMBER_USER_ID);
  const memberProfile = await stores.profiles.createSelfProfile(LOCAL_DEMO_MEMBER_USER_ID, LOCAL_DEMO_MEMBER_NAME);

  if (!alreadyJoined) {
    const invite = await stores.invites.createInvite({ actorUserId: creatorUserId });
    await stores.invites.acceptInvite(invite.token, LOCAL_DEMO_MEMBER_USER_ID, { relationshipLabel: "Brother" });
  }

  return { userId: LOCAL_DEMO_MEMBER_USER_ID, profileId: memberProfile.id, displayName: memberProfile.displayName };
}

async function seedVitalsOnly(
  stores: LocalDemoSeedStores,
  input: {
    userId: string;
    profileId: string;
    fallbackInstallationId: string;
    days: string[];
    asOf: Date;
  }
): Promise<void> {
  const existing = await stores.healthKit.getHealthKitSettings(input.userId, input.profileId);
  const installationId = existing.activeInstallationId ?? input.fallbackInstallationId;
  const settings = await stores.healthKit.putHealthKitSettings(input.userId, {
    personId: input.profileId,
    consentVersion: "local-demo-2026-08-23",
    enabledGroups: ["vitals"],
    healthTimezone: LOCAL_DEMO_TIMEZONE,
    installationId
  });
  const firstDay = input.days[0];
  if (!firstDay) return;
  await applyOps(stores, {
    userId: input.userId,
    profileId: input.profileId,
    installationId,
    timezoneVersion: settings.healthTimezoneVersion,
    group: "vitals",
    ops: buildMemberVitalsOps(input.userId, input.days)
  });
  await stores.healthKit.markHealthKitGroupReady(input.userId, "vitals", {
    installationId,
    personId: input.profileId,
    timezoneVersion: settings.healthTimezoneVersion,
    coverageStartAt: `${firstDay}T00:00:00.000Z`,
    coverageEndAt: input.asOf.toISOString()
  });
}

async function applyOps(
  stores: LocalDemoSeedStores,
  input: {
    userId: string;
    profileId: string;
    installationId: string;
    timezoneVersion: number;
    group: HealthKitConsentGroup;
    ops: HealthKitSyncOp[];
  }
): Promise<void> {
  if (input.ops.length === 0) return;
  const batch = await stores.healthKit.applyHealthKitOps(input.userId, {
    installationId: input.installationId,
    personId: input.profileId,
    timezoneVersion: input.timezoneVersion,
    ops: input.ops
  });
  const rejected = batch.results.filter((result) => result.result === "rejected");
  if (rejected.length > 0) {
    const first = rejected[0];
    throw new Error(
      `Demo seed rejected ${rejected.length} ${input.group} op(s): ${first?.errorCode ?? "unknown"} ${first?.errorMessage ?? ""}`.trim()
    );
  }
}

function buildMemberVitalsOps(userId: string, days: string[]): HealthKitSyncOp[] {
  const ops: HealthKitSyncOp[] = [];
  for (const [index, day] of days.entries()) {
    if (index % 2 !== 0) continue;
    const sourceObjectKey = uuidHash(`local-demo-source:${userId}:bp:${day}`);
    ops.push(
      upsertOp(userId, {
        naturalKey: bloodPressureNaturalKey(sourceObjectKey),
        group: "vitals",
        scopeKey: "blood_pressure",
        payload: {
          kind: "blood_pressure",
          sourceObjectKey,
          measuredAtUtc: `${day}T08:40:00.000Z`,
          systolic: 134 + (index % 4) * 2,
          diastolic: 84 + (index % 3),
          pulse: 72 + (index % 5)
        }
      })
    );
  }
  return ops;
}

function buildDemoOps(
  userId: string,
  days: string[],
  lastDay: string
): Record<(typeof ENABLED_GROUPS)[number], HealthKitSyncOp[]> {
  const activity: HealthKitSyncOp[] = [];
  const sleep: HealthKitSyncOp[] = [];
  const vitals: HealthKitSyncOp[] = [];
  const workouts: HealthKitSyncOp[] = [];

  for (const [index, day] of days.entries()) {
    for (const hour of [8, 9, 10, 11, 12, 13, 14, 15]) {
      const hourStartUtc = utcHour(day, hour);
      activity.push(
        upsertOp(userId, {
          naturalKey: `steps_hour:${hourStartUtc}`,
          group: "activity",
          scopeKey: "steps",
          payload: {
            kind: "steps_hour",
            hourStartUtc,
            count: 420 + ((index * 17 + hour * 11) % 380)
          }
        })
      );
    }

    const coreMinutes = 220;
    const deepMinutes = 90;
    const remMinutes = 80 + (index % 3) * 10;
    const unspecifiedAsleepMinutes = 60;
    const totalMinutes = coreMinutes + deepMinutes + remMinutes + unspecifiedAsleepMinutes;
    sleep.push(
      upsertOp(userId, {
        naturalKey: `sleep_day:${day}`,
        group: "sleep",
        scopeKey: "sleep",
        payload: {
          kind: "sleep_day",
          sleepDay: day,
          totalMinutes,
          coreMinutes,
          deepMinutes,
          remMinutes,
          unspecifiedAsleepMinutes,
          awakeMinutes: 12,
          inBedMinutes: totalMinutes + 20
        }
      })
    );

    if (index % 2 === 0 || day === lastDay) {
      const sourceObjectKey = uuidHash(`local-demo-source:${userId}:bp:${day}`);
      vitals.push(
        upsertOp(userId, {
          naturalKey: bloodPressureNaturalKey(sourceObjectKey),
          group: "vitals",
          scopeKey: "blood_pressure",
          payload: {
            kind: "blood_pressure",
            sourceObjectKey,
            measuredAtUtc: `${day}T07:15:00.000Z`,
            systolic: 116 + (index % 5) * 3,
            diastolic: 74 + (index % 4) * 2,
            pulse: 62 + (index % 6)
          }
        })
      );
    }
  }

  const glucoseDays = [days[days.length - 1], days[days.length - 2], days[days.length - 4]].filter(
    (day): day is string => Boolean(day)
  );
  if (glucoseDays[0]) {
    vitals.push(
      glucoseOp(userId, "glu-pre", glucoseDays[0], "07:05:00.000Z", 104, "preprandial"),
      glucoseOp(userId, "glu-post", glucoseDays[0], "13:40:00.000Z", 132, "postprandial")
    );
  }
  if (glucoseDays[1]) {
    vitals.push(glucoseOp(userId, "glu-plain", glucoseDays[1], "09:18:00.000Z", 98));
  }
  if (glucoseDays[2]) {
    vitals.push(glucoseOp(userId, "glu-plain-2", glucoseDays[2], "21:10:00.000Z", 110));
  }

  const twoAgo = days[days.length - 3];
  const fiveAgo = days[days.length - 6];
  workouts.push(
    workoutOp(userId, "wk-strength", "traditional_strength_training", lastDay, STRENGTH_START_HOUR, 40 * 60, 280)
  );
  if (twoAgo) {
    workouts.push(workoutOp(userId, "wk-run", "running", twoAgo, RUN_START_HOUR, 32 * 60, 310, 5400));
  }
  if (fiveAgo) {
    workouts.push(workoutOp(userId, "wk-walk", "walking", fiveAgo, WALK_START_HOUR, 45 * 60, 180, 3200));
  }

  return { activity, sleep, vitals, workouts };
}

function glucoseOp(
  userId: string,
  tag: string,
  day: string,
  time: string,
  valueMgDl: number,
  mealTime?: "preprandial" | "postprandial"
): HealthKitSyncOp {
  const sourceSampleKey = uuidHash(`local-demo-source:${userId}:${tag}`);
  return upsertOp(userId, {
    naturalKey: bloodGlucoseNaturalKey(sourceSampleKey),
    group: "vitals",
    scopeKey: "blood_glucose",
    payload: {
      kind: "blood_glucose",
      sourceSampleKey,
      measuredAtUtc: `${day}T${time}`,
      valueMgDl,
      ...(mealTime ? { mealTime } : {})
    }
  });
}

function workoutOp(
  userId: string,
  tag: string,
  workoutType: string,
  day: string,
  startHour: number,
  durationSeconds: number,
  activeEnergyKcal: number,
  distanceMeters?: number
): HealthKitSyncOp {
  const sourceSampleKey = uuidHash(`local-demo-source:${userId}:${tag}`);
  const startedAtUtc = utcHour(day, startHour);
  const endedAtUtc = new Date(Date.parse(startedAtUtc) + durationSeconds * 1000).toISOString();
  return upsertOp(userId, {
    naturalKey: `workout:${sourceSampleKey}`,
    group: "workouts",
    scopeKey: "workout",
    payload: {
      kind: "workout",
      sourceSampleKey,
      workoutType,
      startedAtUtc,
      endedAtUtc,
      durationSeconds,
      activeEnergyKcal,
      distanceMeters,
      isIndoor: workoutType === "traditional_strength_training"
    }
  });
}

function upsertOp(userId: string, input: Omit<HealthKitSyncOp, "opId" | "op">): HealthKitSyncOp {
  return {
    opId: uuidHash(`local-demo:${userId}:${input.naturalKey}`),
    naturalKey: input.naturalKey,
    group: input.group,
    scopeKey: input.scopeKey,
    op: "upsert",
    payload: input.payload
  };
}

function utcDaysEndingOn(asOf: Date, count: number): string[] {
  const end = Date.UTC(asOf.getUTCFullYear(), asOf.getUTCMonth(), asOf.getUTCDate());
  const days: string[] = [];
  for (let offset = count - 1; offset >= 0; offset -= 1) {
    days.push(new Date(end - offset * 86_400_000).toISOString().slice(0, 10));
  }
  return days;
}

function utcHour(day: string, hour: number): string {
  return `${day}T${String(hour).padStart(2, "0")}:00:00.000Z`;
}

function uuidHash(input: string): string {
  const hex = createHash("sha256").update(input).digest("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-8${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}
