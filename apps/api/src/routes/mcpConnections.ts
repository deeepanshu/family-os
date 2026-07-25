import { Hono } from "hono";
import { requireAuth, type AppVariables } from "../auth";
import type { McpConnectionStore } from "../repositories/contracts";

/**
 * User-facing MCP connection management.
 *
 * Connection grants are created by the OAuth consent handler
 * (`POST /health/api/oauth/consent/decision`) after it derives the OAuth client ID from
 * the verified Supabase authorization request. Clients must not supply
 * oauthClientId in a browser body for grant creation.
 */
export function createMcpConnectionRoutes(repository: McpConnectionStore) {
  const routes = new Hono<{ Variables: AppVariables }>();
  routes.use("*", requireAuth());

  routes.get("/", async (c) => {
    const data = await repository.listConnections(c.get("user").id);
    return c.json({ data });
  });

  routes.delete("/:connectionId", async (c) => {
    const data = await repository.revokeConnection(c.get("user").id, c.req.param("connectionId"));
    return c.json({ data });
  });

  return routes;
}
