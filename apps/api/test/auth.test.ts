import { SignJWT } from "jose";
import { afterEach, describe, expect, it, vi } from "vitest";
import { HEALTH_API_PREFIX } from "@family-os/shared";
import { configureOtelLogs, flushOtelLogs, _resetOtelLogsForTests } from "../src/logging/otelLogs";
import { createApp } from "../src/app";
import { InMemoryFamilyRepository } from "../src/repositories/families";

afterEach(() => {
  _resetOtelLogsForTests();
  vi.unstubAllGlobals();
});

const testUserId = "00000000-0000-4000-8000-000000000001";
const jwtSecret = "test-supabase-jwt-secret-with-enough-length";

function app(corsOrigin?: string) {
  return createApp({
    config: {
      NODE_ENV: "test",
      PORT: 3001,
      HEALTH_API_ENABLE_DEV_AUTH: false,
      SUPABASE_JWT_SECRET: jwtSecret,
      SUPABASE_URL: "https://project.supabase.co",
      ...(corsOrigin ? { HEALTH_API_CORS_ORIGIN: corsOrigin } : {})
    }
  });
}

async function jwtFor(
  userId: string | undefined,
  options: { role?: string; audience?: string; issuer?: string; secret?: string } = {}
) {
  return new SignJWT({
    email: "user@example.com",
    role: options.role ?? "authenticated"
  })
    .setProtectedHeader({ alg: "HS256" })
    .setAudience(options.audience ?? "authenticated")
    .setIssuer(options.issuer ?? "https://project.supabase.co/auth/v1")
    .setSubject(userId ?? "")
    .setIssuedAt()
    .setExpirationTime("1h")
    .sign(new TextEncoder().encode(options.secret ?? jwtSecret));
}

