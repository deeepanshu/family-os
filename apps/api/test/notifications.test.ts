import { SignJWT } from "jose";
import { describe, expect, it } from "vitest";
import { HEALTH_API_PREFIX } from "@family-os/shared";
import { createApp } from "../src/app";
import { InMemoryFamilyRepository } from "../src/repositories/families";
import { sendDueReminderPushes, type PushPayload } from "../src/notifications/scheduler";

const jwtSecret = "test-supabase-jwt-secret-with-enough-length";
const supabaseUrl = "https://project.supabase.co";
const userId = "00000000-0000-4000-8000-000000000701";
const otherUserId = "00000000-0000-4000-8000-000000000702";

function api(repo = new InMemoryFamilyRepository()) {
  return createApp({
    config: { NODE_ENV: "test", PORT: 3001, HEALTH_API_ENABLE_DEV_AUTH: false, SUPABASE_JWT_SECRET: jwtSecret, SUPABASE_URL: supabaseUrl },
    familyRepository: repo
  });
}

async function jwtFor(subject: string) {
  return new SignJWT({ role: "authenticated" })
    .setProtectedHeader({ alg: "HS256" })
    .setSubject(subject)
    .setIssuer(`${supabaseUrl}/auth/v1`)
    .setAudience("authenticated")
    .setIssuedAt()
    .setExpirationTime("1h")
    .sign(new TextEncoder().encode(jwtSecret));
}

describe("notification devices and scheduler", () => {
  it("registers and deletes iOS devices for the authenticated user", async () => {
    const app = api();
    const token = await jwtFor(userId);
    const created = await app.request(`${HEALTH_API_PREFIX}/devices`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({ platform: "ios", deviceToken: "a".repeat(64) })
    });
    expect(created.status).toBe(201);
    const body = await created.json();
    expect(body.data).toMatchObject({ userId, platform: "ios" });
    const deleted = await app.request(`${HEALTH_API_PREFIX}/devices/${body.data.id}`, { method: "DELETE", headers: { authorization: `Bearer ${token}` } });
    expect(deleted.status).toBe(204);
  });

  it("does not let users delete another user's device", async () => {
    const app = api();
    const token = await jwtFor(userId);
    const otherToken = await jwtFor(otherUserId);
    const created = await app.request(`${HEALTH_API_PREFIX}/devices`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({ platform: "ios", deviceToken: "d".repeat(64) })
    });
    const body = await created.json();

    const deleted = await app.request(`${HEALTH_API_PREFIX}/devices/${body.data.id}`, {
      method: "DELETE",
      headers: { authorization: `Bearer ${otherToken}` }
    });

    expect(deleted.status).toBe(404);
  });

  it("expands due reminders and sends push intents through the sender interface", async () => {
    const repo = new InMemoryFamilyRepository();
    const app = api(repo);
    const token = await jwtFor(userId);
    await app.request(`${HEALTH_API_PREFIX}/families`, { method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, body: JSON.stringify({ name: "Jain Family" }) });
    await app.request(`${HEALTH_API_PREFIX}/devices`, { method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, body: JSON.stringify({ platform: "ios", deviceToken: "b".repeat(64) }) });
    await app.request(`${HEALTH_API_PREFIX}/reminders`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({ type: "blood_glucose", title: "Sugar", message: "Check sugar", scheduleKind: "daily", timeOfDay: "08:00", timezone: "UTC", recipientUserIds: [userId] })
    });
    const sent: PushPayload[] = [];
    const count = await sendDueReminderPushes(repo, { send: async (payload) => void sent.push(payload) }, new Date("2026-06-21T08:00:00.000Z"));
    expect(count).toBe(1);
    expect(sent).toMatchObject([{ token: "b".repeat(64), title: "Sugar", data: { action: "open_add_blood_glucose" } }]);
  });
});
