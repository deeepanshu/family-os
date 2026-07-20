import { zValidator } from "@hono/zod-validator";
import { Hono } from "hono";
import { z } from "zod";
import { requireAuth, type AppVariables } from "../auth";
import type { McpConnectionStore } from "../repositories/contracts";

const createBody = z.object({
  oauthClientId: z.string().trim().min(1).max(200),
  consentVersion: z.string().trim().min(1).max(64),
  expiresAt: z.string().datetime({ offset: true }).optional()
});

export function createMcpConnectionRoutes(repository: McpConnectionStore) {
  const routes = new Hono<{ Variables: AppVariables }>();
  routes.use("*", requireAuth());

  routes.get("/", async (c) => {
    const data = await repository.listConnections(c.get("user").id);
    return c.json({ data });
  });

  routes.post("/", zValidator("json", createBody), async (c) => {
    const body = c.req.valid("json");
    const data = await repository.createConnection({
      userId: c.get("user").id,
      oauthClientId: body.oauthClientId,
      capabilities: ["health_read"],
      consentVersion: body.consentVersion,
      expiresAt: body.expiresAt
    });
    return c.json({ data }, 201);
  });

  routes.delete("/:connectionId", async (c) => {
    const data = await repository.revokeConnection(c.get("user").id, c.req.param("connectionId"));
    return c.json({ data });
  });

  return routes;
}