describe("health API bootstrap", () => {
  it("serves a public healthcheck under the health prefix", async () => {
    const response = await app().request(`${HEALTH_API_PREFIX}/healthcheck`);

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      data: {
        service: "family-os-health-api",
        status: "ok"
      }
    });
  });

  it("does not enable CORS without an allowed origin", async () => {
    const response = await app().request(`${HEALTH_API_PREFIX}/families`, {
      method: "OPTIONS",
      headers: {
        origin: "https://console.familyos.test",
        "access-control-request-method": "POST"
      }
    });

    expect(response.headers.get("access-control-allow-origin")).toBeNull();
  });

  it("returns CORS headers for the configured origin", async () => {
    const response = await app("https://console.familyos.test").request(`${HEALTH_API_PREFIX}/families`, {
      method: "OPTIONS",
      headers: {
        origin: "https://console.familyos.test",
        "access-control-request-method": "POST",
        "access-control-request-headers": "authorization,content-type"
      }
    });

    expect(response.status).toBe(204);
    expect(response.headers.get("access-control-allow-origin")).toBe("https://console.familyos.test");
    expect(response.headers.get("access-control-allow-methods")).toContain("POST");
    expect(response.headers.get("access-control-allow-headers")).toContain("authorization");
  });

  it("echoes a request id on API responses", async () => {
    const response = await app().request(`${HEALTH_API_PREFIX}/healthcheck`, {
      headers: {
        "x-request-id": "test-request-id"
      }
    });

    expect(response.status).toBe(200);
    expect(response.headers.get("x-request-id")).toBe("test-request-id");
  });

  it("rate limits write requests by bearer token", async () => {
    const responseOne = await createApp({
      config: {
        NODE_ENV: "test",
        PORT: 3001,
        HEALTH_API_ENABLE_DEV_AUTH: true,
        HEALTH_API_DEV_AUTH_USER_ID: testUserId,
        HEALTH_API_RATE_LIMIT_MAX_WRITES: 1
      }
    }).request(`${HEALTH_API_PREFIX}/families`, {
      method: "POST",
      headers: {
        authorization: "Bearer dev-token",
        "content-type": "application/json"
      },
      body: JSON.stringify({ name: "Jain Family" })
    });

    const appWithRateLimit = createApp({
      config: {
        NODE_ENV: "test",
        PORT: 3001,
        HEALTH_API_ENABLE_DEV_AUTH: true,
        HEALTH_API_DEV_AUTH_USER_ID: testUserId,
        HEALTH_API_RATE_LIMIT_MAX_WRITES: 1
      }
    });
    await appWithRateLimit.request(`${HEALTH_API_PREFIX}/families`, {
      method: "POST",
      headers: {
        authorization: "Bearer dev-token",
        "content-type": "application/json"
      },
      body: JSON.stringify({ name: "Jain Family" })
    });
    const responseTwo = await appWithRateLimit.request(`${HEALTH_API_PREFIX}/families`, {
      method: "POST",
      headers: {
        authorization: "Bearer dev-token",
        "content-type": "application/json"
      },
      body: JSON.stringify({ name: "Jain Family" })
    });

    expect(responseOne.status).toBe(201);
    expect(responseTwo.status).toBe(429);
    expect(responseTwo.headers.get("retry-after")).toBeTruthy();
    await expect(responseTwo.json()).resolves.toMatchObject({
      error: {
        code: "rate_limited"
      }
    });
  });

  it("normalizes bearer scheme and whitespace for rate-limit keys", async () => {
    const appWithRateLimit = createApp({
      config: {
        NODE_ENV: "test",
        PORT: 3001,
        HEALTH_API_ENABLE_DEV_AUTH: true,
        HEALTH_API_DEV_AUTH_USER_ID: testUserId,
        HEALTH_API_RATE_LIMIT_MAX_WRITES: 1
      }
    });
    await appWithRateLimit.request(`${HEALTH_API_PREFIX}/families`, {
      method: "POST",
      headers: {
        authorization: "Bearer dev-token",
        "content-type": "application/json"
      },
      body: JSON.stringify({ name: "Jain Family" })
    });
    const response = await appWithRateLimit.request(`${HEALTH_API_PREFIX}/families`, {
      method: "POST",
      headers: {
        authorization: "bearer   dev-token",
        "content-type": "application/json"
      },
      body: JSON.stringify({ name: "Jain Family" })
    });

    expect(response.status).toBe(429);
  });

  it("rejects protected API requests without a bearer token", async () => {
    const response = await app().request(`${HEALTH_API_PREFIX}/me`);

    expect(response.status).toBe(401);
    await expect(response.json()).resolves.toMatchObject({
      error: {
        code: "missing_authorization"
      }
    });
  });

  it("returns the Supabase JWT subject for authenticated requests", async () => {
    const token = await jwtFor(testUserId);
    const response = await app().request(`${HEALTH_API_PREFIX}/me`, {
      headers: {
        authorization: `Bearer ${token}`
      }
    });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      data: {
        userId: testUserId
      }
    });
  });

  it("rejects invalid JWT signatures", async () => {
    const token = await jwtFor(testUserId, { secret: "wrong-secret" });
    const response = await app().request(`${HEALTH_API_PREFIX}/me`, {
      headers: {
        authorization: `Bearer ${token}`
      }
    });

    expect(response.status).toBe(401);
    await expect(response.json()).resolves.toMatchObject({
      error: {
        code: "invalid_token"
      }
    });
  });

  it("exports JWT verification failures through the OTEL logger", async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, status: 200 });
    vi.stubGlobal("fetch", fetchMock);
    configureOtelLogs({
      endpoint: "http://otel-collector:4318",
      serviceName: "family-os-health-api",
      environment: "prod",
      enabled: true
    });

    const token = await jwtFor(testUserId, { secret: "wrong-secret" });
    const response = await app().request(`${HEALTH_API_PREFIX}/me`, {
      headers: {
        authorization: `Bearer ${token}`
      }
    });

    expect(response.status).toBe(401);
    await flushOtelLogs();

    const [, init] = fetchMock.mock.calls.at(-1) as [string, RequestInit];
    const body = JSON.parse(String(init.body));
    const record = body.resourceLogs[0].scopeLogs[0].logRecords[0];
    expect(record.body.stringValue).toBe("auth_token_verification_failed");
    expect(record.attributes).toEqual(
      expect.arrayContaining([
        { key: "alg", value: { stringValue: "HS256" } },
        { key: "kid", value: { stringValue: "missing" } },
        { key: "aud", value: { stringValue: "authenticated" } }
      ])
    );
  });

  it("rejects JWTs without a Supabase subject", async () => {
    const token = await jwtFor(undefined);
    const response = await app().request(`${HEALTH_API_PREFIX}/me`, {
      headers: {
        authorization: `Bearer ${token}`
      }
    });

    expect(response.status).toBe(401);
    await expect(response.json()).resolves.toMatchObject({
      error: {
        code: "invalid_token"
      }
    });
  });

  it("rejects JWTs without the authenticated Supabase role", async () => {
    const token = await jwtFor(testUserId, { role: "anon" });
    const response = await app().request(`${HEALTH_API_PREFIX}/me`, {
      headers: {
        authorization: `Bearer ${token}`
      }
    });

    expect(response.status).toBe(401);
    await expect(response.json()).resolves.toMatchObject({
      error: {
        code: "invalid_token"
      }
    });
  });

  it("fails closed when Supabase JWT verification is not configured", async () => {
    const response = await createApp({
      config: {
        NODE_ENV: "test",
        PORT: 3001,
        HEALTH_API_ENABLE_DEV_AUTH: false
      }
    }).request(`${HEALTH_API_PREFIX}/me`, {
      headers: {
        authorization: `Bearer ${await jwtFor(testUserId)}`
      }
    });

    expect(response.status).toBe(500);
    await expect(response.json()).resolves.toMatchObject({
      error: {
        code: "auth_not_configured"
      }
    });
  });

  it("supports an explicit non-production dev token for local iOS smoke tests", async () => {
    const response = await createApp({
      config: {
        NODE_ENV: "test",
        PORT: 3001,
        HEALTH_API_ENABLE_DEV_AUTH: true,
        HEALTH_API_DEV_AUTH_USER_ID: testUserId
      }
    }).request(`${HEALTH_API_PREFIX}/me`, {
      headers: {
        authorization: "Bearer dev-token"
      }
    });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      data: {
        userId: testUserId
      }
    });
  });

  it("does not allow the dev token unless explicitly enabled", async () => {
    const response = await createApp({
      config: {
        NODE_ENV: "test",
        PORT: 3001,
        HEALTH_API_ENABLE_DEV_AUTH: false,
        HEALTH_API_DEV_AUTH_USER_ID: testUserId,
        SUPABASE_JWT_SECRET: jwtSecret
      }
    }).request(`${HEALTH_API_PREFIX}/me`, {
      headers: {
        authorization: "Bearer dev-token"
      }
    });

    expect(response.status).toBe(401);
  });

  it("does not allow the dev token in production", async () => {
    const response = await createApp({
      config: {
        NODE_ENV: "production",
        PORT: 3001,
        DATABASE_URL: "postgres://example",
        HEALTH_API_ENABLE_DEV_AUTH: true,
        HEALTH_API_DEV_AUTH_USER_ID: testUserId,
        SUPABASE_JWT_SECRET: jwtSecret,
        SUPABASE_URL: "https://project.supabase.co",
        MCP_PUBLIC_ORIGIN: "https://familyos.deepanshujain.me",
        SUPABASE_ANON_KEY: "test-anon-key",
        SUPABASE_SERVICE_ROLE_KEY: "service-role-key",
      },
      familyRepository: new InMemoryFamilyRepository()
    }).request(`${HEALTH_API_PREFIX}/me`, {
      headers: {
        authorization: "Bearer dev-token"
      }
    });

    expect(response.status).toBe(401);
  });
});
