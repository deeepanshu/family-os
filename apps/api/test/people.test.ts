import { SignJWT } from "jose";
import { describe, expect, it } from "vitest";
import { HEALTH_API_PREFIX } from "@family-os/shared";
import { createApp } from "../src/app";
import { InMemoryFamilyRepository } from "../src/repositories/families";
import { setupHousehold, setupSoloUser } from "./soloSetup";

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
  const creator = await setupSoloUser(api, managerToken, "Deepanshu");
  await setupHousehold(api, managerToken, "Jain Family");
  const joiner = await setupSoloUser(api, memberToken, "Riya");
  const inviteResponse = await api.request(`${HEALTH_API_PREFIX}/invites`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${managerToken}`,
      "content-type": "application/json"
    },
    body: JSON.stringify({})
  });
  const invite = await inviteResponse.json();
  await api.request(`${HEALTH_API_PREFIX}/invites/${invite.data.token}/accept`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${memberToken}`,
      "content-type": "application/json"
    },
    body: JSON.stringify({ relationshipLabel: "Father" })
  });
  return { managerToken, memberToken, creatorProfileId: creator.profileId, memberProfileId: joiner.profileId };
}

describe("health profiles", () => {
  it("does not allow creating profiles for people who never installed the app", async () => {
    const api = app();
    const { managerToken } = await setupFamilyWithMember(api);

    const response = await api.request(`${HEALTH_API_PREFIX}/people`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${managerToken}`,
        "content-type": "application/json"
      },
      body: JSON.stringify({
        displayName: "Mom",
        relationshipLabel: "Mother",
        dateOfBirth: "1965-01-15"
      })
    });

    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toMatchObject({
      error: { code: "ghost_profiles_unsupported" }
    });
  });

  it("lets active members list and view each other's Self profiles", async () => {
    const api = app();
    const { memberToken, creatorProfileId, memberProfileId } = await setupFamilyWithMember(api);

    const list = await api.request(`${HEALTH_API_PREFIX}/people`, {
      headers: {
        authorization: `Bearer ${memberToken}`
      }
    });
    expect(list.status).toBe(200);
    const body = await list.json();
    const names = body.data.map((row: { displayName: string }) => row.displayName).sort();
    expect(names).toEqual(["Deepanshu", "Riya"]);

    const detail = await api.request(`${HEALTH_API_PREFIX}/people/${creatorProfileId}`, {
      headers: {
        authorization: `Bearer ${memberToken}`
      }
    });
    expect(detail.status).toBe(200);
    expect(memberProfileId).toBeTruthy();
  });

  it("does not expose profiles to non-members", async () => {
    const api = app();
    await setupFamilyWithMember(api);

    const response = await api.request(`${HEALTH_API_PREFIX}/people`, {
      headers: {
        authorization: `Bearer ${await jwtFor(strangerId)}`
      }
    });

    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.data).toEqual([]);
  });

  it("does not expose profile detail to non-members", async () => {
    const api = app();
    const { creatorProfileId } = await setupFamilyWithMember(api);

    const response = await api.request(`${HEALTH_API_PREFIX}/people/${creatorProfileId}`, {
      headers: {
        authorization: `Bearer ${await jwtFor(strangerId)}`
      }
    });

    expect(response.status).toBe(403);
  });

  it("does not expose profile detail across families", async () => {
    const api = app();
    const { creatorProfileId } = await setupFamilyWithMember(api);
    const otherManagerToken = await jwtFor(strangerId);
    await setupSoloUser(api, otherManagerToken, "Other");
    await setupHousehold(api, otherManagerToken, "Other Family");

    const response = await api.request(`${HEALTH_API_PREFIX}/people/${creatorProfileId}`, {
      headers: {
        authorization: `Bearer ${otherManagerToken}`
      }
    });

    expect(response.status).toBe(403);
  });
});
