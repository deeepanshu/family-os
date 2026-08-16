import { Hono } from "hono";
import { requireAuth, type AppVariables } from "../auth";
import type { AppConfig } from "../config";
import { mcpPublicOrigin } from "../mcp/publicUrl";
import type { FamilyStore } from "../repositories/contracts";
import { attachBootstrapUrls } from "./inviteUrls";

export function createBootstrapRoutes(familyRepository: FamilyStore, config: AppConfig) {
  const bootstrap = new Hono<{ Variables: AppVariables }>();

  bootstrap.use("*", requireAuth());

  bootstrap.post("/", async (c) => {
    const user = c.get("user");
    const data = attachBootstrapUrls(await familyRepository.bootstrap(user.id), mcpPublicOrigin(config));
    return c.json({ data });
  });

  return bootstrap;
}
