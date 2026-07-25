import { zValidator } from "@hono/zod-validator";
import { Hono } from "hono";
import { z } from "zod";
import { requireAuth, type AppVariables } from "../auth";
import type { ReadingStore } from "../repositories/contracts";

const idParam = z.object({ id: z.string().uuid() });
const query = z.object({
  personId: z.string().uuid().optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50)
});

/**
 * Blood pressure is HealthKit-only. Manual create/update/delete routes are removed;
 * only authenticated family read access remains.
 */
export function createBloodPressureRoutes(repository: ReadingStore) {
  const readings = new Hono<{ Variables: AppVariables }>();
  readings.use("*", requireAuth());

  readings.get("/", zValidator("query", query), async (c) => {
    const parsed = c.req.valid("query");
    const data = await repository.listBloodPressure(c.get("user").id, parsed.personId, parsed.limit);
    return c.json({ data });
  });

  readings.get("/:id", zValidator("param", idParam), async (c) => {
    const data = await repository.getBloodPressure(c.get("user").id, c.req.valid("param").id);
    return c.json({ data });
  });

  return readings;
}
