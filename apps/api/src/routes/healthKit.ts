import { zValidator } from "@hono/zod-validator";
import { Hono } from "hono";
import { z } from "zod";
import { requireAuth, type AppVariables } from "../auth";
import { HttpError } from "../errors";
import type { HealthKitStore } from "../repositories/contracts";

const metric = z.enum(["steps", "sleep", "blood_pressure"]);
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

const sleepDayUpsert = z
  .object({
    kind: z.literal("sleep_day_upsert"),
    sleepDay,
    durationMinutes: z.number().int().min(0).max(24 * 60)
  })
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

const operation = z.discriminatedUnion("kind", [
  stepsHourUpsert,
  sleepDayUpsert,
  bloodPressureUpsert,
  bloodPressureDelete
]);

const MAX_OPERATIONS = 500;

const settingsBody = z
  .object({
    personId: uuid,
    consentVersion: z.string().trim().min(1).max(64).optional(),
    enabledMetrics: z.array(metric).max(3),
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
    metric,
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
    if (body.enabledMetrics.length > 0 && !body.consentVersion) {
      throw new HttpError(400, "healthkit_consent_required", "consentVersion is required when enabling metrics.");
    }
    const data = await repository.putHealthKitSettings(c.get("user").id, body);
    return c.json({ data });
  });

  healthKit.post("/sync", zValidator("json", syncBody), async (c) => {
    const body = c.req.valid("json");
    for (const op of body.operations) {
      if (op.kind === "steps_hour_upsert") {
        assertUtcHourBoundary(op.hourStartUtc);
      }
    }
    const data = await repository.syncHealthKit(c.get("user").id, body);
    return c.json({ data });
  });

  healthKit.post("/repairs", zValidator("json", repairBody), async (c) => {
    const data = await repository.createHealthKitRepair(c.get("user").id, c.req.valid("json"));
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
