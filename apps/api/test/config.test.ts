import { describe, expect, it } from "vitest";
import { loadConfig } from "../src/config";

describe("configuration", () => {
  it("treats blank env placeholders as unset values", () => {
    expect(
      loadConfig({
        NODE_ENV: "",
        PORT: "",
        DATABASE_URL: "",
        SUPABASE_URL: "",
        SUPABASE_ANON_KEY: "",
        SUPABASE_JWT_SECRET: "",
        HEALTH_API_ENABLE_DEV_AUTH: "",
        HEALTH_API_DEV_AUTH_USER_ID: ""
      })
    ).toMatchObject({
      NODE_ENV: "development",
      PORT: 3001,
      HEALTH_API_ENABLE_DEV_AUTH: false,
      HEALTH_API_CORS_ORIGIN: "*",
      HEALTH_API_RATE_LIMIT_WINDOW_MS: 60_000,
      HEALTH_API_RATE_LIMIT_MAX_WRITES: 120,
      HEALTH_API_RATE_LIMIT_MAX_BUCKETS: 10_000
    });
  });

  it("requires an explicit CORS origin in production", () => {
    expect(() => loadConfig({ NODE_ENV: "production" })).toThrow(
      "HEALTH_API_CORS_ORIGIN must be configured in production."
    );
  });
});
