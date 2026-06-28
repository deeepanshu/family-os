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
        HEALTH_API_CORS_ORIGIN: "https://app.deepanshujain.com"
      })
    ).toThrow("HEALTH_API_REPOSITORY=memory is not allowed in production.");
  });
});
