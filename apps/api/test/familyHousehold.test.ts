import { SignJWT } from "jose";
import { afterEach, describe, expect, it, vi } from "vitest";
import { HEALTH_API_PREFIX } from "@family-os/shared";
import { createApp } from "../src/app";
import { InMemoryFamilyRepository } from "../src/repositories/families";
import { seedHealthKitReadyGroup } from "./healthKitTestHelpers";
import { setupHousehold, setupSoloUser } from "./soloSetup";

const jwtSecret = "test-supabase-jwt-secret-with-enough-length";
const supabaseUrl = "https://project.supabase.co";
const creatorId = "00000000-0000-4000-8000-000000000601";
const joinerId = "00000000-0000-4000-8000-000000000602";

function app() {
  return createApp({
    config: {
      NODE_ENV: "test",
      PORT: 3001,
      HEALTH_API_ENABLE_DEV_AUTH: false,
      SUPABASE_JWT_SECRET: jwtSecret,
      SUPABASE_URL: supabaseUrl,
      MCP_PUBLIC_ORIGIN: "https://familyos.example.com"
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
    .setExpirationTime("24h")
    .sign(new TextEncoder().encode(jwtSecret));
}

async function createFamily(api: ReturnType<typeof app>, token: string, name = "Jain Family") {
  const response = await api.request(`${HEALTH_API_PREFIX}/families`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/json"
    },
    body: JSON.stringify({ name })
  });
  expect(response.status).toBe(201);
  return response.json();
}

async function mintInvite(api: ReturnType<typeof app>, token: string) {
  const response = await api.request(`${HEALTH_API_PREFIX}/invites`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/json"
    },
    body: JSON.stringify({})
  });
  expect(response.status).toBe(201);
  return response.json();
}

async function acceptInvite(
  api: ReturnType<typeof app>,
  token: string,
  inviteToken: string,
  relationshipLabel = "Father"
) {
  return api.request(`${HEALTH_API_PREFIX}/invites/${inviteToken}/accept`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/json"
    },
    body: JSON.stringify({ relationshipLabel })
  });
}

