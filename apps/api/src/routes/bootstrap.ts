import { Hono } from "hono";
import { requireAuth, type AppVariables } from "../auth";
import type { FamilyStore } from "../repositories/contracts";

export function createBootstrapRoutes(familyRepository: FamilyStore) {
  const bootstrap = new Hono<{ Variables: AppVariables }>();

  bootstrap.use("*", requireAuth());

  bootstrap.post("/", async (c) => {
    const user = c.get("user");
    const data = await familyRepository.bootstrap(user.id);
    return c.json({ data });
  });

  return bootstrap;
}
