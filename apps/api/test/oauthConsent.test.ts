import { SignJWT } from "jose";
import { describe, expect, it, vi } from "vitest";
import { createApp } from "../src/app";
import type { SupabaseOAuthClient } from "../src/oauth/supabaseOAuth";
import { createOAuthConsentRoutes } from "../src/routes/oauthConsent";
import { InMemoryFamilyRepository } from "../src/repositories/families";
import { Hono } from "hono";
import type { AppVariables } from "../src/auth";
import { loadConfig } from "../src/config";
import { HttpError, jsonError } from "../src/errors";

const jwtSecret = "test-supabase-jwt-secret-with-enough-length";
const supabaseUrl = "https://project.supabase.co";
const userId = "00000000-0000-4000-8000-000000004001";
const oauthClientId = "chatgpt-client-from-supabase";
const authorizationId = "authz-request-abc";

async function sessionJwt(subject: string) {
  return new SignJWT({
    role: "authenticated",
    email: `${subject}@example.com`
  })
    .setProtectedHeader({ alg: "HS256" })
    .setSubject(subject)
    .setIssuer(`${supabaseUrl}/auth/v1`)
    .setAudience("authenticated")
    .setIssuedAt()
    .setExpirationTime("1h")
    .sign(new TextEncoder().encode(jwtSecret));
}

function mockOAuthClient(overrides?: Partial<SupabaseOAuthClient>): SupabaseOAuthClient {
  return {
    getAuthorizationDetails: vi.fn(async () => ({
      authorization_id: authorizationId,
      client: { client_id: oauthClientId, client_name: "ChatGPT" },
      redirect_uri: "https://chatgpt.com/connector/oauth/callback",
      scope: "openid offline_access"
    })),
    approveAuthorization: vi.fn(async () => ({
      redirect_url: "https://chatgpt.com/connector/oauth/callback?code=abc"
    })),
    denyAuthorization: vi.fn(async () => ({
      redirect_url: "https://chatgpt.com/connector/oauth/callback?error=access_denied"
    })),
    ...overrides
  };
}

function consentApp(
  repo: InMemoryFamilyRepository,
  oauthClient: SupabaseOAuthClient,
  env: Record<string, unknown> = {}
) {
  const config = loadConfig({
    NODE_ENV: "test",
    PORT: 3001,
    SUPABASE_JWT_SECRET: jwtSecret,
    SUPABASE_URL: supabaseUrl,
    SUPABASE_ANON_KEY: "test-anon",
    MCP_PUBLIC_ORIGIN: "https://familyos.test.example",
    MCP_PUBLIC_PATH: "/api/mcp",
    MCP_CONSENT_VERSION: "2026-07-18",
    ...env
  });

  const app = new Hono<{ Variables: AppVariables }>();
  app.use("*", async (c, next) => {
    c.set("config", config);
    await next();
  });
  app.route(
    "/api/oauth",
    createOAuthConsentRoutes({
      config,
      mcpConnections: repo,
      oauthClient
    })
  );
  app.onError((error, c) => {
    if (error instanceof HttpError) {
      return jsonError(c, error);
    }
    throw error;
  });
  return app;
}

