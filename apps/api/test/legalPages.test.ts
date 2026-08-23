import { describe, expect, it } from "vitest";
import { createApp } from "../src/app";
import { SUPPORT_EMAIL } from "../src/routes/legalPages";

function app() {
  return createApp({
    config: {
      NODE_ENV: "test",
      PORT: 3001,
      HEALTH_API_ENABLE_DEV_AUTH: false,
      SUPABASE_JWT_SECRET: "test-supabase-jwt-secret-with-enough-length",
      SUPABASE_URL: "https://project.supabase.co"
    }
  });
}

describe("public legal pages", () => {
  it("serves the privacy policy without authentication", async () => {
    const response = await app().request("/privacy");

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("text/html");
    const html = await response.text();
    expect(html).toContain("FamilyStack");
    expect(html).toContain("Privacy Policy");
    expect(html).toContain("HealthKit");
    expect(html).toContain("step count");
    expect(html).toContain("blood pressure");
    expect(html).toContain("heart rate");
    expect(html).toContain("sleep analysis");
    expect(html).toContain("Workouts");
    expect(html).toContain("does not request or present glucose");
    expect(html).toContain("Sign in with Apple");
    expect(html).toContain("Supabase");
    expect(html).toContain("APNs");
    expect(html).toContain("Crashlytics");
    expect(html).toContain("do not sell");
    expect(html).toContain("advertising");
    expect(html).toContain(SUPPORT_EMAIL);
    expect(html).toContain("http://127.0.0.1:3001");
    expect(html).not.toContain("Family OS");
  });

  it("redirects /privacy-policy to /privacy", async () => {
    const response = await app().request("/privacy-policy");

    expect(response.status).toBe(302);
    expect(response.headers.get("location")).toBe("/privacy");
  });

  it("serves support without authentication", async () => {
    const response = await app().request("/support");

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("text/html");
    const html = await response.text();
    expect(html).toContain("Support");
    expect(html).toContain(SUPPORT_EMAIL);
    expect(html).toContain(`mailto:${SUPPORT_EMAIL}`);
  });

  it("serves account deletion / privacy choices without authentication", async () => {
    const response = await app().request("/account-deletion");

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("text/html");
    const html = await response.text();
    expect(html).toContain("Delete your account");
    expect(html).toContain("User Privacy Choices");
    expect(html).toContain("Profile");
    expect(html).toContain("Delete account");
    expect(html).toContain("audit");
    expect(html).toContain("account.deleted");
    expect(html).toContain("Apple Health");
    expect(html).toContain(SUPPORT_EMAIL);
  });

  it("does not require an Authorization header on any legal path", async () => {
    const paths = ["/privacy", "/privacy-policy", "/support", "/account-deletion"];
    for (const path of paths) {
      const response = await app().request(path);
      expect(response.status, path).toBeLessThan(400);
      expect(response.status, path).not.toBe(401);
    }
  });
});
