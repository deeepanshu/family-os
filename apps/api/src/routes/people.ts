import { zValidator } from "@hono/zod-validator";
import { Hono } from "hono";
import { z } from "zod";
import { requireAuth, type AppVariables } from "../auth";
import type { FamilyRepository } from "../repositories/families";

const profileBody = z.object({
  displayName: z.string().trim().min(1).max(120),
  relationshipLabel: z.string().trim().min(1).max(80).optional(),
  dateOfBirth: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .refine((value) => {
      const date = new Date(`${value}T00:00:00.000Z`);
      return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === value;
    }, "Invalid date")
    .optional()
});

const updateProfileBody = profileBody.partial().extend({
  status: z.enum(["active", "inactive"]).optional()
});

const idParam = z.object({
  id: z.string().uuid()
});

export function createPeopleRoutes(repository: FamilyRepository) {
  const people = new Hono<{ Variables: AppVariables }>();

  people.use("*", requireAuth());

  people.get("/", async (c) => {
    const data = await repository.listProfiles(c.get("user").id);
    return c.json({ data });
  });

  people.get("/:id", zValidator("param", idParam), async (c) => {
    const data = await repository.getProfile(c.get("user").id, c.req.valid("param").id);
    return c.json({ data });
  });

  people.post("/", zValidator("json", profileBody), async (c) => {
    const data = await repository.createProfile({
      actorUserId: c.get("user").id,
      ...c.req.valid("json")
    });
    return c.json({ data }, 201);
  });

  people.patch("/:id", zValidator("param", idParam), zValidator("json", updateProfileBody), async (c) => {
    const data = await repository.updateProfile(c.get("user").id, c.req.valid("param").id, c.req.valid("json"));
    return c.json({ data });
  });

  people.delete("/:id", zValidator("param", idParam), async (c) => {
    await repository.deleteProfile(c.get("user").id, c.req.valid("param").id);
    return c.body(null, 204);
  });

  return people;
}
