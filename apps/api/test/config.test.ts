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
      HEALTH_API_ENABLE_DEV_AUTH: false
    });
  });
});
