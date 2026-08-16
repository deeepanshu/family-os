import { zValidator } from "@hono/zod-validator";
import { Hono } from "hono";
import { z } from "zod";
import type { AppConfig } from "../config";
import { requireAuth, type AppVariables } from "../auth";
import { mcpPublicOrigin } from "../mcp/publicUrl";
import type { FamilyStore } from "../repositories/contracts";
import { attachHouseholdUrls } from "./inviteUrls";

const createFamilySchema = z.object({
  name: z.string().trim().min(1).max(120)
});

const memberParam = z.object({
  userId: z.string().uuid()
});

export function createFamilyRoutes(repository: FamilyStore, config: AppConfig) {
  const families = new Hono<{ Variables: AppVariables }>();

  families.use("*", requireAuth());

  families.post("/", zValidator("json", createFamilySchema), async (c) => {
    const user = c.get("user");
    const body = c.req.valid("json");
    const data = await repository.createFamily({
      name: body.name,
      userId: user.id
    });

    return c.json({ data: attachHouseholdUrls(data, mcpPublicOrigin(config)) }, 201);
  });

  families.get("/current", async (c) => {
    const user = c.get("user");
    const data = attachHouseholdUrls(await repository.getCurrentFamily(user.id), mcpPublicOrigin(config));
    return c.json({ data });
  });

  families.delete("/current", async (c) => {
    await repository.deleteFamily(c.get("user").id);
    return c.body(null, 204);
  });

  families.get("/members", async (c) => {
    const user = c.get("user");
    const data = await repository.listMembers(user.id);
    return c.json({ data });
  });

  families.delete("/members/:userId", zValidator("param", memberParam), async (c) => {
    await repository.removeMember(c.get("user").id, c.req.valid("param").userId);
    return c.body(null, 204);
  });

  families.post("/leave", async (c) => {
    await repository.leaveFamily(c.get("user").id);
    return c.body(null, 204);
  });

  return families;
}
