import { SignJWT } from "jose";
import { describe, expect, it } from "vitest";
import { HEALTH_API_PREFIX } from "@family-os/shared";
import { createApp } from "../src/app";
import { InMemoryFamilyRepository } from "../src/repositories/families";

const jwtSecret = "test-supabase-jwt-secret-with-enough-length";
const supabaseUrl = "https://project.supabase.co";
const managerId = "00000000-0000-4000-8000-000000000601";
const memberId = "00000000-0000-4000-8000-000000000602";

function app() {
  return createApp({
    config: { NODE_ENV: "test", PORT: 3001, HEALTH_API_ENABLE_DEV_AUTH: false, SUPABASE_JWT_SECRET: jwtSecret, SUPABASE_URL: supabaseUrl },
    familyRepository: new InMemoryFamilyRepository()
  });
}

async function jwtFor(subject: string, email = `${subject}@example.com`) {
  return new SignJWT({ role: "authenticated", email })
    .setProtectedHeader({ alg: "HS256" })
    .setSubject(subject)
    .setIssuer(`${supabaseUrl}/auth/v1`)
    .setAudience("authenticated")
    .setIssuedAt()
    .setExpirationTime("1h")
    .sign(new TextEncoder().encode(jwtSecret));
}

async function setup(api: ReturnType<typeof app>) {
  const managerToken = await jwtFor(managerId);
  const memberToken = await jwtFor(memberId, "member@example.com");
  await api.request(`${HEALTH_API_PREFIX}/families`, { method: "POST", headers: { authorization: `Bearer ${managerToken}`, "content-type": "application/json" }, body: JSON.stringify({ name: "Jain Family" }) });
  const invite = await (await api.request(`${HEALTH_API_PREFIX}/invites`, { method: "POST", headers: { authorization: `Bearer ${managerToken}`, "content-type": "application/json" }, body: JSON.stringify({ email: "member@example.com", role: "member" }) })).json();
  await api.request(`${HEALTH_API_PREFIX}/invites/${invite.data.token}/accept`, { method: "POST", headers: { authorization: `Bearer ${memberToken}` } });
  const profile = await (await api.request(`${HEALTH_API_PREFIX}/people`, { method: "POST", headers: { authorization: `Bearer ${managerToken}`, "content-type": "application/json" }, body: JSON.stringify({ displayName: "Mom" }) })).json();
  return { managerToken, memberToken, profileId: profile.data.id };
}

async function createReminder(api: ReturnType<typeof app>, token: string, profileId: string) {
  return api.request(`${HEALTH_API_PREFIX}/reminders`, {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify({
      subjectPersonId: profileId,
      type: "blood_pressure",
      title: "BP check",
      message: "Please check BP",
      scheduleKind: "daily",
      timeOfDay: "08:00",
      timezone: "Asia/Bangkok",
      recipientUserIds: [managerId, memberId]
    })
  });
}

describe("reminders", () => {
  it("lets active members create and list reminders with selected recipients", async () => {
    const api = app();
    const { memberToken, profileId } = await setup(api);
    const response = await createReminder(api, memberToken, profileId);
    expect(response.status).toBe(201);
    const body = await response.json();
    expect(body.data).toMatchObject({ title: "BP check", createdByUserId: memberId, recipients: [{ userId: managerId }, { userId: memberId }] });

    const list = await api.request(`${HEALTH_API_PREFIX}/reminders`, { headers: { authorization: `Bearer ${memberToken}` } });
    await expect(list.json()).resolves.toMatchObject({ data: [{ id: body.data.id }] });
  });

  it("allows recipients to disable reminders for themselves", async () => {
    const api = app();
    const { memberToken, profileId } = await setup(api);
    const reminder = await (await createReminder(api, memberToken, profileId)).json();
    const response = await api.request(`${HEALTH_API_PREFIX}/reminders/${reminder.data.id}/disable-for-me`, {
      method: "POST",
      headers: { authorization: `Bearer ${memberToken}` }
    });
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({ data: { userId: memberId, enabled: false } });
  });

  it("enforces creator-or-manager updates and deletes", async () => {
    const api = app();
    const { managerToken, memberToken, profileId } = await setup(api);
    const reminder = await (await createReminder(api, memberToken, profileId)).json();
    const update = await api.request(`${HEALTH_API_PREFIX}/reminders/${reminder.data.id}`, {
      method: "PATCH",
      headers: { authorization: `Bearer ${managerToken}`, "content-type": "application/json" },
      body: JSON.stringify({ title: "Updated" })
    });
    expect(update.status).toBe(200);
    const deleted = await api.request(`${HEALTH_API_PREFIX}/reminders/${reminder.data.id}`, { method: "DELETE", headers: { authorization: `Bearer ${memberToken}` } });
    expect(deleted.status).toBe(204);
  });
});
