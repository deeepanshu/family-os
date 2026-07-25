import { zValidator } from "@hono/zod-validator";
import { Hono } from "hono";
import { z } from "zod";
import { HEALTHKIT_CONSENT_GROUPS, HEALTHKIT_METRIC_REGISTRY, isHealthKitMetricKey } from "@family-os/shared";
import type { HealthKitSyncInput } from "@family-os/shared";
import { requireAuth, type AppVariables } from "../auth";
import { HttpError } from "../errors";
import type { HealthKitStore } from "../repositories/contracts";

const group = z.enum(HEALTHKIT_CONSENT_GROUPS);
const uuid = z.string().uuid();
const isoInstant = z.string().datetime({ offset: true });
const sleepDay = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);

const stepsHourUpsert = z
  .object({
    kind: z.literal("steps_hour_upsert"),
    hourStartUtc: isoInstant,
    count: z.number().int().min(0).max(200_000)
  })
  .strict();

const stepsHourDelete = z
  .object({
    kind: z.literal("steps_hour_delete"),
    hourStartUtc: isoInstant
  })
  .strict();

const sleepDayUpsert = z
  .object({
    kind: z.literal("sleep_day_upsert"),
    sleepDay,
    totalMinutes: z.number().int().min(0).max(24 * 60),
    coreMinutes: z.number().int().min(0).max(24 * 60),
    deepMinutes: z.number().int().min(0).max(24 * 60),
    remMinutes: z.number().int().min(0).max(24 * 60),
    unspecifiedAsleepMinutes: z.number().int().min(0).max(24 * 60),
    awakeMinutes: z.number().int().min(0).max(24 * 60),
    inBedMinutes: z.number().int().min(0).max(24 * 60),
    wristTemperatureCelsius: z.number().min(25).max(45).optional(),
    breathingDisturbanceCount: z.number().int().min(0).max(10_000).optional()
  })
  .strict();

const sleepDayDelete = z.object({ kind: z.literal("sleep_day_delete"), sleepDay }).strict();

const dailyMetricUpsert = z
  .object({
    kind: z.literal("daily_metric_upsert"),
    healthMetric: z.string().min(1).max(80),
    localDay: sleepDay,
    sumValue: z.number().finite().optional(),
    averageValue: z.number().finite().optional(),
    minimumValue: z.number().finite().optional(),
    maximumValue: z.number().finite().optional(),
    latestValue: z.number().finite().optional(),
    sampleCount: z.number().int().min(0).max(1_000_000)
  })
  .strict();

const dailyMetricDelete = z
  .object({ kind: z.literal("daily_metric_delete"), healthMetric: z.string().min(1).max(80), localDay: sleepDay })
  .strict();

const bloodPressureUpsert = z
  .object({
    kind: z.literal("blood_pressure_upsert"),
    sourceSampleKey: z.string().uuid(),
    measuredAtUtc: isoInstant,
    systolic: z.number().int().min(50).max(260),
    diastolic: z.number().int().min(30).max(180),
    pulse: z.number().int().min(30).max(220).optional()
  })
  .strict();

const bloodPressureDelete = z
  .object({
    kind: z.literal("blood_pressure_delete"),
    sourceSampleKey: z.string().uuid()
  })
  .strict();

const bloodGlucoseUpsert = z
  .object({
    kind: z.literal("blood_glucose_upsert"),
    sourceSampleKey: z.string().uuid(),
    measuredAtUtc: isoInstant,
    valueMgDl: z.number().min(20).max(700)
  })
  .strict();

const bloodGlucoseDelete = z.object({ kind: z.literal("blood_glucose_delete"), sourceSampleKey: z.string().uuid() }).strict();

const workoutUpsert = z
  .object({
    kind: z.literal("workout_upsert"),
    sourceSampleKey: z.string().uuid(),
    workoutType: z.string().trim().min(1).max(100),
    startedAtUtc: isoInstant,
    endedAtUtc: isoInstant,
    durationSeconds: z.number().int().min(0).max(7 * 24 * 60 * 60),
    activeEnergyKcal: z.number().min(0).max(100_000).optional(),
    distanceMeters: z.number().min(0).max(10_000_000).optional(),
    averageHeartRateBpm: z.number().min(0).max(300).optional(),
    maximumHeartRateBpm: z.number().min(0).max(300).optional()
  })
  .strict();

const workoutDelete = z.object({ kind: z.literal("workout_delete"), sourceSampleKey: z.string().uuid() }).strict();

const operation = z.discriminatedUnion("kind", [
  stepsHourUpsert,
  stepsHourDelete,
  sleepDayUpsert,
  sleepDayDelete,
  dailyMetricUpsert,
  dailyMetricDelete,
  bloodPressureUpsert,
  bloodPressureDelete,
  bloodGlucoseUpsert,
  bloodGlucoseDelete,
  workoutUpsert,
  workoutDelete
]);

const MAX_OPERATIONS = 500;

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

const syncBody = z
  .object({
    syncId: uuid,
    installationId: uuid,
    personId: uuid,
    timezoneVersion: z.number().int().min(1),
    repairId: uuid.optional(),
    chunkIndex: z.number().int().min(0).optional(),
    operations: z.array(operation).max(MAX_OPERATIONS)
  })
  .strict()
  .superRefine((value, ctx) => {
    const hasRepair = value.repairId !== undefined;
    const hasChunk = value.chunkIndex !== undefined;
    if (hasRepair !== hasChunk) {
      ctx.addIssue({
        code: "custom",
        message: "repairId and chunkIndex must be provided together.",
        path: ["repairId"]
      });
    }
  });

