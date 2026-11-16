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
    expect(html).toContain("blood glucose");
    expect(html).toContain("sleep analysis");
    expect(html).toContain("Workouts");
    expect(html).toContain("exercise names");
    expect(html).toContain("GPS routes");
    expect(html).not.toContain("does not request or present glucose");
    expect(html).toContain("Sign in with Apple");
    expect(html).toContain("Supabase");
    expect(html).toContain("does not register for remote (APNs)");
    expect(html).toContain("local notifications");
    expect(html).toContain("household Self profiles");
    expect(html).toContain("own privacy terms");
    expect(html).toContain("Crashlytics");
    expect(html).toContain("shared reminder content");
    expect(html).toContain("who receives each reminder");
    expect(html).toContain("crash stack traces");
    expect(html).toContain("device model");
    expect(html).toContain("365 days");
    expect(html).toContain("90 days");
    expect(html).toContain("30 days");
    expect(html).toContain("not directed to children under 13");
    expect(html).toContain("Cloudflare");
    expect(html).toContain("do not use non-essential cookies");
    expect(html).toContain("no automated backups");
    expect(html).toContain("0 days");
    expect(html).toContain("Supabase Auth");
    expect(html).not.toContain("exercise catalog");
    expect(html).not.toContain("shared workout exercise catalog");
    expect(html).toContain("/terms");
    expect(html).toContain("do not sell");
    expect(html).toContain("advertising");
    expect(html).toContain(SUPPORT_EMAIL);
    expect(html).toContain("http://127.0.0.1:3001");
    expect(html).not.toContain("Family OS");
    expect(html).not.toContain("live.com");
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
    expect(html).toContain("/terms");
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
    expect(html).toContain("HealthKitSync/sync.sqlite");
    expect(html).toContain("pending operations");
    expect(html).toContain("Apple Health");
    expect(html).toContain(SUPPORT_EMAIL);
    expect(html).toContain("365 days");
    expect(html).toContain("deletion-pending");
    expect(html).toContain("family id is cleared");
    expect(html).not.toContain("exercise catalog");
    expect(html).not.toContain("shared workout exercise catalog");
    expect(html).not.toContain("APNs device tokens");
  });

  it("does not require an Authorization header on any legal path", async () => {
    const paths = ["/privacy", "/privacy-policy", "/terms", "/support", "/account-deletion"];

    for (const path of paths) {
      const response = await app().request(path);
      expect(response.status, path).toBeLessThan(400);
      expect(response.status, path).not.toBe(401);
    }
  });

  it("serves terms of use without authentication", async () => {
    const response = await app().request("/terms");

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("text/html");
    const html = await response.text();
    expect(html).toContain("Terms of Use");
    expect(html).toContain("not a medical device");
    expect(html).toContain("medical advice");
    expect(html).toContain("emergencies");
    expect(html).toContain("diagnosis");
    expect(html).toContain("clinical decision support");
    expect(html).toContain("13 or older");
    expect(html).toContain("suspend or terminate");
    expect(html).toContain(SUPPORT_EMAIL);
  });
});
