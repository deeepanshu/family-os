import { zValidator } from "@hono/zod-validator";
import { Hono } from "hono";
import { z } from "zod";
import {
  HEALTHKIT_CONSENT_GROUPS,
  HEALTHKIT_OPS_BATCH_MAX,
  HEALTHKIT_RUN_KINDS,
  isHealthKitMetricKey
} from "@family-os/shared";
import type { HealthKitOpsBatchInput } from "@family-os/shared";
import { requireAuth, type AppVariables } from "../auth";
import { HttpError } from "../errors";
import { isValidIanaTimezone } from "../repositories/healthKitDomain";
import type { HealthKitStore } from "../repositories/contracts";

const group = z.enum(HEALTHKIT_CONSENT_GROUPS);
const uuid = z.string().uuid();
const isoInstant = z.string().datetime({ offset: true });
const ymd = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);

const stepsHourPayload = z
  .object({
    kind: z.literal("steps_hour"),
    hourStartUtc: isoInstant,
    count: z.number().int().min(0).max(200_000)
  })
  .strict();

const sleepDayPayload = z
  .object({
    kind: z.literal("sleep_day"),
    sleepDay: ymd,
    totalMinutes: z.number().int().min(0).max(24 * 60),
    coreMinutes: z.number().int().min(0).max(7 * 24 * 60),
    deepMinutes: z.number().int().min(0).max(7 * 24 * 60),
    remMinutes: z.number().int().min(0).max(7 * 24 * 60),
    unspecifiedAsleepMinutes: z.number().int().min(0).max(7 * 24 * 60),
    awakeMinutes: z.number().int().min(0).max(7 * 24 * 60),
    inBedMinutes: z.number().int().min(0).max(7 * 24 * 60),
    wristTemperatureCelsius: z.number().min(25).max(45).optional(),
    breathingDisturbanceCount: z.number().int().min(0).max(10_000).optional()
  })
  .strict();

const dailyMetricPayload = z
  .object({
    kind: z.literal("daily_metric"),
    healthMetric: z.string().min(1).max(80),
    localDay: ymd,
    sumValue: z.number().finite().optional(),
    averageValue: z.number().finite().optional(),
    minimumValue: z.number().finite().optional(),
    maximumValue: z.number().finite().optional(),
    latestValue: z.number().finite().optional(),
    sampleCount: z.number().int().min(0).max(1_000_000)
  })
  .strict();

const bloodPressurePayload = z
  .object({
    kind: z.literal("blood_pressure"),
    sourceObjectKey: uuid,
    measuredAtUtc: isoInstant,
    systolic: z.number().int().min(50).max(260),
    diastolic: z.number().int().min(30).max(180),
    pulse: z.number().int().min(30).max(220).optional()
  })
  .strict();

const bloodGlucosePayload = z
  .object({
    kind: z.literal("blood_glucose"),
    sourceSampleKey: uuid,
    measuredAtUtc: isoInstant,
    valueMgDl: z.number().min(20).max(700)
  })
  .strict();

const workoutEvent = z
  .object({
    type: z.string().trim().min(1).max(64),
    dateUtc: isoInstant,
    endDateUtc: isoInstant.optional()
  })
  .strict();

const workoutActivitySegment = z
  .object({
    workoutType: z.string().trim().min(1).max(100),
    startedAtUtc: isoInstant,
    endedAtUtc: isoInstant,
    durationSeconds: z.number().int().min(0).max(7 * 24 * 60 * 60)
  })
  .strict();

const workoutPayload = z
  .object({
    kind: z.literal("workout"),
    sourceSampleKey: uuid,
    workoutType: z.string().trim().min(1).max(100),
    startedAtUtc: isoInstant,
    endedAtUtc: isoInstant,
    durationSeconds: z.number().int().min(0).max(7 * 24 * 60 * 60),
    activeEnergyKcal: z.number().min(0).max(100_000).optional(),
    distanceMeters: z.number().min(0).max(10_000_000).optional(),
    averageHeartRateBpm: z.number().min(0).max(300).optional(),
    maximumHeartRateBpm: z.number().min(0).max(300).optional(),
    minimumHeartRateBpm: z.number().min(0).max(300).optional(),
    sourceName: z.string().trim().min(1).max(200).optional(),
    sourceBundleId: z.string().trim().min(1).max(200).optional(),
    deviceName: z.string().trim().min(1).max(200).optional(),
    deviceManufacturer: z.string().trim().min(1).max(200).optional(),
    isIndoor: z.boolean().optional(),
    elevationAscendedMeters: z.number().min(0).max(100_000).optional(),
    averageMETs: z.number().min(0).max(100).optional(),
    swimmingStrokeCount: z.number().int().min(0).max(1_000_000).optional(),
    totalFlightsClimbed: z.number().int().min(0).max(100_000).optional(),
    events: z.array(workoutEvent).max(500).optional(),
    activities: z.array(workoutActivitySegment).max(100).optional()
  })
  .strict();

const opPayload = z.discriminatedUnion("kind", [
  stepsHourPayload,
  sleepDayPayload,
  dailyMetricPayload,
  bloodPressurePayload,
  bloodGlucosePayload,
  workoutPayload
]);

const syncOp = z
  .object({
    opId: uuid,
    naturalKey: z.string().min(1).max(256),
    group,
    scopeKey: z.string().min(1).max(80),
    op: z.enum(["upsert", "delete"]),
    payload: opPayload.nullable().optional()
  })
  .strict();

const settingsBody = z
  .object({
    personId: uuid,
    consentVersion: z.string().trim().min(1).max(64).optional(),
    enabledGroups: z.array(group).max(HEALTHKIT_CONSENT_GROUPS.length),
    healthTimezone: z.string().trim().min(1).max(64),
    installationId: uuid,
    replaceActiveInstallation: z.boolean().optional()
  })
  .strict();

