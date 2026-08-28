import { Hono } from "hono";
import { z } from "zod";
import { requireAuth, type AppVariables } from "../auth";
import type { AppConfig } from "../config";
import { mcpPublicOrigin } from "../mcp/publicUrl";
import type { FamilyStore } from "../repositories/contracts";
import { attachBootstrapUrls } from "./inviteUrls";

const bootstrapBodySchema = z.object({
  appleUserId: z.string().trim().min(1).max(255).optional()
});

export function createBootstrapRoutes(familyRepository: FamilyStore, config: AppConfig) {
  const bootstrap = new Hono<{ Variables: AppVariables }>();

  bootstrap.use("*", requireAuth());

  bootstrap.post("/", async (c) => {
    const user = c.get("user");
    const contentType = c.req.header("content-type") ?? "";
    let appleUserId: string | undefined;
    if (contentType.includes("application/json")) {
      const parsed = bootstrapBodySchema.safeParse(await c.req.json().catch(() => ({})));
      if (parsed.success) {
        appleUserId = parsed.data.appleUserId;
      }
    }
    const data = attachBootstrapUrls(
      await familyRepository.bootstrap(user.id, appleUserId),
      mcpPublicOrigin(config)
    );
    return c.json({ data });
  });

  return bootstrap;
}
