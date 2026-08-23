import { SignJWT } from "jose";
import { afterEach, describe, expect, it, vi } from "vitest";
import { HEALTH_API_PREFIX } from "@family-os/shared";
import { createApp } from "../src/app";
import { InMemoryFamilyRepository } from "../src/repositories/families";
import { bloodPressureOp, seedHealthKitReadyGroup } from "./healthKitTestHelpers";
import { setupHousehold, setupSoloUser } from "./soloSetup";

const jwtSecret = "test-supabase-jwt-secret-with-enough-length";
const supabaseUrl = "https://project.supabase.co";
const managerId = "00000000-0000-4000-8000-000000000401";
const memberId = "00000000-0000-4000-8000-000000000402";
const managerInstallationId = "53064303-35cf-4db0-a5d3-8af7d8f747e1";
const memberInstallationId = "63064303-35cf-4db0-a5d3-8af7d8f747e2";

function app(
  options: {
    serviceRoleKey?: string;
    fetchImpl?: typeof fetch;
    familyRepository?: InMemoryFamilyRepository;
  } = {}
) {
  if (options.fetchImpl) {
    vi.stubGlobal("fetch", options.fetchImpl);
  }
  return createApp({
    config: {
      NODE_ENV: "test",
      PORT: 3001,
      HEALTH_API_ENABLE_DEV_AUTH: false,
      SUPABASE_JWT_SECRET: jwtSecret,
      SUPABASE_URL: supabaseUrl,
      ...(options.serviceRoleKey ? { SUPABASE_SERVICE_ROLE_KEY: options.serviceRoleKey } : {})
    },
    familyRepository: options.familyRepository ?? new InMemoryFamilyRepository()
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

async function putVitalsSettings(api: ReturnType<typeof app>, token: string, profileId: string, installationId: string) {
  const response = await api.request(`${HEALTH_API_PREFIX}/healthkit/settings`, {
    method: "PUT",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify({
      personId: profileId,
      consentVersion: "1",
      enabledGroups: ["vitals"],
      healthTimezone: "UTC",
      installationId
    })
  });
  if (!response.ok) {
    throw new Error(`healthkit settings failed: ${response.status} ${await response.text()}`);
  }
}

async function seedBloodPressure(
  api: ReturnType<typeof app>,
  token: string,
  profileId: string,
  installationId: string,
  sourceObjectKey: string
) {
  await putVitalsSettings(api, token, profileId, installationId);
  await seedHealthKitReadyGroup(api, token, profileId, installationId, "vitals", [
    bloodPressureOp({
      sourceObjectKey,
      measuredAtUtc: "2026-07-25T01:10:00.000Z",
      systolic: 118,
      diastolic: 76
    })
  ]);
}

describe("account deletion", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("deletes the account with 204 and lets the same sign-in start fresh", async () => {
    const api = app();
    const token = await jwtFor(managerId);
    const { profileId } = await setupSoloUser(api, token, "Deepanshu");
    await seedBloodPressure(
      api,
      token,
      profileId,
      managerInstallationId,
      "5e1ed621-4a6c-4e09-969e-31c6f0872c24"
    );

    const deleted = await api.request(`${HEALTH_API_PREFIX}/me`, {
      method: "DELETE",
      headers: { authorization: `Bearer ${token}` }
    });
    expect(deleted.status).toBe(204);

    const session = await api.request(`${HEALTH_API_PREFIX}/me`, {
      headers: { authorization: `Bearer ${token}` }
    });
    expect(session.status).toBe(200);

    const oldReadings = await api.request(
      `${HEALTH_API_PREFIX}/readings/blood-pressure?personId=${profileId}`,
      { headers: { authorization: `Bearer ${token}` } }
    );
    expect(oldReadings.status).toBe(404);

    const recreate = await api.request(`${HEALTH_API_PREFIX}/me/profile`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({ displayName: "Back" })
    });
    expect(recreate.status).toBe(201);

    const bootstrap = await api.request(`${HEALTH_API_PREFIX}/bootstrap`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}` }
    });
    expect(bootstrap.status).toBe(200);
    await expect(bootstrap.json()).resolves.toMatchObject({
      data: { needsProfileSetup: false, selfProfile: { displayName: "Back" } }
    });

    const second = await api.request(`${HEALTH_API_PREFIX}/me`, {
      method: "DELETE",
      headers: { authorization: `Bearer ${token}` }
    });
    expect(second.status).toBe(204);
  });

  it("hides the deleted member and their readings from remaining family", async () => {
    const api = app();
    const managerToken = await jwtFor(managerId);
    const memberToken = await jwtFor(memberId, "member@example.com");
    const creator = await setupSoloUser(api, managerToken, "Deepanshu");
    await setupHousehold(api, managerToken, "Jain Family");
    const joiner = await setupSoloUser(api, memberToken, "Riya");
    const invite = await (
      await api.request(`${HEALTH_API_PREFIX}/invites`, {
        method: "POST",
        headers: { authorization: `Bearer ${managerToken}`, "content-type": "application/json" },
        body: JSON.stringify({})
      })
    ).json();
    await api.request(`${HEALTH_API_PREFIX}/invites/${invite.data.token}/accept`, {
      method: "POST",
      headers: { authorization: `Bearer ${memberToken}`, "content-type": "application/json" },
      body: JSON.stringify({ relationshipLabel: "Father" })
    });

    await seedBloodPressure(
      api,
      memberToken,
      joiner.profileId,
      memberInstallationId,
      "6e1ed621-4a6c-4e09-969e-31c6f0872c25"
    );

    const before = await api.request(
      `${HEALTH_API_PREFIX}/readings/blood-pressure?personId=${joiner.profileId}`,
      { headers: { authorization: `Bearer ${managerToken}` } }
    );
    expect(before.status).toBe(200);
    await expect(before.json()).resolves.toMatchObject({
      data: [{ systolic: 118, diastolic: 76 }]
    });

    const deleted = await api.request(`${HEALTH_API_PREFIX}/me`, {
      method: "DELETE",
      headers: { authorization: `Bearer ${memberToken}` }
    });
    expect(deleted.status).toBe(204);

    const people = await (
      await api.request(`${HEALTH_API_PREFIX}/people`, {
        headers: { authorization: `Bearer ${managerToken}` }
      })
    ).json();
    expect(people.data.map((profile: { id: string }) => profile.id)).toEqual([creator.profileId]);

    const members = await (
      await api.request(`${HEALTH_API_PREFIX}/families/members`, {
        headers: { authorization: `Bearer ${managerToken}` }
      })
    ).json();
    expect(members.data.map((row: { membership: { userId: string } }) => row.membership.userId)).toEqual([
      managerId
    ]);

    const readings = await api.request(
      `${HEALTH_API_PREFIX}/readings/blood-pressure?personId=${joiner.profileId}`,
      { headers: { authorization: `Bearer ${managerToken}` } }
    );
    expect(readings.status).toBe(404);
  });

  it("dissolves a household when the last member deletes their account", async () => {
    const repo = new InMemoryFamilyRepository();
    const api = app({ familyRepository: repo });
    const token = await jwtFor(managerId);
    await setupSoloUser(api, token, "Deepanshu");
    await setupHousehold(api, token, "Jain Family");
    const before = await (
      await api.request(`${HEALTH_API_PREFIX}/families/current`, {
        headers: { authorization: `Bearer ${token}` }
      })
    ).json();
    const family = before.data?.family;
    if (!family || typeof family !== "object" || !("id" in family) || typeof family.id !== "string") {
      throw new Error("expected current family id");
    }
    const familyId = family.id;

    const deleted = await api.request(`${HEALTH_API_PREFIX}/me`, {
      method: "DELETE",
      headers: { authorization: `Bearer ${token}` }
    });
    expect(deleted.status).toBe(204);
    expect(repo.hasFamily(familyId)).toBe(false);

    const otherToken = await jwtFor(memberId, "new@example.com");
    await setupSoloUser(api, otherToken, "New");
    const current = await api.request(`${HEALTH_API_PREFIX}/families/current`, {
      headers: { authorization: `Bearer ${otherToken}` }
    });
    expect(current.status).toBe(200);
    await expect(current.json()).resolves.toMatchObject({ data: null });
  });

  it("keeps DELETE /people/:id as a profile soft-delete", async () => {
    const api = app();
    const token = await jwtFor(managerId);
    const { profileId } = await setupSoloUser(api, token, "Deepanshu");

    const soft = await api.request(`${HEALTH_API_PREFIX}/people/${profileId}`, {
      method: "DELETE",
      headers: { authorization: `Bearer ${token}` }
    });
    expect(soft.status).toBe(204);

    const session = await api.request(`${HEALTH_API_PREFIX}/me`, {
      headers: { authorization: `Bearer ${token}` }
    });
    expect(session.status).toBe(200);

    const people = await (
      await api.request(`${HEALTH_API_PREFIX}/people`, {
        headers: { authorization: `Bearer ${token}` }
      })
    ).json();
    expect(people.data).toEqual([]);
  });

  it("cannot read wiped rows after delete and keeps DELETE /me idempotent", async () => {
    const api = app();
    const token = await jwtFor(managerId);
    const { profileId } = await setupSoloUser(api, token, "Deepanshu");

    const deleted = await api.request(`${HEALTH_API_PREFIX}/me`, {
      method: "DELETE",
      headers: { authorization: `Bearer ${token}` }
    });
    expect(deleted.status).toBe(204);

    const soft = await api.request(`${HEALTH_API_PREFIX}/people/${profileId}`, {
      method: "DELETE",
      headers: { authorization: `Bearer ${token}` }
    });
    expect(soft.status).toBe(404);

    const second = await api.request(`${HEALTH_API_PREFIX}/me`, {
      method: "DELETE",
      headers: { authorization: `Bearer ${token}` }
    });
    expect(second.status).toBe(204);
  });

  it("calls Auth admin delete when a service role key is configured", async () => {
    const fetchImpl = vi.fn(async (input: RequestInfo | URL) => {
      expect(String(input)).toBe(`${supabaseUrl}/auth/v1/admin/users/${managerId}`);
      return new Response(null, { status: 200 });
    }) as unknown as typeof fetch;
    const api = app({ serviceRoleKey: "service-role-test-key", fetchImpl });
    const token = await jwtFor(managerId);
    await setupSoloUser(api, token, "Deepanshu");

    const deleted = await api.request(`${HEALTH_API_PREFIX}/me`, {
      method: "DELETE",
      headers: { authorization: `Bearer ${token}` }
    });
    expect(deleted.status).toBe(204);
    expect(fetchImpl).toHaveBeenCalledOnce();
  });
});
