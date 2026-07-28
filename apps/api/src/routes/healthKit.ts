import { zValidator } from "@hono/zod-validator";
import { Hono } from "hono";
import { z } from "zod";
import {
  HEALTHKIT_CONSENT_GROUPS,
  HEALTHKIT_EVENTS_BATCH_MAX,
  isHealthKitMetricKey
} from "@family-os/shared";
import type { HealthKitEventsBatchInput, HealthKitSyncEvent } from "@family-os/shared";
import { requireAuth, type AppVariables } from "../auth";
import { HttpError } from "../errors";
import { assertEventCoherent, isValidIanaTimezone } from "../repositories/healthKitDomain";
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
    // These are raw source-stage totals. Separate HealthKit sources can overlap,
    // unlike totalMinutes, which the client merges into one sleep duration.
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
    /** HealthKit object UUID (HKCorrelation for BP). */
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
    maximumHeartRateBpm: z.number().min(0).max(300).optional()
  })
  .strict();

const eventPayload = z.discriminatedUnion("kind", [
  stepsHourPayload,
  sleepDayPayload,
  dailyMetricPayload,
  bloodPressurePayload,
  bloodGlucosePayload,
  workoutPayload
]);

const syncEvent = z
  .object({
    eventId: uuid,
    entityKey: z.string().min(1).max(256),
    entityVersion: z.number().int().min(1),
    group,
    scopeKey: z.string().min(1).max(80),
    op: z.enum(["upsert", "delete"]),
    sessionId: uuid.nullable().optional(),
    payload: eventPayload.nullable().optional()
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

const eventsBatchBody = z
  .object({
    installationId: uuid,
    personId: uuid,
    timezoneVersion: z.number().int().min(1),
    events: z.array(syncEvent).min(1).max(HEALTHKIT_EVENTS_BATCH_MAX)
  })
  .strict();

const sessionBody = z
  .object({
    installationId: uuid,
    personId: uuid,
    timezoneVersion: z.number().int().min(1),
    group
  })
  .strict();

const scopeManifestBody = z
  .object({
    installationId: uuid,
    personId: uuid,
    timezoneVersion: z.number().int().min(1),
    eventCount: z.number().int().min(0).max(1_000_000),
    manifestHash: z.string().regex(/^[a-fA-F0-9]{64}$/)
  })
  .strict();

const sessionActionBody = z
  .object({
    installationId: uuid,
    personId: uuid,
    timezoneVersion: z.number().int().min(1),
    reason: z.string().trim().min(1).max(200).optional()
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

  healthKit.post("/events:batch", zValidator("json", eventsBatchBody), async (c) => {
    const body = c.req.valid("json") as HealthKitEventsBatchInput;
    // Structural Zod validation first; deeper coherence runs in the store per-event
    // so permanent rejections return per-event results instead of failing the batch.
    for (const event of body.events) {
      if (event.op === "upsert" && event.payload && event.payload.kind === "daily_metric") {
        if (!isHealthKitMetricKey(event.payload.healthMetric)) {
          // leave to store payload_invalid result
        }
      }
      // Lightweight pre-check so obviously broken events still enter the batch path.
      try {
        assertEventCoherent(event as HealthKitSyncEvent);
      } catch {
        // Store re-validates and records payload_invalid per event.
      }
    }
    const data = await repository.applyHealthKitEvents(c.get("user").id, body);
    return c.json({ data });
  });

  healthKit.post("/sessions", zValidator("json", sessionBody), async (c) => {
    const data = await repository.createBackfillSession(c.get("user").id, c.req.valid("json"));
    return c.json({ data }, 201);
  });

  healthKit.get("/sessions/:sessionId", async (c) => {
    const sessionId = c.req.param("sessionId");
    if (!z.string().uuid().safeParse(sessionId).success) {
      throw new HttpError(400, "session_expired", "sessionId must be a UUID.");
    }
    const data = await repository.getBackfillSession(c.get("user").id, sessionId);
    return c.json({ data });
  });

  healthKit.get("/sessions/:sessionId/pending", async (c) => {
    const sessionId = c.req.param("sessionId");
    if (!z.string().uuid().safeParse(sessionId).success) {
      throw new HttpError(400, "session_expired", "sessionId must be a UUID.");
    }
    const cursor = c.req.query("cursor") ?? undefined;
    const limitRaw = c.req.query("limit");
    const limit = limitRaw ? Number(limitRaw) : 100;
    if (!Number.isInteger(limit) || limit < 1 || limit > 100) {
      throw new HttpError(400, "payload_invalid", "limit must be 1-100.");
    }
    const data = await repository.listBackfillPending(c.get("user").id, sessionId, cursor, limit);
    return c.json({ data });
  });

  healthKit.put(
    "/sessions/:sessionId/scopes/:scopeKey/manifest",
    zValidator("json", scopeManifestBody),
    async (c) => {
      const sessionId = c.req.param("sessionId");
      const scopeKey = c.req.param("scopeKey");
      if (!z.string().uuid().safeParse(sessionId).success) {
        throw new HttpError(400, "session_expired", "sessionId must be a UUID.");
      }
      if (!isHealthKitMetricKey(scopeKey)) {
        throw new HttpError(400, "payload_invalid", "scopeKey is not allowlisted.");
      }
      const data = await repository.putScopeManifest(
        c.get("user").id,
        sessionId,
        scopeKey,
        c.req.valid("json")
      );
      return c.json({ data });
    }
  );

  healthKit.post("/sessions/:sessionId/complete", zValidator("json", sessionActionBody), async (c) => {
    const sessionId = c.req.param("sessionId");
    if (!z.string().uuid().safeParse(sessionId).success) {
      throw new HttpError(400, "session_expired", "sessionId must be a UUID.");
    }
    const data = await repository.completeBackfillSession(
      c.get("user").id,
      sessionId,
      c.req.valid("json")
    );
    return c.json({ data });
  });

  healthKit.post("/sessions/:sessionId/abort", zValidator("json", sessionActionBody), async (c) => {
    const sessionId = c.req.param("sessionId");
    if (!z.string().uuid().safeParse(sessionId).success) {
      throw new HttpError(400, "session_expired", "sessionId must be a UUID.");
    }
    const data = await repository.abortBackfillSession(c.get("user").id, sessionId, c.req.valid("json"));
    return c.json({ data });
  });

  healthKit.get("/groups/:group/manifest", async (c) => {
    const groupKey = c.req.param("group");
    if (!group.safeParse(groupKey).success) {
      throw new HttpError(400, "payload_invalid", "group is not allowlisted.");
    }
    const personId = c.req.query("personId");
    if (personId && !z.string().uuid().safeParse(personId).success) {
      throw new HttpError(400, "payload_invalid", "personId must be a UUID.");
    }
    const data = await repository.getGroupManifest(
      c.get("user").id,
      groupKey as (typeof HEALTHKIT_CONSENT_GROUPS)[number],
      personId
    );
    return c.json({ data });
  });

  return healthKit;
}
