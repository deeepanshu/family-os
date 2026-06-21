import { zValidator } from "@hono/zod-validator";
import { Hono } from "hono";
import { z } from "zod";
import { requireAuth, type AppVariables } from "../auth";
import type { FamilyRepository } from "../repositories/families";

const body = z.object({
  subjectPersonId: z.string().uuid().optional(),
  type: z.enum(["generic", "blood_glucose", "blood_pressure"]),
  title: z.string().trim().min(1).max(120),
  message: z.string().trim().min(1).max(500),
  scheduleKind: z.enum(["once", "daily", "weekly", "custom_days"]),
  timeOfDay: z.string().regex(/^\d{2}:\d{2}$/).optional(),
  timezone: z.string().trim().min(1).max(80),
  daysOfWeek: z.array(z.number().int().min(0).max(6)).optional(),
  startsOn: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  endsOn: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  recipientUserIds: z.array(z.string().uuid()).min(1)
});

const updateBody = body.partial().extend({ enabled: z.boolean().optional() });
const idParam = z.object({ id: z.string().uuid() });

export function createReminderRoutes(repository: FamilyRepository) {
  const reminders = new Hono<{ Variables: AppVariables }>();
  reminders.use("*", requireAuth());

  reminders.post("/", zValidator("json", body), async (c) => {
    const data = await repository.createReminder({ actorUserId: c.get("user").id, ...c.req.valid("json") });
    return c.json({ data }, 201);
  });
  reminders.get("/", async (c) => c.json({ data: await repository.listReminders(c.get("user").id) }));
  reminders.get("/:id", zValidator("param", idParam), async (c) =>
    c.json({ data: await repository.getReminder(c.get("user").id, c.req.valid("param").id) })
  );
  reminders.patch("/:id", zValidator("param", idParam), zValidator("json", updateBody), async (c) =>
    c.json({ data: await repository.updateReminder(c.get("user").id, c.req.valid("param").id, c.req.valid("json")) })
  );
  reminders.delete("/:id", zValidator("param", idParam), async (c) => {
    await repository.deleteReminder(c.get("user").id, c.req.valid("param").id);
    return c.body(null, 204);
  });
  reminders.post("/:id/disable-for-me", zValidator("param", idParam), async (c) =>
    c.json({ data: await repository.disableReminderForSelf(c.get("user").id, c.req.valid("param").id) })
  );
  return reminders;
}