const repairBody = z
  .object({
    installationId: uuid,
    personId: uuid,
    group,
    timezoneVersion: z.number().int().min(1)
  })
  .strict();

const completeRepairBody = z
  .object({
    expectedChunkCount: z.number().int().min(0).max(10_000)
  })
  .strict();

function assertUtcHourBoundary(hourStartUtc: string) {
  const date = new Date(hourStartUtc);
  if (Number.isNaN(date.getTime())) {
    throw new HttpError(400, "healthkit_operation_invalid", "hourStartUtc must be a valid UTC instant.");
  }
  if (
    date.getUTCMinutes() !== 0 ||
    date.getUTCSeconds() !== 0 ||
    date.getUTCMilliseconds() !== 0
  ) {
    throw new HttpError(400, "healthkit_operation_invalid", "hourStartUtc must fall on a UTC hour boundary.");
  }
}

function assertValidTimezone(timezone: string) {
  try {
    Intl.DateTimeFormat(undefined, { timeZone: timezone });
  } catch {
    throw new HttpError(400, "healthkit_operation_invalid", "healthTimezone must be a valid IANA time zone.");
  }
}

function assertRegisteredOperation(input: z.infer<typeof operation>) {
  if (input.kind !== "daily_metric_upsert" && input.kind !== "daily_metric_delete") return;
  if (!isHealthKitMetricKey(input.healthMetric)) {
    throw new HttpError(400, "healthkit_operation_invalid", "healthMetric is not allowlisted.");
  }
  const definition = HEALTHKIT_METRIC_REGISTRY[input.healthMetric];
  if (definition.storage !== "daily_numeric" || !definition.aggregation) {
    throw new HttpError(400, "healthkit_operation_invalid", "healthMetric does not use daily numeric storage.");
  }
  if (input.kind === "daily_metric_delete") return;

  const provided = [input.sumValue, input.averageValue, input.minimumValue, input.maximumValue, input.latestValue]
    .filter((value) => value !== undefined).length;
  if (definition.aggregation === "sum" && (input.sumValue === undefined || provided !== 1 || input.sampleCount < 1)) {
    throw new HttpError(400, "healthkit_operation_invalid", "Summed metric operations require sumValue and a positive sampleCount.");
  }
  if (
    definition.aggregation === "statistics" &&
    (input.averageValue === undefined || input.minimumValue === undefined || input.maximumValue === undefined || input.latestValue === undefined || provided !== 4 || input.sampleCount < 1)
  ) {
    throw new HttpError(400, "healthkit_operation_invalid", "Statistics metric operations require average, minimum, maximum, latest, and a positive sampleCount.");
  }
  if (definition.aggregation === "latest" && (input.latestValue === undefined || provided !== 1 || input.sampleCount < 1)) {
    throw new HttpError(400, "healthkit_operation_invalid", "Latest metric operations require latestValue and a positive sampleCount.");
  }
}

export function createHealthKitRoutes(repository: HealthKitStore) {
  const healthKit = new Hono<{ Variables: AppVariables }>();
  healthKit.use("*", requireAuth());

  healthKit.get("/settings", async (c) => {
    const personId = c.req.query("personId");
    if (personId && !z.string().uuid().safeParse(personId).success) {
      throw new HttpError(400, "healthkit_operation_invalid", "personId must be a UUID.");
    }
    const data = await repository.getHealthKitSettings(c.get("user").id, personId);
    return c.json({ data });
  });

  healthKit.put("/settings", zValidator("json", settingsBody), async (c) => {
    const body = c.req.valid("json");
    assertValidTimezone(body.healthTimezone);
    if (body.enabledGroups.length > 0 && !body.consentVersion) {
      throw new HttpError(400, "healthkit_consent_required", "consentVersion is required when enabling metrics.");
    }
    const data = await repository.putHealthKitSettings(c.get("user").id, body);
    return c.json({ data });
  });

  healthKit.post("/sync", zValidator("json", syncBody), async (c) => {
    const body = c.req.valid("json");
    for (const op of body.operations) {
      if (op.kind === "steps_hour_upsert" || op.kind === "steps_hour_delete") {
        assertUtcHourBoundary(op.hourStartUtc);
      }
      assertRegisteredOperation(op);
    }
    const data = await repository.syncHealthKit(c.get("user").id, body as HealthKitSyncInput);
    return c.json({ data });
  });

  healthKit.post("/repairs", zValidator("json", repairBody), async (c) => {
    const body = c.req.valid("json");
    const data = await repository.createHealthKitRepair(c.get("user").id, body);
    return c.json({ data }, 201);
  });

  healthKit.post("/repairs/:repairId/complete", zValidator("json", completeRepairBody), async (c) => {
    const repairId = c.req.param("repairId");
    if (!z.string().uuid().safeParse(repairId).success) {
      throw new HttpError(400, "healthkit_repair_invalid", "repairId must be a UUID.");
    }
    const data = await repository.completeHealthKitRepair(c.get("user").id, repairId, c.req.valid("json"));
    return c.json({ data });
  });

  return healthKit;
}
