import { zValidator } from "@hono/zod-validator";
import { Hono } from "hono";
import { z } from "zod";
import { requireAuth, type AppVariables } from "../auth";
import type { FamilyRepository } from "../repositories/families";

const createInviteSchema = z.object({
  email: z.string().email().optional(),
  role: z.enum(["manager", "member"]).default("member")
});

const tokenSchema = z.object({
  token: z.string().min(16).max(256)
});

export function createInviteRoutes(repository: FamilyRepository) {
  const invites = new Hono<{ Variables: AppVariables }>();

  invites.post("/", requireAuth(), zValidator("json", createInviteSchema), async (c) => {
    const user = c.get("user");
    const body = c.req.valid("json");
    const data = await repository.createInvite({
      actorUserId: user.id,
      email: body.email,
      role: body.role
    });
    return c.json({ data }, 201);
  });

  invites.get("/:token", zValidator("param", tokenSchema), async (c) => {
    const { token } = c.req.valid("param");
    const data = await repository.getInviteByToken(token);
    return c.json({ data });
  });

  invites.post("/:token/accept", requireAuth(), zValidator("param", tokenSchema), async (c) => {
    const user = c.get("user");
    const { token } = c.req.valid("param");
    const data = await repository.acceptInvite(token, user.id, user.email);
    return c.json({ data });
  });

  return invites;
}
