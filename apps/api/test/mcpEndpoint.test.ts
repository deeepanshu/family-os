import { SignJWT } from "jose";
import { describe, expect, it } from "vitest";
import { HEALTH_API_PREFIX } from "@family-os/shared";
import { createApp } from "../src/app";
import { InMemoryFamilyRepository } from "../src/repositories/families";

const jwtSecret = "test-supabase-jwt-secret-with-enough-length";
const supabaseUrl = "https://project.supabase.co";
const userId = "00000000-0000-4000-8000-000000003001";
const otherUserId = "00000000-0000-4000-8000-000000003002";
const oauthClientId = "chatgpt-staging";
const mcpOrigin = "https://familyos.test.example";
const mcpPath = "/api/mcp";
const mcpResource = `${mcpOrigin}${mcpPath}`;
const mcpMetadata = `${mcpOrigin}/.well-known/oauth-protected-resource${mcpPath}`;

function app(repo = new InMemoryFamilyRepository()) {
  return {
    api: createApp({
      config: {
        NODE_ENV: "test",
        PORT: 3001,
        HEALTH_API_ENABLE_DEV_AUTH: false,
        SUPABASE_JWT_SECRET: jwtSecret,
        SUPABASE_URL: supabaseUrl,
        SUPABASE_ANON_KEY: "test-anon-key",
        MCP_PUBLIC_ORIGIN: mcpOrigin,
        MCP_PUBLIC_PATH: mcpPath,
        MCP_RESOURCE_NAME: "Family OS Health MCP"
      },
      familyRepository: repo
    }),
    repo
  };
}

async function jwtFor(subject: string, options?: { clientId?: string; audience?: string }) {
  return new SignJWT({
    role: "authenticated",
    email: `${subject}@example.com`,
    client_id: options?.clientId ?? oauthClientId
  })
    .setProtectedHeader({ alg: "HS256" })
    .setSubject(subject)
    .setIssuer(`${supabaseUrl}/auth/v1`)
    .setAudience(options?.audience ?? mcpResource)
    .setIssuedAt()
    .setExpirationTime("1h")
    .sign(new TextEncoder().encode(jwtSecret));
}

async function healthJwt(subject: string) {
  return jwtFor(subject, { audience: "authenticated" });
}

async function seedWithSteps(repo: InMemoryFamilyRepository, subject: string) {
  const { api } = app(repo);
  const token = await healthJwt(subject);
  await api.request(`${HEALTH_API_PREFIX}/bootstrap`, {
    method: "POST",
    headers: { authorization: `Bearer ${token}` }
  });
  const profile = await (
    await api.request(`${HEALTH_API_PREFIX}/me/profile`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({ displayName: "Deepanshu" })
    })
  ).json();
  const profileId = profile.data.id as string;

  await api.request(`${HEALTH_API_PREFIX}/healthkit/link-profile`, {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify({ personId: profileId })
  });
  await api.request(`${HEALTH_API_PREFIX}/healthkit/sync/settings`, {
    method: "PATCH",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify({ enabledMetrics: ["steps", "sleep", "blood_pressure"] })
  });
  await api.request(`${HEALTH_API_PREFIX}/healthkit/samples/batch`, {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify({
      samples: [
        {
          metricType: "steps",
          sourceSampleKey: "steps-1",
          startDate: "2026-07-15T08:00:00.000Z",
          endDate: "2026-07-15T09:00:00.000Z",
          value: 2500,
          unit: "count"
        }
      ]
    })
  });

  return { token, profileId };
}

async function grantConnection(repo: InMemoryFamilyRepository, subject: string) {
  return repo.createConnection({
    userId: subject,
    oauthClientId,
    capabilities: ["health_read"],
    consentVersion: "2026-07-18"
  });
}