describe("household invites", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("lets the creator mint a one-hour invite link without email or role", async () => {
    const api = app();
    const token = await jwtFor(creatorId);
    await createFamily(api, token);

    const response = await api.request(`${HEALTH_API_PREFIX}/invites`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json"
      },
      body: JSON.stringify({})
    });

    expect(response.status).toBe(201);
    const body = await response.json();
    expect(body.data.token).toEqual(expect.any(String));
    expect(body.data.url).toBe(`https://familyos.example.com/invite/${body.data.token}`);
    expect(body.data.invite).toMatchObject({
      status: "pending"
    });
    expect(body.data.invite.email).toBeUndefined();
    expect(body.data.invite.role).toBeUndefined();
    expect(body.data.invite.tokenHash).toBeUndefined();

    const expiresAt = Date.parse(body.data.invite.expiresAt);
    expect(expiresAt).toBeGreaterThan(Date.now() + 55 * 60 * 1000);
    expect(expiresAt).toBeLessThanOrEqual(Date.now() + 61 * 60 * 1000);
  });

  it("rejects extra fields on invite mint", async () => {
    const api = app();
    const token = await jwtFor(creatorId);
    await createFamily(api, token);
    const response = await api.request(`${HEALTH_API_PREFIX}/invites`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json"
      },
      body: JSON.stringify({ email: "x@example.com", role: "member" })
    });
    expect(response.status).toBe(400);
  });

  it("returns creator identity and a copyable live invite on current family and bootstrap", async () => {
    const api = app();
    const token = await jwtFor(creatorId);
    await setupSoloUser(api, token, "Deepanshu");
    await setupHousehold(api, token, "Jain Family");
    const minted = await mintInvite(api, token);

    const current = await api.request(`${HEALTH_API_PREFIX}/families/current`, {
      headers: { authorization: `Bearer ${token}` }
    });
    expect(current.status).toBe(200);
    await expect(current.json()).resolves.toMatchObject({
      data: {
        family: { name: "Jain Family" },
        creatorDisplayName: "Deepanshu",
        liveInvite: {
          status: "pending",
          token: minted.data.token,
          url: `https://familyos.example.com/invite/${minted.data.token}`
        }
      }
    });

    const bootstrap = await api.request(`${HEALTH_API_PREFIX}/bootstrap`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}` }
    });
    expect(bootstrap.status).toBe(200);
    await expect(bootstrap.json()).resolves.toMatchObject({
      data: {
        family: { name: "Jain Family" },
        creatorDisplayName: "Deepanshu",
        liveInvite: {
          status: "pending",
          token: minted.data.token,
          url: `https://familyos.example.com/invite/${minted.data.token}`
        }
      }
    });
  });

  it("revokes the unused live invite when the creator mints a new one", async () => {
    const api = app();
    const token = await jwtFor(creatorId);
    await createFamily(api, token);

    const first = await (
      await api.request(`${HEALTH_API_PREFIX}/invites`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${token}`,
          "content-type": "application/json"
        },
        body: JSON.stringify({})
      })
    ).json();
    const second = await (
      await api.request(`${HEALTH_API_PREFIX}/invites`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${token}`,
          "content-type": "application/json"
        },
        body: JSON.stringify({})
      })
    ).json();

    const firstPreview = await api.request(`${HEALTH_API_PREFIX}/invites/${first.data.token}`);
    const secondPreview = await api.request(`${HEALTH_API_PREFIX}/invites/${second.data.token}`);
    expect(firstPreview.status).toBe(200);
    expect(secondPreview.status).toBe(200);
    await expect(firstPreview.json()).resolves.toMatchObject({
      data: { status: "revoked" }
    });
    await expect(secondPreview.json()).resolves.toMatchObject({
      data: { status: "pending" }
    });
  });

  it("lets anyone preview a live invite with the family and creator names only", async () => {
    const api = app();
    const token = await jwtFor(creatorId);
    await setupSoloUser(api, token, "Deepanshu");
    await setupHousehold(api, token, "Jain Family");
    const minted = await (
      await api.request(`${HEALTH_API_PREFIX}/invites`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${token}`,
          "content-type": "application/json"
        },
        body: JSON.stringify({})
      })
    ).json();

    const response = await api.request(`${HEALTH_API_PREFIX}/invites/${minted.data.token}`);

    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.data).toEqual({
      familyName: "Jain Family",
      creatorDisplayName: "Deepanshu",
      status: "pending",
      expiresAt: expect.any(String)
    });
    expect(body.data).not.toHaveProperty("members");
    expect(body.data).not.toHaveProperty("role");
  });

  it("accepts a solo user with a directed label and lists them by their Self name", async () => {
    const api = app();
    const creatorToken = await jwtFor(creatorId);
    const joinerToken = await jwtFor(joinerId);
    await setupSoloUser(api, creatorToken, "Deepanshu");
    await setupHousehold(api, creatorToken, "Jain Family");
    await setupSoloUser(api, joinerToken, "Riya");
    const minted = await (
      await api.request(`${HEALTH_API_PREFIX}/invites`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${creatorToken}`,
          "content-type": "application/json"
        },
        body: JSON.stringify({})
      })
    ).json();

    const accept = await api.request(`${HEALTH_API_PREFIX}/invites/${minted.data.token}/accept`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${joinerToken}`,
        "content-type": "application/json"
      },
      body: JSON.stringify({ relationshipLabel: "Father" })
    });

    expect(accept.status).toBe(200);
    await expect(accept.json()).resolves.toMatchObject({
      data: {
        family: { name: "Jain Family" },
        membership: {
          userId: joinerId,
          status: "active",
          creatorRelationshipLabel: "Father"
        }
      }
    });

    const members = await api.request(`${HEALTH_API_PREFIX}/families/members`, {
      headers: { authorization: `Bearer ${creatorToken}` }
    });
    expect(members.status).toBe(200);
    const roster = await members.json();
    const names = roster.data.map((row: { displayName?: string }) => row.displayName).sort();
    expect(names).toEqual(["Deepanshu", "Riya"]);
    const joinerRow = roster.data.find((row: { membership: { userId: string } }) => row.membership.userId === joinerId);
    expect(joinerRow.membership.creatorRelationshipLabel).toBe("Father");
    const creatorRow = roster.data.find((row: { membership: { userId: string } }) => row.membership.userId === creatorId);
    expect(creatorRow.membership.creatorRelationshipLabel).toBeUndefined();
  });

  it("rejects a free-text or missing join label", async () => {
    const api = app();
    const creatorToken = await jwtFor(creatorId);
    const joinerToken = await jwtFor(joinerId);
    await setupSoloUser(api, creatorToken, "Deepanshu");
    await setupHousehold(api, creatorToken);
    const minted = await mintInvite(api, creatorToken);

    const missing = await api.request(`${HEALTH_API_PREFIX}/invites/${minted.data.token}/accept`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${joinerToken}`,
        "content-type": "application/json"
      },
      body: JSON.stringify({})
    });
    const other = await acceptInvite(api, joinerToken, minted.data.token, "Other");
    expect(missing.status).toBe(400);
    expect(other.status).toBe(400);
  });

  it("refuses an invite when the opener already has a family", async () => {
    const api = app();
    const creatorToken = await jwtFor(creatorId);
    const joinerToken = await jwtFor(joinerId);
    await setupSoloUser(api, creatorToken, "Deepanshu");
    await setupHousehold(api, creatorToken);
    await setupSoloUser(api, joinerToken, "Riya");
    await setupHousehold(api, joinerToken, "Other House");
    const minted = await mintInvite(api, creatorToken);

    const response = await acceptInvite(api, joinerToken, minted.data.token);
    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toMatchObject({
      error: { code: "family_already_exists" }
    });
  });

  it("refuses the creator joining their own invite", async () => {
    const api = app();
    const creatorToken = await jwtFor(creatorId);
    await setupSoloUser(api, creatorToken, "Deepanshu");
    await setupHousehold(api, creatorToken);
    const minted = await mintInvite(api, creatorToken);

    const response = await acceptInvite(api, creatorToken, minted.data.token);
    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toMatchObject({
      error: { code: "invite_own_family" }
    });
  });

  it("distinguishes expired tokens from already-used tokens", async () => {
    const api = app();
    const creatorToken = await jwtFor(creatorId);
    const firstJoiner = await jwtFor(joinerId);
    const secondJoiner = await jwtFor("00000000-0000-4000-8000-000000000603");
    await setupSoloUser(api, creatorToken, "Deepanshu");
    await setupHousehold(api, creatorToken);
    const live = await mintInvite(api, creatorToken);
    await setupSoloUser(api, firstJoiner, "Riya");
    const used = await acceptInvite(api, firstJoiner, live.data.token);
    expect(used.status).toBe(200);

    const reused = await acceptInvite(api, secondJoiner, live.data.token);
    expect(reused.status).toBe(409);
    await expect(reused.json()).resolves.toMatchObject({
      error: { code: "invite_already_used" }
    });

    const expiredInvite = await mintInvite(api, creatorToken);
    vi.useFakeTimers();
    vi.setSystemTime(new Date(Date.now() + 61 * 60 * 1000));
    const expired = await acceptInvite(api, secondJoiner, expiredInvite.data.token, "Mother");
    expect(expired.status).toBe(409);
    await expect(expired.json()).resolves.toMatchObject({
      error: { code: "invite_expired" }
    });
  });

  it("serves a public landing page that does not accept the invite", async () => {
    const api = app();
    const creatorToken = await jwtFor(creatorId);
    await setupSoloUser(api, creatorToken, "Deepanshu");
    await setupHousehold(api, creatorToken, "Jain Family");
    const minted = await mintInvite(api, creatorToken);

    const page = await api.request(`/invite/${minted.data.token}`);
    expect(page.status).toBe(200);
    expect(page.headers.get("content-type")).toContain("text/html");
    const html = await page.text();
    expect(html).toContain("Jain Family");
    expect(html).toContain("Deepanshu");
    expect(html).toContain("Open in Family OS");
    expect(html).toContain(`familyos://invite/${minted.data.token}`);

    const preview = await api.request(`${HEALTH_API_PREFIX}/invites/${minted.data.token}`);
    await expect(preview.json()).resolves.toMatchObject({ data: { status: "pending" } });
  });

  it("forbids a non-creator member from minting an invite", async () => {
    const api = app();
    const creatorToken = await jwtFor(creatorId);
    const joinerToken = await jwtFor(joinerId);
    await setupSoloUser(api, creatorToken, "Deepanshu");
    await setupHousehold(api, creatorToken);
    await setupSoloUser(api, joinerToken, "Riya");
    const minted = await mintInvite(api, creatorToken);
    expect((await acceptInvite(api, joinerToken, minted.data.token)).status).toBe(200);

    const response = await api.request(`${HEALTH_API_PREFIX}/invites`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${joinerToken}`,
        "content-type": "application/json"
      },
      body: JSON.stringify({})
    });
    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toMatchObject({
      error: { code: "creator_required" }
    });
  });
});

describe("household leave, remove, and delete", () => {
  it("lets a non-creator leave and vanish from the roster without revoking the live invite", async () => {
    const api = app();
    const creatorToken = await jwtFor(creatorId);
    const joinerToken = await jwtFor(joinerId);
    await setupSoloUser(api, creatorToken, "Deepanshu");
    await setupHousehold(api, creatorToken);
    await setupSoloUser(api, joinerToken, "Riya");
    const firstInvite = await mintInvite(api, creatorToken);
    expect((await acceptInvite(api, joinerToken, firstInvite.data.token)).status).toBe(200);
    const liveInvite = await mintInvite(api, creatorToken);

    const leave = await api.request(`${HEALTH_API_PREFIX}/families/leave`, {
      method: "POST",
      headers: { authorization: `Bearer ${joinerToken}` }
    });
    expect(leave.status).toBe(204);

    const current = await api.request(`${HEALTH_API_PREFIX}/families/current`, {
      headers: { authorization: `Bearer ${joinerToken}` }
    });
    await expect(current.json()).resolves.toEqual({ data: null });

    const members = await (
      await api.request(`${HEALTH_API_PREFIX}/families/members`, {
        headers: { authorization: `Bearer ${creatorToken}` }
      })
    ).json();
    expect(members.data.map((row: { displayName?: string }) => row.displayName)).toEqual(["Deepanshu"]);

    const preview = await api.request(`${HEALTH_API_PREFIX}/invites/${liveInvite.data.token}`);
    await expect(preview.json()).resolves.toMatchObject({ data: { status: "pending" } });
  });

  it("does not let the creator leave", async () => {
    const api = app();
    const creatorToken = await jwtFor(creatorId);
    await setupSoloUser(api, creatorToken, "Deepanshu");
    await setupHousehold(api, creatorToken);

    const response = await api.request(`${HEALTH_API_PREFIX}/families/leave`, {
      method: "POST",
      headers: { authorization: `Bearer ${creatorToken}` }
    });
    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toMatchObject({
      error: { code: "creator_cannot_leave" }
    });
  });

  it("lets the creator remove a member and revokes the unused live invite", async () => {
    const api = app();
    const creatorToken = await jwtFor(creatorId);
    const joinerToken = await jwtFor(joinerId);
    await setupSoloUser(api, creatorToken, "Deepanshu");
    await setupHousehold(api, creatorToken);
    await setupSoloUser(api, joinerToken, "Riya");
    const firstInvite = await mintInvite(api, creatorToken);
    expect((await acceptInvite(api, joinerToken, firstInvite.data.token)).status).toBe(200);
    const liveInvite = await mintInvite(api, creatorToken);

    const removed = await api.request(`${HEALTH_API_PREFIX}/families/members/${joinerId}`, {
      method: "DELETE",
      headers: { authorization: `Bearer ${creatorToken}` }
    });
    expect(removed.status).toBe(204);

    const current = await api.request(`${HEALTH_API_PREFIX}/families/current`, {
      headers: { authorization: `Bearer ${joinerToken}` }
    });
    await expect(current.json()).resolves.toEqual({ data: null });

    const preview = await api.request(`${HEALTH_API_PREFIX}/invites/${liveInvite.data.token}`);
    await expect(preview.json()).resolves.toMatchObject({ data: { status: "revoked" } });
  });

  it("blocks deleting a family while other members remain and allows it after they are gone", async () => {
    const api = app();
    const creatorToken = await jwtFor(creatorId);
    const joinerToken = await jwtFor(joinerId);
    await setupSoloUser(api, creatorToken, "Deepanshu");
    await setupHousehold(api, creatorToken, "Jain Family");
    await setupSoloUser(api, joinerToken, "Riya");
    const minted = await mintInvite(api, creatorToken);
    expect((await acceptInvite(api, joinerToken, minted.data.token)).status).toBe(200);

    const blocked = await api.request(`${HEALTH_API_PREFIX}/families/current`, {
      method: "DELETE",
      headers: { authorization: `Bearer ${creatorToken}` }
    });
    expect(blocked.status).toBe(409);
    await expect(blocked.json()).resolves.toMatchObject({
      error: { code: "family_not_empty" }
    });

    expect(
      (
        await api.request(`${HEALTH_API_PREFIX}/families/members/${joinerId}`, {
          method: "DELETE",
          headers: { authorization: `Bearer ${creatorToken}` }
        })
      ).status
    ).toBe(204);

    const deleted = await api.request(`${HEALTH_API_PREFIX}/families/current`, {
      method: "DELETE",
      headers: { authorization: `Bearer ${creatorToken}` }
    });
    expect(deleted.status).toBe(204);

    const current = await api.request(`${HEALTH_API_PREFIX}/families/current`, {
      headers: { authorization: `Bearer ${creatorToken}` }
    });
    await expect(current.json()).resolves.toEqual({ data: null });
  });
});

describe("household health visibility", () => {
  it("lets a member read another member's synced samples but not write them", async () => {
    const api = app();
    const creatorToken = await jwtFor(creatorId);
    const joinerToken = await jwtFor(joinerId);
    const strangerToken = await jwtFor("00000000-0000-4000-8000-000000000699");
    const creator = await setupSoloUser(api, creatorToken, "Deepanshu");
    await setupHousehold(api, creatorToken);
    await setupSoloUser(api, joinerToken, "Riya");
    const installationId = "00000000-0000-4000-8000-000000000610";
    await api.request(`${HEALTH_API_PREFIX}/healthkit/settings`, {
      method: "PUT",
      headers: { authorization: `Bearer ${creatorToken}`, "content-type": "application/json" },
      body: JSON.stringify({
        personId: creator.profileId,
        consentVersion: "1",
        enabledGroups: ["vitals"],
        healthTimezone: "UTC",
        installationId
      })
    });
    await seedHealthKitReadyGroup(api, creatorToken, creator.profileId, installationId, "vitals", [
      {
        opId: crypto.randomUUID(),
        naturalKey: "blood_pressure:5e1ed621-4a6c-4e09-969e-31c6f0872c24",
        group: "vitals",
        scopeKey: "blood_pressure",
        op: "upsert",
        payload: {
          kind: "blood_pressure",
          sourceObjectKey: "5e1ed621-4a6c-4e09-969e-31c6f0872c24",
          measuredAtUtc: "2026-06-21T10:00:00.000Z",
          systolic: 128,
          diastolic: 82
        }
      }
    ]);
    const minted = await mintInvite(api, creatorToken);
    expect((await acceptInvite(api, joinerToken, minted.data.token)).status).toBe(200);

    const readable = await api.request(
      `${HEALTH_API_PREFIX}/readings/blood-pressure?personId=${creator.profileId}`,
      { headers: { authorization: `Bearer ${joinerToken}` } }
    );
    expect(readable.status).toBe(200);
    const body = await readable.json();
    expect(body.data).toEqual([
      expect.objectContaining({
        personId: creator.profileId,
        systolic: 128,
        diastolic: 82
      })
    ]);

    const stranger = await api.request(
      `${HEALTH_API_PREFIX}/readings/blood-pressure?personId=${creator.profileId}`,
      { headers: { authorization: `Bearer ${strangerToken}` } }
    );
    expect(stranger.status).toBe(403);

    const write = await api.request(`${HEALTH_API_PREFIX}/healthkit/settings`, {
      method: "PUT",
      headers: { authorization: `Bearer ${joinerToken}`, "content-type": "application/json" },
      body: JSON.stringify({
        personId: creator.profileId,
        consentVersion: "1",
        enabledGroups: ["vitals"],
        healthTimezone: "UTC",
        installationId: "00000000-0000-4000-8000-000000000611"
      })
    });
    expect(write.status).toBe(403);

    const settings = await api.request(
      `${HEALTH_API_PREFIX}/healthkit/settings?personId=${creator.profileId}`,
      { headers: { authorization: `Bearer ${joinerToken}` } }
    );
    expect(settings.status).toBe(200);
    await expect(settings.json()).resolves.toMatchObject({
      data: { personId: creator.profileId, enabledGroups: ["vitals"] }
    });

    expect(
      (
        await api.request(`${HEALTH_API_PREFIX}/families/leave`, {
          method: "POST",
          headers: { authorization: `Bearer ${joinerToken}` }
        })
      ).status
    ).toBe(204);
    const afterLeave = await api.request(
      `${HEALTH_API_PREFIX}/readings/blood-pressure?personId=${creator.profileId}`,
      { headers: { authorization: `Bearer ${joinerToken}` } }
    );
    expect(afterLeave.status).toBe(403);
  });

  it("forbids mutating another member's Self profile", async () => {
    const api = app();
    const creatorToken = await jwtFor(creatorId);
    const joinerToken = await jwtFor(joinerId);
    const creator = await setupSoloUser(api, creatorToken, "Deepanshu");
    await setupHousehold(api, creatorToken);
    const joiner = await setupSoloUser(api, joinerToken, "Riya");
    const minted = await mintInvite(api, creatorToken);
    expect((await acceptInvite(api, joinerToken, minted.data.token)).status).toBe(200);

    const creatorPatch = await api.request(`${HEALTH_API_PREFIX}/people/${joiner.profileId}`, {
      method: "PATCH",
      headers: { authorization: `Bearer ${creatorToken}`, "content-type": "application/json" },
      body: JSON.stringify({ displayName: "Renamed" })
    });
    expect(creatorPatch.status).toBe(403);

    const creatorDelete = await api.request(`${HEALTH_API_PREFIX}/people/${joiner.profileId}`, {
      method: "DELETE",
      headers: { authorization: `Bearer ${creatorToken}` }
    });
    expect(creatorDelete.status).toBe(403);

    const ownPatch = await api.request(`${HEALTH_API_PREFIX}/people/${creator.profileId}`, {
      method: "PATCH",
      headers: { authorization: `Bearer ${creatorToken}`, "content-type": "application/json" },
      body: JSON.stringify({ displayName: "Deep" })
    });
    expect(ownPatch.status).toBe(200);
    await expect(ownPatch.json()).resolves.toMatchObject({
      data: { displayName: "Deep", relationshipLabel: "Self" }
    });
  });
});

describe("invite landing and app links", () => {
  it("publishes an Apple App Site Association that opens /invite links", async () => {
    const response = await app().request("/.well-known/apple-app-site-association");
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("application/json");
    const body = await response.json();
    expect(body.applinks.details).toEqual([
      expect.objectContaining({
        appIDs: ["LG9UP2KBHV.com.deepanshujain.familyos"],
        components: [expect.objectContaining({ "/": "/invite/*" })]
      })
    ]);
  });
});
