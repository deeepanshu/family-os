import { SignJWT } from "jose";
import { describe, expect, it } from "vitest";
import { HEALTH_API_PREFIX } from "@family-os/shared";
import { createApp } from "../src/app";
import { InMemoryFamilyRepository } from "../src/repositories/families";

const jwtSecret = "test-supabase-jwt-secret-with-enough-length";
const supabaseUrl = "https://project.supabase.co";
const userId = "00000000-0000-4000-8000-000000000501";
const otherUserId = "00000000-0000-4000-8000-000000000502";

function app() {
  return createApp({
    config: {
      NODE_ENV: "test",
      PORT: 3001,
      HEALTH_API_ENABLE_DEV_AUTH: false,
      SUPABASE_JWT_SECRET: jwtSecret,
      SUPABASE_URL: supabaseUrl
    },
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

describe("solo-first bootstrap", () => {
  it("creates a personal workspace for a brand-new user", async () => {
    const api = app();
    const token = await jwtFor(userId);

    const response = await api.request(`${HEALTH_API_PREFIX}/bootstrap`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}` }
    });

    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.data.family).toMatchObject({
      name: "My Health",
      kind: "personal",
      createdByUserId: userId
    });
    expect(body.data.membership).toMatchObject({
      userId,
      role: "manager",
      status: "active"
    });
    expect(body.data.profiles).toEqual([]);
    expect(body.data.selfProfile).toBeNull();
    expect(body.data.needsProfileSetup).toBe(true);
  });

  it("is idempotent", async () => {
    const api = app();
    const token = await jwtFor(userId);
    const headers = { authorization: `Bearer ${token}` };

    const first = await api.request(`${HEALTH_API_PREFIX}/bootstrap`, {
      method: "POST",
      headers
    });
    const firstBody = await first.json();

    const second = await api.request(`${HEALTH_API_PREFIX}/bootstrap`, {
      method: "POST",
      headers
    });
    const secondBody = await second.json();

    expect(second.status).toBe(200);
    expect(secondBody.data.family.id).toBe(firstBody.data.family.id);
  });

  it("creates a linked self profile via /me/profile", async () => {
    const api = app();
    const token = await jwtFor(userId);

    await api.request(`${HEALTH_API_PREFIX}/bootstrap`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}` }
    });

    const response = await api.request(`${HEALTH_API_PREFIX}/me/profile`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({ displayName: "Deepanshu" })
    });

    expect(response.status).toBe(201);
    const body = await response.json();
    expect(body.data).toMatchObject({
      displayName: "Deepanshu",
      relationshipLabel: "Self",
      linkedUserId: userId,
      status: "active"
    });

    const bootstrap = await api.request(`${HEALTH_API_PREFIX}/bootstrap`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}` }
    });
    const bootstrapBody = await bootstrap.json();
    expect(bootstrapBody.data.needsProfileSetup).toBe(false);
    expect(bootstrapBody.data.selfProfile).toMatchObject({
      displayName: "Deepanshu",
      relationshipLabel: "Self"
    });
  });

  it("returns the existing self profile idempotently", async () => {
    const api = app();
    const token = await jwtFor(userId);

    await api.request(`${HEALTH_API_PREFIX}/bootstrap`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}` }
    });

    const first = await api.request(`${HEALTH_API_PREFIX}/me/profile`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({ displayName: "Deepanshu" })
    });
    const firstBody = await first.json();

    const second = await api.request(`${HEALTH_API_PREFIX}/me/profile`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({ displayName: "Changed" })
    });
    const secondBody = await second.json();

    expect(second.status).toBe(201);
    expect(secondBody.data.id).toBe(firstBody.data.id);
    expect(secondBody.data.displayName).toBe("Deepanshu");
  });

  it("requires an active workspace to create a self profile", async () => {
    const api = app();
    const token = await jwtFor(userId);

    const response = await api.request(`${HEALTH_API_PREFIX}/me/profile`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({ displayName: "Deepanshu" })
    });

    expect(response.status).toBe(403);
  });

  it("keeps /people manager-only", async () => {
    const api = app();
    const managerId = "00000000-0000-4000-8000-000000000512";
    const memberId = "00000000-0000-4000-8000-000000000513";
    const managerToken = await jwtFor(managerId, "manager@example.com");
    const memberToken = await jwtFor(memberId, "member@example.com");

    await api.request(`${HEALTH_API_PREFIX}/bootstrap`, {
      method: "POST",
      headers: { authorization: `Bearer ${managerToken}` }
    });
    const invite = await (await api.request(`${HEALTH_API_PREFIX}/invites`, {
      method: "POST",
      headers: { authorization: `Bearer ${managerToken}`, "content-type": "application/json" },
      body: JSON.stringify({ email: "member@example.com", role: "member" })
    })).json();
    await api.request(`${HEALTH_API_PREFIX}/invites/${invite.data.token}/accept`, {
      method: "POST",
      headers: { authorization: `Bearer ${memberToken}` }
    });

    const response = await api.request(`${HEALTH_API_PREFIX}/people`, {
      method: "POST",
      headers: { authorization: `Bearer ${memberToken}`, "content-type": "application/json" },
      body: JSON.stringify({ displayName: "Mom", relationshipLabel: "Mother" })
    });

    expect(response.status).toBe(403);
  });

  it("converts a personal workspace to family on the first invite", async () => {
    const api = app();
    const token = await jwtFor(userId);

    await api.request(`${HEALTH_API_PREFIX}/bootstrap`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}` }
    });

    const invite = await api.request(`${HEALTH_API_PREFIX}/invites`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({ email: "member@example.com", role: "member" })
    });
    expect(invite.status).toBe(201);

    const current = await api.request(`${HEALTH_API_PREFIX}/families/current`, {
      headers: { authorization: `Bearer ${token}` }
    });
    const currentBody = await current.json();
    expect(currentBody.data.family.kind).toBe("family");
  });

  it("accepts an invite for a user with no workspace", async () => {
    const api = app();
    const managerToken = await jwtFor(userId, "manager@example.com");
    const memberToken = await jwtFor(otherUserId, "member@example.com");

    await api.request(`${HEALTH_API_PREFIX}/bootstrap`, {
      method: "POST",
      headers: { authorization: `Bearer ${managerToken}` }
    });
    const invite = await (await api.request(`${HEALTH_API_PREFIX}/invites`, {
      method: "POST",
      headers: { authorization: `Bearer ${managerToken}`, "content-type": "application/json" },
      body: JSON.stringify({ email: "member@example.com", role: "member" })
    })).json();

    const accept = await api.request(`${HEALTH_API_PREFIX}/invites/${invite.data.token}/accept`, {
      method: "POST",
      headers: { authorization: `Bearer ${memberToken}` }
    });

    expect(accept.status).toBe(200);
    const body = await accept.json();
    expect(body.data.membership).toMatchObject({
      userId: otherUserId,
      role: "member",
      status: "active"
    });
  });

  it("rejects invite acceptance for a user with an active family workspace", async () => {
    const api = app();
    const firstUserId = "00000000-0000-4000-8000-000000000503";
    const secondUserId = "00000000-0000-4000-8000-000000000504";
    const thirdUserId = "00000000-0000-4000-8000-000000000505";
    const firstToken = await jwtFor(firstUserId, "first@example.com");
    const secondToken = await jwtFor(secondUserId, "second@example.com");
    const thirdToken = await jwtFor(thirdUserId, "third@example.com");

    await api.request(`${HEALTH_API_PREFIX}/bootstrap`, {
      method: "POST",
      headers: { authorization: `Bearer ${firstToken}` }
    });
    const invite = await (await api.request(`${HEALTH_API_PREFIX}/invites`, {
      method: "POST",
      headers: { authorization: `Bearer ${firstToken}`, "content-type": "application/json" },
      body: JSON.stringify({ email: "second@example.com", role: "member" })
    })).json();
    await api.request(`${HEALTH_API_PREFIX}/invites/${invite.data.token}/accept`, {
      method: "POST",
      headers: { authorization: `Bearer ${secondToken}` }
    });

    await api.request(`${HEALTH_API_PREFIX}/bootstrap`, {
      method: "POST",
      headers: { authorization: `Bearer ${thirdToken}` }
    });
    await api.request(`${HEALTH_API_PREFIX}/invites`, {
      method: "POST",
      headers: { authorization: `Bearer ${thirdToken}`, "content-type": "application/json" },
      body: JSON.stringify({ email: "extra@example.com", role: "member" })
    });

    const secondInvite = await (await api.request(`${HEALTH_API_PREFIX}/invites`, {
      method: "POST",
      headers: { authorization: `Bearer ${firstToken}`, "content-type": "application/json" },
      body: JSON.stringify({ email: "third@example.com", role: "member" })
    })).json();

    const response = await api.request(`${HEALTH_API_PREFIX}/invites/${secondInvite.data.token}/accept`, {
      method: "POST",
      headers: { authorization: `Bearer ${thirdToken}` }
    });

    expect(response.status).toBe(409);
  });

  it("switches a safe empty personal workspace when accepting an invite", async () => {
    const api = app();
    const firstUserId = "00000000-0000-4000-8000-000000000506";
    const secondUserId = "00000000-0000-4000-8000-000000000507";
    const firstToken = await jwtFor(firstUserId, "first@example.com");
    const secondToken = await jwtFor(secondUserId, "second@example.com");

    await api.request(`${HEALTH_API_PREFIX}/bootstrap`, {
      method: "POST",
      headers: { authorization: `Bearer ${firstToken}` }
    });
    const invite = await (await api.request(`${HEALTH_API_PREFIX}/invites`, {
      method: "POST",
      headers: { authorization: `Bearer ${firstToken}`, "content-type": "application/json" },
      body: JSON.stringify({ email: "second@example.com", role: "member" })
    })).json();

    await api.request(`${HEALTH_API_PREFIX}/bootstrap`, {
      method: "POST",
      headers: { authorization: `Bearer ${secondToken}` }
    });

    const accept = await api.request(`${HEALTH_API_PREFIX}/invites/${invite.data.token}/accept`, {
      method: "POST",
      headers: { authorization: `Bearer ${secondToken}` }
    });

    expect(accept.status).toBe(200);
    const body = await accept.json();
    expect(body.data.family.kind).toBe("family");
  });

  it("rejects switching an unsafe personal workspace with manual readings", async () => {
    const api = app();
    const firstUserId = "00000000-0000-4000-8000-000000000508";
    const secondUserId = "00000000-0000-4000-8000-000000000509";
    const firstToken = await jwtFor(firstUserId, "first@example.com");
    const secondToken = await jwtFor(secondUserId, "second@example.com");

    await api.request(`${HEALTH_API_PREFIX}/bootstrap`, {
      method: "POST",
      headers: { authorization: `Bearer ${firstToken}` }
    });
    const invite = await (await api.request(`${HEALTH_API_PREFIX}/invites`, {
      method: "POST",
      headers: { authorization: `Bearer ${firstToken}`, "content-type": "application/json" },
      body: JSON.stringify({ email: "second@example.com", role: "member" })
    })).json();

    await api.request(`${HEALTH_API_PREFIX}/bootstrap`, {
      method: "POST",
      headers: { authorization: `Bearer ${secondToken}` }
    });
    const secondSelfProfile = await (await api.request(`${HEALTH_API_PREFIX}/me/profile`, {
      method: "POST",
      headers: { authorization: `Bearer ${secondToken}`, "content-type": "application/json" },
      body: JSON.stringify({ displayName: "Second" })
    })).json();
    await api.request(`${HEALTH_API_PREFIX}/readings/blood-pressure`, {
      method: "POST",
      headers: { authorization: `Bearer ${secondToken}`, "content-type": "application/json" },
      body: JSON.stringify({
        personId: secondSelfProfile.data.id,
        systolic: 120,
        diastolic: 80,
        measuredAt: "2026-06-21T10:00:00.000Z"
      })
    });

    const response = await api.request(`${HEALTH_API_PREFIX}/invites/${invite.data.token}/accept`, {
      method: "POST",
      headers: { authorization: `Bearer ${secondToken}` }
    });

    expect(response.status).toBe(409);
  });

  it("rejects switching an unsafe personal workspace with reminders", async () => {
    const api = app();
    const firstUserId = "00000000-0000-4000-8000-000000000510";
    const secondUserId = "00000000-0000-4000-8000-000000000511";
    const firstToken = await jwtFor(firstUserId, "first@example.com");
    const secondToken = await jwtFor(secondUserId, "second@example.com");

    await api.request(`${HEALTH_API_PREFIX}/bootstrap`, {
      method: "POST",
      headers: { authorization: `Bearer ${firstToken}` }
    });
    const invite = await (await api.request(`${HEALTH_API_PREFIX}/invites`, {
      method: "POST",
      headers: { authorization: `Bearer ${firstToken}`, "content-type": "application/json" },
      body: JSON.stringify({ email: "second@example.com", role: "member" })
    })).json();

    await api.request(`${HEALTH_API_PREFIX}/bootstrap`, {
      method: "POST",
      headers: { authorization: `Bearer ${secondToken}` }
    });
    const secondSelfProfile = await (await api.request(`${HEALTH_API_PREFIX}/me/profile`, {
      method: "POST",
      headers: { authorization: `Bearer ${secondToken}`, "content-type": "application/json" },
      body: JSON.stringify({ displayName: "Second" })
    })).json();
    await api.request(`${HEALTH_API_PREFIX}/reminders`, {
      method: "POST",
      headers: { authorization: `Bearer ${secondToken}`, "content-type": "application/json" },
      body: JSON.stringify({
        subjectPersonId: secondSelfProfile.data.id,
        type: "generic",
        title: "Test",
        message: "Test reminder",
        scheduleKind: "daily",
        timezone: "UTC",
        recipientUserIds: [secondUserId]
      })
    });

    const response = await api.request(`${HEALTH_API_PREFIX}/invites/${invite.data.token}/accept`, {
      method: "POST",
      headers: { authorization: `Bearer ${secondToken}` }
    });

    expect(response.status).toBe(409);
  });

  it("rejects HealthKit import when no linked self profile exists", async () => {
    const api = app();
    const token = await jwtFor(userId);

    await api.request(`${HEALTH_API_PREFIX}/bootstrap`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}` }
    });

    const response = await api.request(`${HEALTH_API_PREFIX}/healthkit/samples/batch`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({ samples: [] })
    });

    expect(response.status).toBe(409);
  });

  it("imports HealthKit samples only into the linked self profile", async () => {
    const api = app();
    const token = await jwtFor(userId);

    await api.request(`${HEALTH_API_PREFIX}/bootstrap`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}` }
    });
    await api.request(`${HEALTH_API_PREFIX}/me/profile`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({ displayName: "Deepanshu" })
    });
    await api.request(`${HEALTH_API_PREFIX}/healthkit/sync/settings`, {
      method: "PATCH",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({ enabledMetrics: ["steps"] })
    });

    const response = await api.request(`${HEALTH_API_PREFIX}/healthkit/samples/batch`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({
        samples: [
          {
            metricType: "steps",
            sourceSampleKey: "steps-1",
            startDate: "2026-06-30T00:00:00.000Z",
            value: 8000,
            unit: "count"
          }
        ]
      })
    });

    expect(response.status).toBe(201);
    const body = await response.json();
    expect(body.data.importedCount).toBe(1);
  });
});