async function mcpRpc(api: ReturnType<typeof createApp>, token: string, body: unknown) {
  return api.request(mcpPath, {
    method: "POST",
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
      accept: "application/json, text/event-stream"
    },
    body: JSON.stringify(body)
  });
}

async function parseJsonRpc(response: Response) {
  const contentType = response.headers.get("content-type") ?? "";
  const text = await response.text();
  if (contentType.includes("text/event-stream")) {
    const dataLines = text
      .split("\n")
      .filter((line) => line.startsWith("data:"))
      .map((line) => line.slice(5).trim())
      .filter(Boolean);
    const last = dataLines.at(-1);
    if (!last) {
      throw new Error(`No SSE data in response: ${text}`);
    }
    return JSON.parse(last);
  }
  return JSON.parse(text);
}

describe("MCP endpoint", () => {
  it("exposes protected resource metadata at the path-inserted well-known URL", async () => {
    const { api } = app();
    const primary = await api.request(`/.well-known/oauth-protected-resource${mcpPath}`);
    expect(primary.status).toBe(200);
    const body = await primary.json();
    expect(body.resource).toBe(mcpResource);
    expect(body.authorization_servers).toEqual([`${supabaseUrl}/auth/v1`]);
    expect(body.bearer_methods_supported).toEqual(["header"]);

    const root = await api.request("/.well-known/oauth-protected-resource");
    expect(root.status).toBe(200);
    expect((await root.json()).resource).toBe(mcpResource);
  });

  it("exposes MCP healthcheck without auth at the public MCP path", async () => {
    const { api } = app();
    const response = await api.request(`${mcpPath}/healthcheck`);
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.data).toEqual({ service: "family-os-mcp", status: "ok" });
  });

  it("rejects unauthenticated MCP calls with WWW-Authenticate resource_metadata", async () => {
    const { api } = app();
    const response = await api.request(mcpPath, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} })
    });
    expect(response.status).toBe(401);
    const www = response.headers.get("www-authenticate") ?? "";
    expect(www).toContain("resource_metadata=");
    expect(www).toContain(mcpMetadata);
  });

  it("rejects Supabase session tokens that are not audience-bound to the MCP resource", async () => {
    const repo = new InMemoryFamilyRepository();
    await seedWithSteps(repo, userId);
    await grantConnection(repo, userId);
    const { api } = app(repo);

    const sessionToken = await healthJwt(userId);
    const response = await mcpRpc(api, sessionToken, {
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2025-03-26",
        capabilities: {},
        clientInfo: { name: "family-os-test", version: "0.0.1" }
      }
    });
    expect(response.status).toBe(401);
  });

  it("creates connection grants through the repository and discovers tools", async () => {
    const repo = new InMemoryFamilyRepository();
    await seedWithSteps(repo, userId);
    await grantConnection(repo, userId);
    const { api } = app(repo);
    const mcpToken = await jwtFor(userId);

    const listed = await mcpRpc(api, mcpToken, {
      jsonrpc: "2.0",
      id: 2,
      method: "tools/list",
      params: {}
    });
    expect(listed.status).toBe(200);
    const body = await parseJsonRpc(listed);
    const names = (body.result?.tools ?? []).map((tool: { name: string }) => tool.name).sort();
    expect(names).toEqual(["family_os.get_health_data", "family_os.list_authorized_profiles"]);
  });

  it("calls get_health_data for an authorized profile through the MCP endpoint", async () => {
    const repo = new InMemoryFamilyRepository();
    const { profileId } = await seedWithSteps(repo, userId);
    await grantConnection(repo, userId);
    const { api } = app(repo);
    const mcpToken = await jwtFor(userId);

    const response = await mcpRpc(api, mcpToken, {
      jsonrpc: "2.0",
      id: 3,
      method: "tools/call",
      params: {
        name: "family_os.get_health_data",
        arguments: {
          personId: profileId,
          healthMetric: "steps",
          rangeDays: 30,
          granularity: "daily",
          timezone: "UTC"
        }
      }
    });
    expect(response.status).toBe(200);
    const body = await parseJsonRpc(response);
    expect(body.result?.isError).not.toBe(true);
    const text = body.result?.content?.[0]?.text;
    expect(typeof text).toBe("string");
    const payload = JSON.parse(text);
    expect(payload.viewType).toBe("daily_series");
    expect(payload.healthMetric).toBe("steps");
    expect(payload.points.find((p: { bucket: string; value: number }) => p.bucket === "2026-07-15")?.value).toBe(2500);
    expect(payload.lastSyncedAt).toBeTruthy();
  });

  it("returns a safe tool error for another family's profile", async () => {
    const repo = new InMemoryFamilyRepository();
    await seedWithSteps(repo, userId);
    const { profileId: otherProfileId } = await seedWithSteps(repo, otherUserId);
    await grantConnection(repo, userId);
    const { api } = app(repo);
    const mcpToken = await jwtFor(userId);

    const response = await mcpRpc(api, mcpToken, {
      jsonrpc: "2.0",
      id: 4,
      method: "tools/call",
      params: {
        name: "family_os.get_health_data",
        arguments: {
          personId: otherProfileId,
          healthMetric: "steps",
          rangeDays: 30
        }
      }
    });
    expect(response.status).toBe(200);
    const body = await parseJsonRpc(response);
    expect(body.result?.isError).toBe(true);
    const message = body.result?.content?.[0]?.text ?? "";
    expect(message.toLowerCase()).toContain("not authorized");
    expect(message).not.toMatch(/stack|postgres|SELECT/i);
  });

  it("rejects invalid tool parameters before returning data", async () => {
    const repo = new InMemoryFamilyRepository();
    const { profileId } = await seedWithSteps(repo, userId);
    await grantConnection(repo, userId);
    const { api } = app(repo);
    const mcpToken = await jwtFor(userId);

    const response = await mcpRpc(api, mcpToken, {
      jsonrpc: "2.0",
      id: 5,
      method: "tools/call",
      params: {
        name: "family_os.get_health_data",
        arguments: {
          personId: profileId,
          healthMetric: "export.xml",
          rangeDays: 30
        }
      }
    });
    expect(response.status).toBe(200);
    const body = await parseJsonRpc(response);
    expect(body.error || body.result?.isError).toBeTruthy();
  });

  it("blocks tool calls after connection revocation via the API", async () => {
    const repo = new InMemoryFamilyRepository();
    const { token: healthToken, profileId } = await seedWithSteps(repo, userId);
    const connection = await grantConnection(repo, userId);
    const { api } = app(repo);

    await api.request(`${HEALTH_API_PREFIX}/mcp/connections/${connection.id}`, {
      method: "DELETE",
      headers: { authorization: `Bearer ${healthToken}` }
    });

    const mcpToken = await jwtFor(userId);
    const response = await mcpRpc(api, mcpToken, {
      jsonrpc: "2.0",
      id: 6,
      method: "tools/call",
      params: {
        name: "family_os.get_health_data",
        arguments: { personId: profileId, healthMetric: "steps", rangeDays: 7 }
      }
    });
    const body = await parseJsonRpc(response);
    expect(body.result?.isError).toBe(true);
    expect(body.result?.content?.[0]?.text).toMatch(/connection/i);
  });

  it("does not accept browser-supplied oauthClientId for connection creation", async () => {
    const repo = new InMemoryFamilyRepository();
    const { token: healthToken } = await seedWithSteps(repo, userId);
    const { api } = app(repo);
    const response = await api.request(`${HEALTH_API_PREFIX}/mcp/connections`, {
      method: "POST",
      headers: { authorization: `Bearer ${healthToken}`, "content-type": "application/json" },
      body: JSON.stringify({ oauthClientId: "forged-client", consentVersion: "2026-07-18" })
    });
    expect(response.status).toBe(404);
  });
});
