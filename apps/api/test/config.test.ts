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
        HEALTH_API_DEV_AUTH_USER_ID: ""
      })
    ).toMatchObject({
      NODE_ENV: "development",
      PORT: 3001,
      repository: "postgres",
      HEALTH_API_SYNC_LOCAL_AUTH_USERS: true,
      HEALTH_API_ENABLE_DEV_AUTH: false,
      HEALTH_API_RATE_LIMIT_WINDOW_MS: 60_000,
      HEALTH_API_RATE_LIMIT_MAX_WRITES: 120,
      HEALTH_API_RATE_LIMIT_MAX_BUCKETS: 10_000
    });
  });

  it("leaves CORS disabled when its origin is blank", () => {
    expect(loadConfig({ NODE_ENV: "test", HEALTH_API_CORS_ORIGIN: "" }).HEALTH_API_CORS_ORIGIN).toBeUndefined();
  });

  it("uses the in-memory repository in tests", () => {
    expect(loadConfig({ NODE_ENV: "test" })).toMatchObject({
      repository: "memory",
      HEALTH_API_SYNC_LOCAL_AUTH_USERS: false
    });
  });

  it("requires MCP public origin, Supabase URL, anon key, and service role key in production", () => {
    expect(() =>
      loadConfig({
        NODE_ENV: "production",
        DATABASE_URL: "postgres://family_os:family_os@localhost:5432/family_os",
        SUPABASE_URL: "https://project.supabase.co",
        SUPABASE_ANON_KEY: "anon-key",
        SUPABASE_SERVICE_ROLE_KEY: "service-role-key"
      })
    ).toThrow("MCP_PUBLIC_ORIGIN must be configured in production.");

    expect(() =>
      loadConfig({
        NODE_ENV: "production",
        DATABASE_URL: "postgres://family_os:family_os@localhost:5432/family_os",
        MCP_PUBLIC_ORIGIN: "https://familyos.deepanshujain.me",
        SUPABASE_ANON_KEY: "anon-key",
        SUPABASE_SERVICE_ROLE_KEY: "service-role-key"
      })
    ).toThrow("SUPABASE_URL must be configured in production.");

    expect(() =>
      loadConfig({
        NODE_ENV: "production",
        DATABASE_URL: "postgres://family_os:family_os@localhost:5432/family_os",
        MCP_PUBLIC_ORIGIN: "https://familyos.deepanshujain.me",
        SUPABASE_URL: "https://project.supabase.co",
        SUPABASE_SERVICE_ROLE_KEY: "service-role-key"
      })
    ).toThrow("SUPABASE_ANON_KEY must be configured in production");

    expect(() =>
      loadConfig({
        NODE_ENV: "production",
        DATABASE_URL: "postgres://family_os:family_os@localhost:5432/family_os",
        MCP_PUBLIC_ORIGIN: "https://familyos.deepanshujain.me",
        SUPABASE_URL: "https://project.supabase.co",
        SUPABASE_ANON_KEY: "anon-key"
      })
    ).toThrow("SUPABASE_SERVICE_ROLE_KEY must be configured in production");

    expect(() =>
      loadConfig({
        NODE_ENV: "production",
        DATABASE_URL: "postgres://family_os:family_os@localhost:5432/family_os",
        MCP_PUBLIC_ORIGIN: "https://familyos.deepanshujain.me",
        SUPABASE_URL: "https://project.supabase.co",
        SUPABASE_ANON_KEY: "anon-key",
        SUPABASE_SERVICE_ROLE_KEY: ""
      })
    ).toThrow("SUPABASE_SERVICE_ROLE_KEY must be configured in production");

    const valid = loadConfig({
      NODE_ENV: "production",
      DATABASE_URL: "postgres://family_os:family_os@localhost:5432/family_os",
      MCP_PUBLIC_ORIGIN: "https://familyos.deepanshujain.me",
      SUPABASE_URL: "https://project.supabase.co",
      SUPABASE_ANON_KEY: "anon-key",
      SUPABASE_SERVICE_ROLE_KEY: "service-role-key"
    });
    expect(valid.MCP_PUBLIC_ORIGIN).toBe("https://familyos.deepanshujain.me");
  });

  it("normalizes MCP public path", () => {
    const config = loadConfig({
      NODE_ENV: "test",
      MCP_PUBLIC_ORIGIN: "https://familyos.deepanshujain.me/",
      MCP_PUBLIC_PATH: "api/mcp/"
    });
    expect(config.MCP_PUBLIC_ORIGIN).toBe("https://familyos.deepanshujain.me");
    expect(config.MCP_PUBLIC_PATH).toBe("/api/mcp");
  });

  it("requires the MCP path to end in /mcp so OAuth paths are deterministic", () => {
    expect(() => loadConfig({ NODE_ENV: "test", MCP_PUBLIC_PATH: "/health/api" })).toThrow(
      "MCP_PUBLIC_PATH must end with /mcp"
    );
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

  it("requires https for MCP_PUBLIC_ORIGIN in production and restricts http to loopback outside production", () => {
    expect(() =>
      loadConfig({
        NODE_ENV: "production",
        DATABASE_URL: "postgres://family_os:family_os@localhost:5432/family_os",
        MCP_PUBLIC_ORIGIN: "http://familyos.deepanshujain.me",
        SUPABASE_URL: "https://project.supabase.co",
        SUPABASE_ANON_KEY: "anon-key",
      })
    ).toThrow(/must use https: in production/);

    expect(() =>
      loadConfig({
        NODE_ENV: "test",
        MCP_PUBLIC_ORIGIN: "http://familyos.deepanshujain.me"
      })
    ).toThrow(/loopback/);

    expect(() =>
      loadConfig({
        NODE_ENV: "test",
        MCP_PUBLIC_ORIGIN: "ftp://familyos.deepanshujain.me"
      })
    ).toThrow(/must use https/);

    const loopback = loadConfig({
      NODE_ENV: "test",
      MCP_PUBLIC_ORIGIN: "http://127.0.0.1:3001"
    });
    expect(loopback.MCP_PUBLIC_ORIGIN).toBe("http://127.0.0.1:3001");

    const secure = loadConfig({
      NODE_ENV: "production",
      DATABASE_URL: "postgres://family_os:family_os@localhost:5432/family_os",
      MCP_PUBLIC_ORIGIN: "https://familyos.deepanshujain.me",
      SUPABASE_URL: "https://project.supabase.co",
      SUPABASE_ANON_KEY: "anon-key",
      SUPABASE_SERVICE_ROLE_KEY: "service-role-key",
    });
    expect(secure.MCP_PUBLIC_ORIGIN).toBe("https://familyos.deepanshujain.me");
  });

});
