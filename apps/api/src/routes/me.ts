import { zValidator } from "@hono/zod-validator";
import { Hono } from "hono";
import { z } from "zod";
import { requireAuth, type AppVariables } from "../auth";
import type { ProfileStore } from "../repositories/contracts";

const createSelfProfileSchema = z.object({
  displayName: z.string().trim().min(1).max(120)
});

export function createMeRoutes(profileRepository: ProfileStore) {
  const me = new Hono<{ Variables: AppVariables }>();

  me.use("*", requireAuth());

  me.post("/profile", zValidator("json", createSelfProfileSchema), async (c) => {
    const user = c.get("user");
    const body = c.req.valid("json");
    const data = await profileRepository.createSelfProfile(user.id, body.displayName);
    return c.json({ data }, 201);
  });

  return me;
}
