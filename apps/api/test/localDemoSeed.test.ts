import { SignJWT } from "jose";
import { describe, expect, it } from "vitest";
import { HEALTH_API_PREFIX } from "@family-os/shared";
import { createApp } from "../src/app";
import { repositoriesFromFamilyRepository } from "../src/dependencies";
import {
  LOCAL_DEMO_FAMILY_NAME,
  LOCAL_DEMO_USER_ID,
  seedLocalDemo
} from "../src/localDemoSeed";
import { assertLocalSeedTarget, LocalDemoSeedError } from "../src/localDemoSeedGuard";
import { InMemoryFamilyRepository } from "../src/repositories/families";

const jwtSecret = "test-supabase-jwt-secret-with-enough-length";
const supabaseUrl = "https://project.supabase.co";
const asOf = new Date("2026-08-23T12:00:00.000Z");

async function jwtFor(subject: string) {
  return new SignJWT({ role: "authenticated", email: `${subject}@example.com` })
    .setProtectedHeader({ alg: "HS256" })
    .setSubject(subject)
    .setIssuer(`${supabaseUrl}/auth/v1`)
    .setAudience("authenticated")
    .setIssuedAt()
    .setExpirationTime("1h")
    .sign(new TextEncoder().encode(jwtSecret));
}

describe("assertLocalSeedTarget", () => {
  it("allows the four loopback host forms", () => {
    expect(() =>
      assertLocalSeedTarget({
        nodeEnv: "development",
        databaseUrl: "postgres://family_os:family_os@localhost:5432/family_os"
      })
    ).not.toThrow();
    expect(() =>
      assertLocalSeedTarget({
        nodeEnv: "development",
        databaseUrl: "postgres://family_os:family_os@127.0.0.1:5432/family_os"
      })
    ).not.toThrow();
    expect(() =>
      assertLocalSeedTarget({
        nodeEnv: "development",
        databaseUrl: "postgres://family_os:family_os@[::1]:5432/family_os"
      })
    ).not.toThrow();
    expect(() =>
      assertLocalSeedTarget({
        nodeEnv: "test",
        databaseUrl: "postgres://family_os:family_os@[::1]:5432/family_os"
      })
    ).not.toThrow();
    expect(new URL("postgres://family_os:family_os@[::1]:5432/family_os").hostname).toBe("[::1]");
  });

  it("rejects production and non-loopback hosts", () => {
    expect(() =>
      assertLocalSeedTarget({
        nodeEnv: "production",
        databaseUrl: "postgres://family_os:family_os@localhost:5432/family_os"
      })
    ).toThrow(LocalDemoSeedError);
    expect(() =>
      assertLocalSeedTarget({
        nodeEnv: "development",
        databaseUrl: "postgres://postgres:postgres@db.xxx.supabase.co:5432/postgres"
      })
    ).toThrow(LocalDemoSeedError);
    expect(() =>
      assertLocalSeedTarget({
        nodeEnv: "development",
        databaseUrl: "postgres://family_os:family_os@homelab-postgres:5432/family_os"
      })
    ).toThrow(LocalDemoSeedError);
  });
});

describe("local demo seed", () => {
  it("is idempotent for a fixed asOf and satisfies the route-level demo contract", async () => {
    const repo = new InMemoryFamilyRepository();
    const stores = repositoriesFromFamilyRepository(repo);
    const first = await seedLocalDemo(stores, { userId: LOCAL_DEMO_USER_ID, asOf });
    const second = await seedLocalDemo(stores, { userId: LOCAL_DEMO_USER_ID, asOf });
    expect(second.profileId).toBe(first.profileId);
    expect(second.familyId).toBe(first.familyId);

    const api = createApp({
      config: {
        NODE_ENV: "test",
        PORT: 3001,
        HEALTH_API_ENABLE_DEV_AUTH: false,
        SUPABASE_JWT_SECRET: jwtSecret,
        SUPABASE_URL: supabaseUrl
      },
      familyRepository: repo
    });
    const token = await jwtFor(LOCAL_DEMO_USER_ID);
    const auth = { authorization: `Bearer ${token}` };

    const bootstrap = await (
      await api.request(`${HEALTH_API_PREFIX}/bootstrap`, { method: "POST", headers: auth })
    ).json();
    expect(bootstrap.data.selfProfile.id).toBe(first.profileId);

    const current = await (await api.request(`${HEALTH_API_PREFIX}/families/current`, { headers: auth })).json();
    expect(current.data.family.name).toBe(LOCAL_DEMO_FAMILY_NAME);
    expect(current.data.membership.userId).toBe(LOCAL_DEMO_USER_ID);

    const members = await (await api.request(`${HEALTH_API_PREFIX}/families/members`, { headers: auth })).json();
    expect(members.data.some((member: { membership: { userId: string } }) => member.membership.userId === LOCAL_DEMO_USER_ID)).toBe(
      true
    );

    const people = await (await api.request(`${HEALTH_API_PREFIX}/people`, { headers: auth })).json();
    expect(people.data.some((profile: { relationshipLabel: string }) => profile.relationshipLabel === "Self")).toBe(true);

    const settings = await (await api.request(`${HEALTH_API_PREFIX}/healthkit/settings`, { headers: auth })).json();
    const readyGroups = settings.data.groups.filter((group: { group: string; status: string }) =>
      ["activity", "sleep", "vitals", "workouts"].includes(group.group)
    );
    expect(readyGroups).toHaveLength(4);
    expect(readyGroups.every((group: { status: string }) => group.status === "ready")).toBe(true);

    const bloodPressure = await (
      await api.request(`${HEALTH_API_PREFIX}/readings/blood-pressure`, { headers: auth })
    ).json();
    expect(bloodPressure.data.length).toBeGreaterThan(0);
    expect(bloodPressure.data[0].systolic).toEqual(expect.any(Number));

    const from = "2026-08-10";
    const to = "2026-08-23";
    const query = `personId=${first.profileId}&from=${from}&to=${to}`;

    const sleep = await (await api.request(`${HEALTH_API_PREFIX}/readings/sleep?${query}`, { headers: auth })).json();
    expect(sleep.data).toHaveLength(14);

    const steps = await (await api.request(`${HEALTH_API_PREFIX}/readings/steps?${query}`, { headers: auth })).json();
    expect(steps.data).toHaveLength(14);

    const workouts = await (await api.request(`${HEALTH_API_PREFIX}/readings/workouts?${query}`, { headers: auth })).json();
    expect(workouts.data).toHaveLength(3);
    const strength = workouts.data.find(
      (workout: { workoutType: string; exercises?: unknown[] }) => workout.workoutType === "traditional_strength_training"
    );
    expect(strength?.exercises?.length).toBe(2);
  });
});
