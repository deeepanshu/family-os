import { zValidator } from "@hono/zod-validator";
import { Hono } from "hono";
import { z } from "zod";
import { requireAuth, type AppVariables } from "../auth";
import type { ReadingStore } from "../repositories/contracts";

const timestamp = z.string().datetime({ offset: true });

const body = z.object({
  personId: z.string().uuid(),
  systolic: z.number().int().min(50).max(260),
  diastolic: z.number().int().min(30).max(180),
  pulse: z.number().int().min(30).max(220).optional(),
  measuredAt: timestamp,
  context: z.string().trim().min(1).max(120).optional(),
  notes: z.string().trim().min(1).max(1000).optional()
});

const updateBody = body.omit({ personId: true }).partial();
const idParam = z.object({ id: z.string().uuid() });
const query = z.object({
  personId: z.string().uuid().optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50)
});

export function createBloodPressureRoutes(repository: ReadingStore) {
  const readings = new Hono<{ Variables: AppVariables }>();
  readings.use("*", requireAuth());

  readings.post("/", zValidator("json", body), async (c) => {
    const data = await repository.createBloodPressure({
      actorUserId: c.get("user").id,
      ...c.req.valid("json")
    });
    return c.json({ data }, 201);
  });

  readings.get("/", zValidator("query", query), async (c) => {
    const parsed = c.req.valid("query");
    const data = await repository.listBloodPressure(c.get("user").id, parsed.personId, parsed.limit);
    return c.json({ data });
  });

  readings.get("/:id", zValidator("param", idParam), async (c) => {
    const data = await repository.getBloodPressure(c.get("user").id, c.req.valid("param").id);
    return c.json({ data });
  });

  readings.patch("/:id", zValidator("param", idParam), zValidator("json", updateBody), async (c) => {
    const data = await repository.updateBloodPressure(c.get("user").id, c.req.valid("param").id, c.req.valid("json"));
    return c.json({ data });
  });

  readings.delete("/:id", zValidator("param", idParam), async (c) => {
    await repository.deleteBloodPressure(c.get("user").id, c.req.valid("param").id);
    return c.body(null, 204);
  });

  return readings;
}
