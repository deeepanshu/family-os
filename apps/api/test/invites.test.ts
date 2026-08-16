import { SignJWT } from "jose";
import { describe, expect, it } from "vitest";
import { HEALTH_API_PREFIX } from "@family-os/shared";
import { createApp } from "../src/app";
import { InMemoryFamilyRepository } from "../src/repositories/families";

const jwtSecret = "test-supabase-jwt-secret-with-enough-length";
const supabaseUrl = "https://project.supabase.co";
const managerId = "00000000-0000-4000-8000-000000000201";
const memberId = "00000000-0000-4000-8000-000000000202";
const strangerId = "00000000-0000-4000-8000-000000000203";

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

async function jwtFor(subject: string, email = "user@example.com") {
  return new SignJWT({ role: "authenticated", email })
    .setProtectedHeader({ alg: "HS256" })
    .setSubject(subject)
    .setIssuer(`${supabaseUrl}/auth/v1`)
    .setAudience("authenticated")
    .setIssuedAt()
    .setExpirationTime("1h")
    .sign(new TextEncoder().encode(jwtSecret));
}

async function createFamily(api: ReturnType<typeof app>, token: string) {
  await api.request(`${HEALTH_API_PREFIX}/families`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/json"
    },
    body: JSON.stringify({ name: "Jain Family" })
  });
}

async function createInvite(api: ReturnType<typeof app>, token: string) {
  const response = await api.request(`${HEALTH_API_PREFIX}/invites`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/json"
    },
    body: JSON.stringify({})
  });
  return response;
}

async function acceptInvite(api: ReturnType<typeof app>, token: string, inviteToken: string) {
  return api.request(`${HEALTH_API_PREFIX}/invites/${inviteToken}/accept`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/json"
    },
    body: JSON.stringify({ relationshipLabel: "Father" })
  });
}

describe("family invites", () => {
  it("lets a manager create an invite and hides the token hash", async () => {
    const api = app();
    const managerToken = await jwtFor(managerId);
    await createFamily(api, managerToken);

    const response = await createInvite(api, managerToken);

    expect(response.status).toBe(201);
    const body = await response.json();
    expect(body.data.invite).toMatchObject({
      status: "pending"
    });
    expect(body.data.invite.tokenHash).toBeUndefined();
    expect(body.data.invite.email).toBeUndefined();
    expect(body.data.invite.role).toBeUndefined();
    expect(body.data.token).toEqual(expect.any(String));
    expect(body.data.url).toContain(`/invite/${body.data.token}`);
  });

  it("requires an active manager to create invites", async () => {
    const response = await app().request(`${HEALTH_API_PREFIX}/invites`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${await jwtFor(strangerId)}`,
        "content-type": "application/json"
      },
      body: JSON.stringify({})
    });

    expect(response.status).toBe(403);
  });

  it("lets anyone inspect a valid invite token without authentication", async () => {
    const api = app();
    const managerToken = await jwtFor(managerId);
    await createFamily(api, managerToken);
    const invite = await (await createInvite(api, managerToken)).json();

    const response = await api.request(`${HEALTH_API_PREFIX}/invites/${invite.data.token}`);

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      data: {
        familyName: "Jain Family",
        status: "pending"
      }
    });
  });

  it("lets an invited user accept and then see the family as current", async () => {
    const api = app();
    const managerToken = await jwtFor(managerId);
    const memberToken = await jwtFor(memberId, "member@example.com");
    await createFamily(api, managerToken);
    const invite = await (await createInvite(api, managerToken)).json();

    const accept = await acceptInvite(api, memberToken, invite.data.token);

    expect(accept.status).toBe(200);
    await expect(accept.json()).resolves.toMatchObject({
      data: {
        family: {
          name: "Jain Family"
        },
        membership: {
          userId: memberId,
          role: "member",
          status: "active"
        }
      }
    });

    const current = await api.request(`${HEALTH_API_PREFIX}/families/current`, {
      headers: {
        authorization: `Bearer ${memberToken}`
      }
    });
    await expect(current.json()).resolves.toMatchObject({
      data: {
        family: {
          name: "Jain Family"
        }
      }
    });
  });

  it("does not allow accepting the same invite twice", async () => {
    const api = app();
    const managerToken = await jwtFor(managerId);
    await createFamily(api, managerToken);
    const invite = await (await createInvite(api, managerToken)).json();
    await acceptInvite(api, await jwtFor(memberId, "member@example.com"), invite.data.token);

    const response = await acceptInvite(api, await jwtFor(strangerId), invite.data.token);

    expect(response.status).toBe(409);
  });

  it("does not lock an invite to an email", async () => {
    const api = app();
    const managerToken = await jwtFor(managerId);
    await createFamily(api, managerToken);
    const invite = await (await createInvite(api, managerToken)).json();

    const response = await acceptInvite(api, await jwtFor(memberId, "wrong@example.com"), invite.data.token);

    expect(response.status).toBe(200);
  });

  it("allows only one concurrent accept for a pending invite", async () => {
    const api = app();
    const managerToken = await jwtFor(managerId);
    await createFamily(api, managerToken);
    const invite = await (await createInvite(api, managerToken)).json();

    const responses = await Promise.all([
      acceptInvite(api, await jwtFor(memberId, "member@example.com"), invite.data.token),
      acceptInvite(api, await jwtFor(strangerId, "member@example.com"), invite.data.token)
    ]);

    expect(responses.map((response) => response.status).sort()).toEqual([200, 409]);
  });
});
