import { zValidator } from "@hono/zod-validator";
import { Hono } from "hono";
import { z } from "zod";
import { requireAuth, type AppVariables } from "../auth";
import { deleteSupabaseAuthUser } from "../authAdmin";
import type { AppConfig } from "../config";
import type { ProfileStore } from "../repositories/contracts";

const createSelfProfileSchema = z.object({
  displayName: z.string().trim().min(1).max(120)
});

export function createMeRoutes(profileRepository: ProfileStore, config: AppConfig) {
  const me = new Hono<{ Variables: AppVariables }>();

  me.use("*", requireAuth());

  me.post("/profile", zValidator("json", createSelfProfileSchema), async (c) => {
    const user = c.get("user");
    const body = c.req.valid("json");
    const data = await profileRepository.createSelfProfile(user.id, body.displayName);
    return c.json({ data }, 201);
  });

  me.delete("/", async (c) => {
    const user = c.get("user");
    await profileRepository.deleteAccount(user.id);
    await deleteSupabaseAuthUser(c.get("config") ?? config, user.id);
    return c.body(null, 204);
  });

  return me;
}