describe("OAuth consent", () => {
  it("serves the consent HTML page without auth", async () => {
    const api = createApp({
      config: {
        NODE_ENV: "test",
        PORT: 3001,
        SUPABASE_JWT_SECRET: jwtSecret,
        SUPABASE_URL: supabaseUrl,
        SUPABASE_ANON_KEY: "test-anon-key",
        MCP_PUBLIC_ORIGIN: "https://familyos.test.example"
      },
      familyRepository: new InMemoryFamilyRepository()
    });
    const response = await api.request(`/health/api/oauth/consent?authorization_id=${authorizationId}`);
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type") ?? "").toMatch(/text\/html/);
    const html = await response.text();
    expect(html).toContain("authorization_id");
    expect(html).toContain("SUPABASE_URL");
    expect(html).toContain('const OAUTH_PATH = "/health/api/oauth"');
    expect(html).toContain("Sign in to FamilyStack to continue");
    expect(html).toContain("Continue with Apple");
    expect(html).toContain('provider: "apple"');
    expect(html).toContain("FamilyStack health data");
    expect(html).toContain("steps, blood pressure, sleep, and workouts");
    expect(html).toContain("household members");
    expect(html).toContain("own privacy terms");
    expect(html).not.toContain("Family OS");
  });

  it("returns authorization details from Supabase, not from the browser body", async () => {
    const repo = new InMemoryFamilyRepository();
    const oauth = mockOAuthClient();
    const api = consentApp(repo, oauth);
    const token = await sessionJwt(userId);

    const response = await api.request(
      `/api/oauth/consent/details?authorization_id=${authorizationId}`,
      { headers: { authorization: `Bearer ${token}` } }
    );
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.data.client.clientId).toBe(oauthClientId);
    expect(body.data.client.clientName).toBe("ChatGPT");
    expect(oauth.getAuthorizationDetails).toHaveBeenCalledWith(token, authorizationId);
  });

  it("creates a Family OS grant from verified client_id on approve, then approves in Supabase", async () => {
    const repo = new InMemoryFamilyRepository();
    const oauth = mockOAuthClient();
    const api = consentApp(repo, oauth);
    const token = await sessionJwt(userId);

    const response = await api.request("/api/oauth/consent/decision", {
      method: "POST",
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json"
      },
      body: JSON.stringify({
        authorizationId,
        decision: "approve"
        // Intentionally no oauthClientId — must come from Supabase details
      })
    });
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.data.redirectUrl).toContain("code=abc");
    expect(body.data.oauthClientId).toBe(oauthClientId);

    const connections = await repo.listConnections(userId);
    expect(connections).toHaveLength(1);
    expect(connections[0]?.oauthClientId).toBe(oauthClientId);
    expect(connections[0]?.consentVersion).toBe("2026-07-18");
    expect(connections[0]?.revokedAt).toBeUndefined();

    expect(oauth.getAuthorizationDetails).toHaveBeenCalled();
    expect(oauth.approveAuthorization).toHaveBeenCalledWith(token, authorizationId);
    expect(oauth.denyAuthorization).not.toHaveBeenCalled();
  });

  it("denies without creating a grant", async () => {
    const repo = new InMemoryFamilyRepository();
    const oauth = mockOAuthClient();
    const api = consentApp(repo, oauth);
    const token = await sessionJwt(userId);

    const response = await api.request("/api/oauth/consent/decision", {
      method: "POST",
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json"
      },
      body: JSON.stringify({ authorizationId, decision: "deny" })
    });
    expect(response.status).toBe(200);
    expect((await response.json()).data.decision).toBe("deny");
    expect(await repo.listConnections(userId)).toHaveLength(0);
    expect(oauth.denyAuthorization).toHaveBeenCalledWith(token, authorizationId);
    expect(oauth.approveAuthorization).not.toHaveBeenCalled();
  });

  it("rejects approve when Supabase details omit client_id", async () => {
    const repo = new InMemoryFamilyRepository();
    const oauth = mockOAuthClient({
      getAuthorizationDetails: vi.fn(async () => ({
        authorization_id: authorizationId,
        client: { client_id: "" }
      }))
    });
    const api = consentApp(repo, oauth);
    const token = await sessionJwt(userId);

    const response = await api.request("/api/oauth/consent/decision", {
      method: "POST",
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json"
      },
      body: JSON.stringify({ authorizationId, decision: "approve" })
    });
    expect(response.status).toBe(400);
    expect(await repo.listConnections(userId)).toHaveLength(0);
  });

  it("rejects approve when OAuth client is not on the MCP allowlist", async () => {
    const repo = new InMemoryFamilyRepository();
    const oauth = mockOAuthClient();
    const api = consentApp(repo, oauth, {
      MCP_ALLOWED_OAUTH_CLIENT_IDS: "only-this-client,another-allowed"
    });
    const token = await sessionJwt(userId);

    const response = await api.request("/api/oauth/consent/decision", {
      method: "POST",
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json"
      },
      body: JSON.stringify({ authorizationId, decision: "approve" })
    });
    expect(response.status).toBe(403);
    const body = await response.json();
    expect(body.error.code).toBe("oauth_client_not_allowed");
    expect(await repo.listConnections(userId)).toHaveLength(0);
    expect(oauth.approveAuthorization).not.toHaveBeenCalled();
  });

  it("allows approve when OAuth client is on the MCP allowlist", async () => {
    const repo = new InMemoryFamilyRepository();
    const oauth = mockOAuthClient();
    const api = consentApp(repo, oauth, {
      MCP_ALLOWED_OAUTH_CLIENT_IDS: `${oauthClientId},other-client`
    });
    const token = await sessionJwt(userId);

    const response = await api.request("/api/oauth/consent/decision", {
      method: "POST",
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json"
      },
      body: JSON.stringify({ authorizationId, decision: "approve" })
    });
    expect(response.status).toBe(200);
    expect(await repo.listConnections(userId)).toHaveLength(1);
    expect(oauth.approveAuthorization).toHaveBeenCalled();
  });

  it("revokes the Family OS grant when Supabase approveAuthorization fails", async () => {
    const repo = new InMemoryFamilyRepository();
    const oauth = mockOAuthClient({
      approveAuthorization: vi.fn(async () => {
        throw new HttpError(400, "oauth_authorization_error", "Supabase approval failed.");
      })
    });
    const api = consentApp(repo, oauth);
    const token = await sessionJwt(userId);

    const response = await api.request("/api/oauth/consent/decision", {
      method: "POST",
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json"
      },
      body: JSON.stringify({ authorizationId, decision: "approve" })
    });
    expect(response.status).toBe(400);
    const connections = await repo.listConnections(userId);
    expect(connections).toHaveLength(1);
    expect(connections[0]?.revokedAt).toBeDefined();
    expect(await repo.getActiveConnection(userId, oauthClientId)).toBeNull();
    expect(oauth.approveAuthorization).toHaveBeenCalledWith(token, authorizationId);
  });
});
