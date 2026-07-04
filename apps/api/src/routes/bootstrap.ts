import { zValidator } from "@hono/zod-validator";
import { Hono } from "hono";
import { z } from "zod";
import { requireAuth, type AppVariables } from "../auth";
import type { FamilyStore, ProfileStore } from "../repositories/contracts";

const createSelfProfileSchema = z.object({
  displayName: z.string().trim().min(1).max(120)
});

export function createBootstrapRoutes(familyRepository: FamilyStore, profileRepository: ProfileStore) {
  const bootstrap = new Hono<{ Variables: AppVariables }>();

  bootstrap.use("*", requireAuth());

  bootstrap.post("/", async (c) => {
    const user = c.get("user");
    const data = await familyRepository.bootstrap(user.id);
    return c.json({ data });
  });

  bootstrap.post("/me/profile", zValidator("json", createSelfProfileSchema), async (c) => {
    const user = c.get("user");
    const body = c.req.valid("json");
    const data = await profileRepository.createSelfProfile(user.id, body.displayName);
    return c.json({ data }, 201);
  });

  return bootstrap;
}
