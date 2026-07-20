import { describe, expect, it } from "vitest";
import { loadConfig } from "../src/config";

describe("configuration", () => {
  it("treats blank env placeholders as unset values", () => {
    expect(
      loadConfig({
        NODE_ENV: "",
        PORT: "",
        DATABASE_URL: "postgres://family_os:family_os@localhost:5432/family_os",
        SUPABASE_URL: "",
        SUPABASE_ANON_KEY: "",
        SUPABASE_JWT_SECRET: "",
        HEALTH_API_ENABLE_DEV_AUTH: "",
        HEALTH_API_DEV_AUTH_USER_ID: "",
        HEALTH_API_REPOSITORY: ""
      })
    ).toMatchObject({
      NODE_ENV: "development",
      PORT: 3001,
      HEALTH_API_REPOSITORY: "postgres",
      HEALTH_API_SYNC_LOCAL_AUTH_USERS: true,
      HEALTH_API_ENABLE_DEV_AUTH: false,
      HEALTH_API_CORS_ORIGIN: "*",
      HEALTH_API_RATE_LIMIT_WINDOW_MS: 60_000,
      HEALTH_API_RATE_LIMIT_MAX_WRITES: 120,
      HEALTH_API_RATE_LIMIT_MAX_BUCKETS: 10_000
    });
  });

  it("uses memory by default in tests", () => {
    expect(loadConfig({ NODE_ENV: "test" })).toMatchObject({
      HEALTH_API_REPOSITORY: "memory",
      HEALTH_API_SYNC_LOCAL_AUTH_USERS: false
    });
  });

  it("requires an explicit CORS origin in production", () => {
    expect(() => loadConfig({ NODE_ENV: "production" })).toThrow(
      "HEALTH_API_CORS_ORIGIN must be configured in production."
    );
  });

  it("rejects memory repository in production", () => {
    expect(() =>
      loadConfig({
        NODE_ENV: "production",
        HEALTH_API_REPOSITORY: "memory",
        HEALTH_API_CORS_ORIGIN: "https://app.deepanshujain.com",
        MCP_PUBLIC_ORIGIN: "https://familyos.deepanshujain.me",
        SUPABASE_URL: "https://project.supabase.co",
        SUPABASE_ANON_KEY: "anon-key",
        MCP_ALLOWED_OAUTH_CLIENT_IDS: "chatgpt-prod"
      })
    ).toThrow("HEALTH_API_REPOSITORY=memory is not allowed in production.");
  });

  it("requires MCP public origin, Supabase URL, anon key, and OAuth client allowlist in production", () => {
    expect(() =>
      loadConfig({
        NODE_ENV: "production",
        HEALTH_API_CORS_ORIGIN: "https://app.deepanshujain.com",
        DATABASE_URL: "postgres://family_os:family_os@localhost:5432/family_os",
        SUPABASE_URL: "https://project.supabase.co",
        SUPABASE_ANON_KEY: "anon-key"
      })
    ).toThrow("MCP_PUBLIC_ORIGIN must be configured in production.");

    expect(() =>
      loadConfig({
        NODE_ENV: "production",
        HEALTH_API_CORS_ORIGIN: "https://app.deepanshujain.com",
        DATABASE_URL: "postgres://family_os:family_os@localhost:5432/family_os",
        MCP_PUBLIC_ORIGIN: "https://familyos.deepanshujain.me",
        SUPABASE_ANON_KEY: "anon-key",
        MCP_ALLOWED_OAUTH_CLIENT_IDS: "chatgpt-prod"
      })
    ).toThrow("SUPABASE_URL must be configured in production.");

    expect(() =>
      loadConfig({
        NODE_ENV: "production",
        HEALTH_API_CORS_ORIGIN: "https://app.deepanshujain.com",
        DATABASE_URL: "postgres://family_os:family_os@localhost:5432/family_os",
        MCP_PUBLIC_ORIGIN: "https://familyos.deepanshujain.me",
        SUPABASE_URL: "https://project.supabase.co",
        MCP_ALLOWED_OAUTH_CLIENT_IDS: "chatgpt-prod"
      })
    ).toThrow("SUPABASE_ANON_KEY must be configured in production");

    expect(() =>
      loadConfig({
        NODE_ENV: "production",
        HEALTH_API_CORS_ORIGIN: "https://app.deepanshujain.com",
        DATABASE_URL: "postgres://family_os:family_os@localhost:5432/family_os",
        MCP_PUBLIC_ORIGIN: "https://familyos.deepanshujain.me",
        SUPABASE_URL: "https://project.supabase.co",
        SUPABASE_ANON_KEY: "anon-key"
      })
    ).toThrow("MCP_ALLOWED_OAUTH_CLIENT_IDS must be configured in production");
  });

  it("normalizes MCP public path and accepts legacy MCP_PUBLIC_BASE_URL as origin", () => {
    const fromOrigin = loadConfig({
      NODE_ENV: "test",
      MCP_PUBLIC_ORIGIN: "https://familyos.deepanshujain.me/",
      MCP_PUBLIC_PATH: "api/mcp/"
    });
    expect(fromOrigin.MCP_PUBLIC_ORIGIN).toBe("https://familyos.deepanshujain.me");
    expect(fromOrigin.MCP_PUBLIC_PATH).toBe("/api/mcp");

    const fromLegacy = loadConfig({
      NODE_ENV: "test",
      MCP_PUBLIC_BASE_URL: "https://familyos.deepanshujain.me"
    });
    expect(fromLegacy.MCP_PUBLIC_ORIGIN).toBe("https://familyos.deepanshujain.me");
    expect(fromLegacy.MCP_PUBLIC_PATH).toBe("/api/mcp");
  });

  it("rejects MCP_PUBLIC_ORIGIN values that include a path, query, or fragment", () => {
    expect(() =>
      loadConfig({
        NODE_ENV: "test",
        MCP_PUBLIC_ORIGIN: "https://familyos.deepanshujain.me/api"
      })
    ).toThrow(/origin only/);

    expect(() =>
      loadConfig({
        NODE_ENV: "test",
        MCP_PUBLIC_ORIGIN: "https://familyos.deepanshujain.me?x=1"
      })
    ).toThrow(/query/);

    expect(() =>
      loadConfig({
        NODE_ENV: "test",
        MCP_PUBLIC_ORIGIN: "https://familyos.deepanshujain.me#frag"
      })
    ).toThrow(/fragment/);
  });

  it("parses MCP OAuth client allowlist", () => {
    const config = loadConfig({
      NODE_ENV: "test",
      MCP_ALLOWED_OAUTH_CLIENT_IDS: " client-a , client-b,client-a "
    });
    expect(config.MCP_ALLOWED_OAUTH_CLIENT_IDS).toEqual(["client-a", "client-b"]);
  });
});
