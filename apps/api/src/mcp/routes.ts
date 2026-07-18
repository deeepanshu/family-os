import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { Hono } from "hono";
import { cors } from "hono/cors";
import { randomUUID } from "node:crypto";
import type { AppConfig } from "../config";
import { extractBearerToken, verifyBearerToken, type AppVariables } from "../auth";
import { HttpError, jsonError } from "../errors";
import type { AppRepositories } from "../repositories/contracts";
import { HealthMcpReadService } from "./HealthMcpReadService";
import { createFamilyOsMcpServer } from "./createMcpServer";

export type McpRouteDeps = {
  config: AppConfig;
  repositories: AppRepositories;
  service?: HealthMcpReadService;
};

export function createMcpWellKnownRoutes(config: AppConfig) {
  const routes = new Hono<{ Variables: AppVariables }>();

  routes.get("/.well-known/oauth-protected-resource", (c) => {
    return c.json(buildProtectedResourceMetadata(config));
  });

  routes.get("/.well-known/oauth-protected-resource/mcp", (c) => {
    return c.json(buildProtectedResourceMetadata(config));
  });

  return routes;
}

export function createMcpRoutes(deps: McpRouteDeps) {
  const routes = new Hono<{ Variables: AppVariables }>();
  const service =
    deps.service ??
    new HealthMcpReadService({
      families: deps.repositories.families,
      profiles: deps.repositories.profiles,
      healthKit: deps.repositories.healthKit,
      readings: deps.repositories.readings,
      mcpConnections: deps.repositories.mcpConnections,
      auditLogs: deps.repositories.auditLogs
    });

  routes.use(
    "*",
    cors({
      origin: deps.config.HEALTH_API_CORS_ORIGIN,
      allowHeaders: [
        "authorization",
        "content-type",
        "accept",
        "mcp-protocol-version",
        "mcp-session-id",
        "last-event-id",
        "x-request-id"
      ],
      allowMethods: ["GET", "POST", "DELETE", "OPTIONS"],
      exposeHeaders: ["mcp-session-id", "mcp-protocol-version", "www-authenticate", "x-request-id"],
      maxAge: 600
    })
  );

  routes.get("/healthcheck", (c) => {
    return c.json({
      data: {
        service: "family-os-mcp",
        status: "ok"
      }
    });
  });

  routes.all("/", async (c) => {
    if (c.req.method === "OPTIONS") {
      return c.body(null, 204);
    }

    const token = extractBearerToken(c.req.header("authorization"));
    if (!token) {
      return unauthorizedMcp(c, deps.config);
    }

    let verified;
    try {
      verified = await verifyBearerToken(token, deps.config);
    } catch (error) {
      if (error instanceof HttpError && error.status === 401) {
        return unauthorizedMcp(c, deps.config);
      }
      if (error instanceof HttpError) {
        return jsonError(c, error);
      }
      return unauthorizedMcp(c, deps.config);
    }

    if (!verified.oauthClientId) {
      return unauthorizedMcp(c, deps.config, "Token is missing OAuth client identity.");
    }

    const correlationId = c.req.header("x-request-id") ?? randomUUID();
    const transport = new WebStandardStreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
      enableJsonResponse: true
    });
    const server = createFamilyOsMcpServer({
      service,
      caller: {
        userId: verified.userId,
        oauthClientId: verified.oauthClientId,
        correlationId
      },
      config: deps.config
    });

    await server.connect(transport);
    try {
      return await transport.handleRequest(c.req.raw);
    } finally {
      await transport.close().catch(() => undefined);
      await server.close().catch(() => undefined);
    }
  });

  return routes;
}

function buildProtectedResourceMetadata(config: AppConfig) {
  const baseUrl = (config.MCP_PUBLIC_BASE_URL ?? `http://127.0.0.1:${config.PORT}`).replace(/\/$/, "");
  const authorizationServers = config.SUPABASE_URL ? [`${config.SUPABASE_URL.replace(/\/$/, "")}/auth/v1`] : [];

  return {
    resource: `${baseUrl}/mcp`,
    authorization_servers: authorizationServers,
    bearer_methods_supported: ["header"],
    scopes_supported: ["openid", "offline_access"],
    resource_name: config.MCP_RESOURCE_NAME
  };
}

function unauthorizedMcp(
  c: { json: (body: unknown, status?: number) => Response; header: (name: string, value: string) => void },
  config: AppConfig,
  message = "Authorization bearer token is required."
) {
  const baseUrl = (config.MCP_PUBLIC_BASE_URL ?? `http://127.0.0.1:${config.PORT}`).replace(/\/$/, "");
  const resourceMetadata = `${baseUrl}/.well-known/oauth-protected-resource`;
  c.header(
    "WWW-Authenticate",
    `Bearer realm="family-os-mcp", resource_metadata="${resourceMetadata}", error="invalid_token"`
  );
  return c.json(
    {
      error: {
        code: "unauthorized",
        message
      }
    },
    401
  );
}