const opsBatchBody = z
  .object({
    installationId: uuid,
    personId: uuid,
    timezoneVersion: z.number().int().min(1),
    ops: z.array(syncOp).min(1).max(HEALTHKIT_OPS_BATCH_MAX)
  })
  .strict();

const groupActionBody = z
  .object({
    installationId: uuid,
    personId: uuid,
    timezoneVersion: z.number().int().min(1),
    coverageStartAt: isoInstant.optional(),
    coverageEndAt: isoInstant.optional()
  })
  .strict();

const runKind = z.enum(HEALTHKIT_RUN_KINDS);

const runBeginBody = z
  .object({
    installationId: uuid,
    personId: uuid,
    timezoneVersion: z.number().int().min(1),
    kind: runKind
  })
  .strict();

const runCompleteBody = z
  .object({
    installationId: uuid,
    personId: uuid,
    timezoneVersion: z.number().int().min(1),
    kind: runKind,
    rangeStartAt: isoInstant,
    rangeEndAt: isoInstant,
    completeSnapshot: z.boolean().optional(),
    presentNaturalKeys: z.array(z.string().min(1).max(256)).max(100_000).optional()
  })
  .strict();

export function createHealthKitRoutes(repository: HealthKitStore) {
  const healthKit = new Hono<{ Variables: AppVariables }>();
  healthKit.use("*", requireAuth());

  healthKit.get("/settings", async (c) => {
    const personId = c.req.query("personId");
    if (personId && !z.string().uuid().safeParse(personId).success) {
      throw new HttpError(400, "payload_invalid", "personId must be a UUID.");
    }
    const data = await repository.getHealthKitSettings(c.get("user").id, personId);
    return c.json({ data });
  });

  healthKit.put("/settings", zValidator("json", settingsBody), async (c) => {
    const body = c.req.valid("json");
    if (!isValidIanaTimezone(body.healthTimezone)) {
      throw new HttpError(400, "payload_invalid", "healthTimezone must be a valid IANA time zone.");
    }
    if (body.enabledGroups.length > 0 && !body.consentVersion) {
      throw new HttpError(400, "consent_withdrawn", "consentVersion is required when enabling metrics.");
    }
    const data = await repository.putHealthKitSettings(c.get("user").id, body);
    return c.json({ data });
  });

  healthKit.post("/ops:batch", zValidator("json", opsBatchBody), async (c) => {
    const body = c.req.valid("json") as HealthKitOpsBatchInput;
    for (const op of body.ops) {
      if (op.op === "upsert" && op.payload && op.payload.kind === "daily_metric") {
        if (!isHealthKitMetricKey(op.payload.healthMetric)) {
          // store returns rejected for this op
        }
      }
    }
    const data = await repository.applyHealthKitOps(c.get("user").id, body);
    return c.json({ data });
  });

  healthKit.post("/groups/:group/runs/begin", zValidator("json", runBeginBody), async (c) => {
    const groupKey = c.req.param("group");
    if (!group.safeParse(groupKey).success) {
      throw new HttpError(400, "payload_invalid", "group is not allowlisted.");
    }
    const data = await repository.beginHealthKitRun(
      c.get("user").id,
      groupKey as (typeof HEALTHKIT_CONSENT_GROUPS)[number],
      c.req.valid("json")
    );
    return c.json({ data });
  });

  healthKit.post("/groups/:group/runs/complete", zValidator("json", runCompleteBody), async (c) => {
    const groupKey = c.req.param("group");
    if (!group.safeParse(groupKey).success) {
      throw new HttpError(400, "payload_invalid", "group is not allowlisted.");
    }
    const data = await repository.completeHealthKitRun(
      c.get("user").id,
      groupKey as (typeof HEALTHKIT_CONSENT_GROUPS)[number],
      c.req.valid("json")
    );
    return c.json({ data });
  });

  healthKit.post("/groups/:group/start-import", zValidator("json", groupActionBody), async (c) => {
    const groupKey = c.req.param("group");
    if (!group.safeParse(groupKey).success) {
      throw new HttpError(400, "payload_invalid", "group is not allowlisted.");
    }
    const data = await repository.startHealthKitImport(
      c.get("user").id,
      groupKey as (typeof HEALTHKIT_CONSENT_GROUPS)[number],
      c.req.valid("json")
    );
    return c.json({ data });
  });

  healthKit.post("/groups/:group/ready", zValidator("json", groupActionBody), async (c) => {
    const groupKey = c.req.param("group");
    if (!group.safeParse(groupKey).success) {
      throw new HttpError(400, "payload_invalid", "group is not allowlisted.");
    }
    const data = await repository.markHealthKitGroupReady(
      c.get("user").id,
      groupKey as (typeof HEALTHKIT_CONSENT_GROUPS)[number],
      c.req.valid("json")
    );
    return c.json({ data });
  });

  healthKit.get("/groups/:group/status", async (c) => {
    const groupKey = c.req.param("group");
    if (!group.safeParse(groupKey).success) {
      throw new HttpError(400, "payload_invalid", "group is not allowlisted.");
    }
    const personId = c.req.query("personId");
    if (personId && !z.string().uuid().safeParse(personId).success) {
      throw new HttpError(400, "payload_invalid", "personId must be a UUID.");
    }
    const data = await repository.getHealthKitGroupStatus(
      c.get("user").id,
      groupKey as (typeof HEALTHKIT_CONSENT_GROUPS)[number],
      personId
    );
    return c.json({ data });
  });

  return healthKit;
}
