import { zValidator } from "@hono/zod-validator";
import { Hono } from "hono";
import { z } from "zod";
import { requireAuth, type AppVariables } from "../auth";
import type { HealthKitStore } from "../repositories/contracts";

const metricType = z.enum(["steps", "walking_distance", "sleep", "weight", "blood_pressure", "blood_glucose"]);
const timestamp = z.string().datetime({ offset: true });
const glucoseContext = z.enum(["fasting", "before_meal", "after_meal", "bedtime", "random"]);

const linkProfileBody = z.object({
  personId: z.string().uuid()
});

const settingsBody = z.object({
  enabledMetrics: z.array(metricType).max(6)
});

const sampleBody = z.object({
  metricType,
  sourceSampleKey: z.string().trim().min(1).max(256),
  startDate: timestamp,
  endDate: timestamp.optional(),
  value: z.number().optional(),
  unit: z.string().trim().min(1).max(40).optional(),
  systolic: z.number().int().min(50).max(260).optional(),
  diastolic: z.number().int().min(30).max(180).optional(),
  pulse: z.number().int().min(30).max(220).optional(),
  glucoseContext: glucoseContext.optional()
});

const importBody = z.object({
  samples: z.array(sampleBody).max(500)
});

const summaryQuery = z.object({
  personId: z.string().uuid().optional(),
  metricType: metricType.optional(),
  limit: z.coerce.number().int().min(1).max(365).default(90)
});

export function createHealthKitRoutes(repository: HealthKitStore) {
  const healthKit = new Hono<{ Variables: AppVariables }>();
  healthKit.use("*", requireAuth());

  healthKit.get("/sync/status", async (c) => {
    const data = await repository.getHealthKitSyncStatus(c.get("user").id);
    return c.json({ data });
  });

  healthKit.post("/link-profile", zValidator("json", linkProfileBody), async (c) => {
    const data = await repository.linkHealthKitProfile(c.get("user").id, c.req.valid("json").personId);
    return c.json({ data });
  });

  healthKit.patch("/sync/settings", zValidator("json", settingsBody), async (c) => {
    const data = await repository.updateHealthKitSyncSettings(c.get("user").id, c.req.valid("json").enabledMetrics);
    return c.json({ data });
  });

  healthKit.post("/samples/batch", zValidator("json", importBody), async (c) => {
    const data = await repository.importHealthKitSamples(c.get("user").id, c.req.valid("json").samples);
    return c.json({ data }, 201);
  });

  healthKit.get("/metrics/daily", zValidator("query", summaryQuery), async (c) => {
    const query = c.req.valid("query");
    const data = await repository.listHealthMetricDailySummaries(c.get("user").id, query.personId, query.metricType, query.limit);
    return c.json({ data });
  });

  return healthKit;
}
