import { zValidator } from "@hono/zod-validator";
import { Hono } from "hono";
import { z } from "zod";
import { extractBearerToken, requireAuth, type AppVariables } from "../auth";
import { isMcpOAuthClientAllowed, type AppConfig } from "../config";
import { HttpError } from "../errors";
import { renderOAuthConsentPage } from "../oauth/consentPageHtml";
import {
  createSupabaseOAuthClient,
  type SupabaseOAuthClient
} from "../oauth/supabaseOAuth";
import type { McpConnectionStore } from "../repositories/contracts";

const decisionBody = z.object({
  authorizationId: z.string().trim().min(1).max(200),
  decision: z.enum(["approve", "deny"])
});

export type OAuthConsentRouteDeps = {
  config: AppConfig;
  mcpConnections: McpConnectionStore;
  oauthClient?: SupabaseOAuthClient;
};

/**
 * Supabase OAuth 2.1 consent surface.
 *
 * - GET  /consent                 HTML consent UI (authorization_id query param)
 * - GET  /consent/details         Load verified authorization details
 * - POST /consent/decision        Create Family OS grant (approve) then approve/deny in Supabase
 *
 * The OAuth client ID is always taken from Supabase authorization details, never from the browser body.
 * Optional MCP_ALLOWED_OAUTH_CLIENT_IDS may further restrict which clients can receive a grant;
 * when empty, any client the user consents to is allowed (DCR-friendly).
 */
export function createOAuthConsentRoutes(deps: OAuthConsentRouteDeps) {
  const routes = new Hono<{ Variables: AppVariables }>();

  function oauth(): SupabaseOAuthClient {
    return deps.oauthClient ?? createSupabaseOAuthClient(deps.config);
  }

  routes.get("/consent", (c) => {
    return c.html(renderOAuthConsentPage(deps.config));
  });

  routes.get("/consent/details", requireAuth(), async (c) => {
    const authorizationId = c.req.query("authorization_id")?.trim();
    if (!authorizationId) {
      throw new HttpError(400, "missing_authorization_id", "authorization_id query parameter is required.");
    }

    const accessToken = requireAccessToken(c.req.header("authorization"));
    const details = await oauth().getAuthorizationDetails(accessToken, authorizationId);

    if (details.redirect_url && !details.client.client_id) {
      return c.json({
        data: {
          redirectUrl: details.redirect_url,
          client: null
        }
      });
    }

    const oauthClientId = details.client.client_id?.trim();
    if (oauthClientId) {
      assertMcpOAuthClientAllowed(deps.config, oauthClientId);
    }

    return c.json({
      data: {
        authorizationId: details.authorization_id,
        client: {
          clientId: details.client.client_id,
          clientName: details.client.client_name ?? details.client.client_id
        },
        redirectUri: details.redirect_uri,
        scope: details.scope,
        redirectUrl: details.redirect_url
      }
    });
  });

  routes.post("/consent/decision", requireAuth(), zValidator("json", decisionBody), async (c) => {
    const body = c.req.valid("json");
    const user = c.get("user");
    const accessToken = requireAccessToken(c.req.header("authorization"));

    if (body.decision === "deny") {
      const result = await oauth().denyAuthorization(accessToken, body.authorizationId);
      return c.json({ data: { redirectUrl: result.redirect_url, decision: "deny" as const } });
    }

    // Approve path: derive client_id from the verified Supabase authorization request only.
    const details = await oauth().getAuthorizationDetails(accessToken, body.authorizationId);
    if (details.redirect_url && !details.client.client_id) {
      return c.json({
        data: { redirectUrl: details.redirect_url, decision: "approve" as const, alreadyAuthorized: true }
      });
    }

    const oauthClientId = details.client.client_id?.trim();
    if (!oauthClientId) {
      throw new HttpError(
        400,
        "oauth_client_missing",
        "Could not determine OAuth client ID from the authorization request."
      );
    }

    assertMcpOAuthClientAllowed(deps.config, oauthClientId);

    // Create the Family OS grant before Supabase approval so the client has access
    // as soon as it exchanges the code. If Supabase approval fails, revoke immediately
    // so a still-valid prior token for a previously revoked client is not re-enabled.
    const connection = await deps.mcpConnections.createConnection({
      userId: user.id,
      oauthClientId,
      capabilities: ["health_read"],
      consentVersion: deps.config.MCP_CONSENT_VERSION
    });

    try {
      const result = await oauth().approveAuthorization(accessToken, body.authorizationId);
      return c.json({
        data: {
          redirectUrl: result.redirect_url,
          decision: "approve" as const,
          oauthClientId
        }
      });
    } catch (error) {
      try {
        await deps.mcpConnections.revokeConnection(user.id, connection.id);
      } catch {
        // Best-effort rollback; surface the original approval failure.
      }
      throw error;
    }
  });

  return routes;
}

function assertMcpOAuthClientAllowed(config: AppConfig, oauthClientId: string): void {
  if (isMcpOAuthClientAllowed(config, oauthClientId)) {
    return;
  }
  throw new HttpError(
    403,
    "oauth_client_not_allowed",
    "This OAuth client is not allowlisted for Family OS MCP health access."
  );
}

function requireAccessToken(authorizationHeader: string | undefined): string {
  const token = extractBearerToken(authorizationHeader);
  if (!token) {
    throw new HttpError(401, "missing_authorization", "Authorization bearer token is required.");
  }
  // Reject the local dev bypass token for Supabase OAuth calls.
  if (token === "dev-token") {
    throw new HttpError(
      401,
      "invalid_token",
      "OAuth consent requires a real Supabase session token, not the local dev-token bypass."
    );
  }
  return token;
}
