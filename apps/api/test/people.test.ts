import { SignJWT } from "jose";
import { describe, expect, it } from "vitest";
import { HEALTH_API_PREFIX } from "@family-os/shared";
import { createApp } from "../src/app";
import { InMemoryFamilyRepository } from "../src/repositories/families";

const jwtSecret = "test-supabase-jwt-secret-with-enough-length";
const supabaseUrl = "https://project.supabase.co";
const managerId = "00000000-0000-4000-8000-000000000301";
const memberId = "00000000-0000-4000-8000-000000000302";
const strangerId = "00000000-0000-4000-8000-000000000303";

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

async function setupFamilyWithMember(api: ReturnType<typeof app>) {
  const managerToken = await jwtFor(managerId);
  const memberToken = await jwtFor(memberId, "member@example.com");
  await api.request(`${HEALTH_API_PREFIX}/families`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${managerToken}`,
      "content-type": "application/json"
    },
    body: JSON.stringify({ name: "Jain Family" })
  });
  const inviteResponse = await api.request(`${HEALTH_API_PREFIX}/invites`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${managerToken}`,
      "content-type": "application/json"
    },
    body: JSON.stringify({ email: "member@example.com", role: "member" })
  });
  const invite = await inviteResponse.json();
  await api.request(`${HEALTH_API_PREFIX}/invites/${invite.data.token}/accept`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${memberToken}`
    }
  });
  return { managerToken, memberToken };
}

async function createProfile(api: ReturnType<typeof app>, token: string) {
  return api.request(`${HEALTH_API_PREFIX}/people`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/json"
    },
    body: JSON.stringify({
      displayName: "Mom",
      relationshipLabel: "Mother",
      dateOfBirth: "1965-01-15"
    })
  });
}

describe("health profiles", () => {
  it("lets managers create health profiles", async () => {
    const api = app();
    const { managerToken } = await setupFamilyWithMember(api);

    const response = await createProfile(api, managerToken);

    expect(response.status).toBe(201);
    await expect(response.json()).resolves.toMatchObject({
      data: {
        displayName: "Mom",
        relationshipLabel: "Mother",
        dateOfBirth: "1965-01-15",
        status: "active"
      }
    });
  });

  it("lets active members list and view profiles", async () => {
    const api = app();
    const { managerToken, memberToken } = await setupFamilyWithMember(api);
    const created = await (await createProfile(api, managerToken)).json();

    const list = await api.request(`${HEALTH_API_PREFIX}/people`, {
      headers: {
        authorization: `Bearer ${memberToken}`
      }
    });
    expect(list.status).toBe(200);
    await expect(list.json()).resolves.toMatchObject({
      data: [
        {
          id: created.data.id,
          displayName: "Mom"
        }
      ]
    });

    const detail = await api.request(`${HEALTH_API_PREFIX}/people/${created.data.id}`, {
      headers: {
        authorization: `Bearer ${memberToken}`
      }
    });
    expect(detail.status).toBe(200);
  });

  it("blocks non-manager profile creation", async () => {
    const api = app();
    const { memberToken } = await setupFamilyWithMember(api);

    const response = await createProfile(api, memberToken);

    expect(response.status).toBe(403);
  });

  it("lets managers update and delete profiles", async () => {
    const api = app();
    const { managerToken } = await setupFamilyWithMember(api);
    const created = await (await createProfile(api, managerToken)).json();

    const updated = await api.request(`${HEALTH_API_PREFIX}/people/${created.data.id}`, {
      method: "PATCH",
      headers: {
        authorization: `Bearer ${managerToken}`,
        "content-type": "application/json"
      },
      body: JSON.stringify({ displayName: "Maa" })
    });
    expect(updated.status).toBe(200);
    await expect(updated.json()).resolves.toMatchObject({
      data: {
        displayName: "Maa"
      }
    });

    const deleted = await api.request(`${HEALTH_API_PREFIX}/people/${created.data.id}`, {
      method: "DELETE",
      headers: {
        authorization: `Bearer ${managerToken}`
      }
    });
    expect(deleted.status).toBe(204);

    const list = await api.request(`${HEALTH_API_PREFIX}/people`, {
      headers: {
        authorization: `Bearer ${managerToken}`
      }
    });
    await expect(list.json()).resolves.toEqual({ data: [] });

    const detail = await api.request(`${HEALTH_API_PREFIX}/people/${created.data.id}`, {
      headers: {
        authorization: `Bearer ${managerToken}`
      }
    });
    expect(detail.status).toBe(404);
  });

  it("blocks non-manager profile updates and deletes", async () => {
    const api = app();
    const { managerToken, memberToken } = await setupFamilyWithMember(api);
    const created = await (await createProfile(api, managerToken)).json();

    const update = await api.request(`${HEALTH_API_PREFIX}/people/${created.data.id}`, {
      method: "PATCH",
      headers: {
        authorization: `Bearer ${memberToken}`,
        "content-type": "application/json"
      },
      body: JSON.stringify({ displayName: "Nope" })
    });
    expect(update.status).toBe(403);

    const deleted = await api.request(`${HEALTH_API_PREFIX}/people/${created.data.id}`, {
      method: "DELETE",
      headers: {
        authorization: `Bearer ${memberToken}`
      }
    });
    expect(deleted.status).toBe(403);
  });

  it("does not expose profiles to non-members", async () => {
    const api = app();
    const { managerToken } = await setupFamilyWithMember(api);
    await createProfile(api, managerToken);

    const response = await api.request(`${HEALTH_API_PREFIX}/people`, {
      headers: {
        authorization: `Bearer ${await jwtFor(strangerId)}`
      }
    });

    expect(response.status).toBe(403);
  });

  it("does not expose profile detail to non-members", async () => {
    const api = app();
    const { managerToken } = await setupFamilyWithMember(api);
    const created = await (await createProfile(api, managerToken)).json();

    const response = await api.request(`${HEALTH_API_PREFIX}/people/${created.data.id}`, {
      headers: {
        authorization: `Bearer ${await jwtFor(strangerId)}`
      }
    });

    expect(response.status).toBe(403);
  });

  it("does not expose profile detail across families", async () => {
    const api = app();
    const { managerToken } = await setupFamilyWithMember(api);
    const created = await (await createProfile(api, managerToken)).json();
    const otherManagerToken = await jwtFor(strangerId);
    await api.request(`${HEALTH_API_PREFIX}/families`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${otherManagerToken}`,
        "content-type": "application/json"
      },
      body: JSON.stringify({ name: "Other Family" })
    });

    const response = await api.request(`${HEALTH_API_PREFIX}/people/${created.data.id}`, {
      headers: {
        authorization: `Bearer ${otherManagerToken}`
      }
    });

    expect(response.status).toBe(404);
  });

  it("validates profile input", async () => {
    const api = app();
    const { managerToken } = await setupFamilyWithMember(api);

    const response = await api.request(`${HEALTH_API_PREFIX}/people`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${managerToken}`,
        "content-type": "application/json"
      },
      body: JSON.stringify({ displayName: "", dateOfBirth: "2025-13-45" })
    });

    expect(response.status).toBe(400);
  });
});
