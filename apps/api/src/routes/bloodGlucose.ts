import { zValidator } from "@hono/zod-validator";
import { Hono } from "hono";
import { z } from "zod";
import { requireAuth, type AppVariables } from "../auth";
import type { ReadingStore } from "../repositories/contracts";

const timestamp = z.string().datetime({ offset: true });
const glucoseContext = z.enum(["fasting", "before_meal", "after_meal", "bedtime", "random"]);

const body = z.object({
  personId: z.string().uuid(),
  value: z.number().min(20).max(700),
  unit: z.literal("mg/dL").default("mg/dL"),
  context: glucoseContext,
  measuredAt: timestamp,
  notes: z.string().trim().min(1).max(1000).optional()
});

const updateBody = body.omit({ personId: true, unit: true }).partial();
const idParam = z.object({ id: z.string().uuid() });
const query = z.object({
  personId: z.string().uuid().optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50)
});

export function createBloodGlucoseRoutes(repository: ReadingStore) {
  const readings = new Hono<{ Variables: AppVariables }>();
  readings.use("*", requireAuth());

  readings.post("/", zValidator("json", body), async (c) => {
    const parsed = c.req.valid("json");
    const data = await repository.createBloodGlucose({
      actorUserId: c.get("user").id,
      personId: parsed.personId,
      value: parsed.value,
      context: parsed.context,
      measuredAt: parsed.measuredAt,
      notes: parsed.notes
    });
    return c.json({ data }, 201);
  });

  readings.get("/", zValidator("query", query), async (c) => {
    const parsed = c.req.valid("query");
    const data = await repository.listBloodGlucose(c.get("user").id, parsed.personId, parsed.limit);
    return c.json({ data });
  });

  readings.get("/:id", zValidator("param", idParam), async (c) => {
    const data = await repository.getBloodGlucose(c.get("user").id, c.req.valid("param").id);
    return c.json({ data });
  });

  readings.patch("/:id", zValidator("param", idParam), zValidator("json", updateBody), async (c) => {
    const data = await repository.updateBloodGlucose(c.get("user").id, c.req.valid("param").id, c.req.valid("json"));
    return c.json({ data });
  });

  readings.delete("/:id", zValidator("param", idParam), async (c) => {
    await repository.deleteBloodGlucose(c.get("user").id, c.req.valid("param").id);
    return c.body(null, 204);
  });

  return readings;
}
