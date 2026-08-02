import { describe, expect, it } from "vitest";
import { HEALTH_API_PREFIX } from "@family-os/shared";
import {
  bloodPressureEvent,
  seedHealthKitReadyGroup,
  sleepDayEvent,
  stepsHourEvent
} from "./healthKitTestHelpers";
import { SignJWT } from "jose";
import { createApp } from "../src/app";
import { HealthMcpReadService } from "../src/mcp/HealthMcpReadService";
import { resolveMetricQuery } from "../src/mcp/metricRegistry";
import { HttpError } from "../src/errors";
import { InMemoryFamilyRepository } from "../src/repositories/families";
import { repositoriesFromFamilyRepository } from "../src/dependencies";

const jwtSecret = "test-supabase-jwt-secret-with-enough-length";
const supabaseUrl = "https://project.supabase.co";
const userId = "00000000-0000-4000-8000-000000002001";
const otherUserId = "00000000-0000-4000-8000-000000002002";
const oauthClientId = "chatgpt-staging";

function fixedNow() {
  return new Date("2026-07-18T15:00:00.000Z");
}

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

async function seedUserWithSteps(repo: InMemoryFamilyRepository, subject: string) {
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
  const token = await jwtFor(subject);
  await api.request(`${HEALTH_API_PREFIX}/bootstrap`, {
    method: "POST",
    headers: { authorization: `Bearer ${token}` }
  });
  const profileResponse = await api.request(`${HEALTH_API_PREFIX}/me/profile`, {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify({ displayName: "Deepanshu" })
  });
  const profile = await profileResponse.json();
  const profileId = profile.data.id as string;

  const installationId = "53064303-35cf-4db0-a5d3-8af7d8f747e1";
  await api.request(`${HEALTH_API_PREFIX}/healthkit/settings`, {
    method: "PUT",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify({
      personId: profileId,
      consentVersion: "2026-07-18",
      enabledGroups: ["activity", "sleep", "vitals"],
      healthTimezone: "UTC",
      installationId
    })
  });

  await seedHealthKitReadyGroup(api, token, profileId, installationId, "activity", [
    stepsHourEvent("2026-07-15T08:00:00.000Z", 1200),
    stepsHourEvent("2026-07-15T14:00:00.000Z", 800),
    stepsHourEvent("2026-07-16T10:00:00.000Z", 5000),
    stepsHourEvent("2026-07-17T08:00:00.000Z", 500),
    stepsHourEvent("2026-07-17T09:00:00.000Z", 500)
  ]);

  await seedHealthKitReadyGroup(api, token, profileId, installationId, "sleep", [
    sleepDayEvent("2026-07-16")
  ]);

  await seedHealthKitReadyGroup(api, token, profileId, installationId, "vitals", [
    bloodPressureEvent({
      sourceObjectKey: "5e1ed621-4a6c-4e09-969e-31c6f0872c24",
      measuredAtUtc: "2026-07-16T09:30:00.000Z",
      systolic: 120,
      diastolic: 80,
      pulse: 70
    })
  ]);

  return { api, token, profileId };
}

describe("MCP metric registry", () => {
  it("allows a 30-day daily steps query and rejects hourly beyond 7 days", () => {
    const daily = resolveMetricQuery({ healthMetric: "steps", rangeDays: 30, granularity: "daily" });
    expect(daily.viewType).toBe("daily_series");
    expect(daily.rangeDays).toBe(30);

    expect(() => resolveMetricQuery({ healthMetric: "steps", rangeDays: 30, granularity: "hourly" })).toThrow(
      HttpError
    );
    try {
      resolveMetricQuery({ healthMetric: "steps", rangeDays: 30, granularity: "hourly" });
    } catch (error) {
      expect(error).toBeInstanceOf(HttpError);
      expect((error as HttpError).code).toBe("range_days_exceeded");
    }
  });

  it("rejects unknown metrics and free-form SQL-shaped input", () => {
    expect(() => resolveMetricQuery({ healthMetric: "export.xml", rangeDays: 7 })).toThrow(HttpError);
    expect(() => resolveMetricQuery({ healthMetric: "steps'; drop table", rangeDays: 7 })).toThrow(HttpError);
  });
});

describe("HealthMcpReadService", () => {
  it("returns an authorized 30-day steps aggregate and records an audit event", async () => {
    const repo = new InMemoryFamilyRepository();
    const { profileId } = await seedUserWithSteps(repo, userId);
    const repositories = repositoriesFromFamilyRepository(repo);
    await repositories.mcpConnections.createConnection({
      userId,
      oauthClientId,
      capabilities: ["health_read"],
      consentVersion: "2026-07-18"
    });

    const service = new HealthMcpReadService({
      ...repositories,
      now: fixedNow
    });

    const result = await service.getHealthData(
      { userId, oauthClientId, correlationId: "corr-1" },
      {
        personId: profileId,
        healthMetric: "steps",
        rangeDays: 30,
        granularity: "daily",
        timezone: "UTC"
      }
    );

    expect(result.viewType).toBe("daily_series");
    expect(result.healthMetric).toBe("steps");
    expect(result.unit).toBe("count");
    if (result.viewType !== "daily_series") {
      throw new Error("expected daily_series");
    }
    expect(result.points.length).toBeGreaterThan(0);
    expect(result.points.find((p) => p.bucket === "2026-07-15")?.value).toBe(2000);
    expect(result.coverage.requestedRangeDays).toBe(30);
    expect(result.disclaimer).toContain("Informational only");

    const managerLogs = await repositories.auditLogs.listAuditLogs(userId, 20);
    const mcpAudit = managerLogs.find((entry) => entry.action === "mcp.tool_called");
    expect(mcpAudit).toBeTruthy();
    expect(mcpAudit?.metadata?.tool_name).toBe("family_os.get_health_data");
    expect(mcpAudit?.metadata?.outcome).toBe("allowed");
    expect(mcpAudit?.metadata?.oauth_client_id).toBe(oauthClientId);
    expect(JSON.stringify(mcpAudit?.metadata ?? {})).not.toContain("2000");
  });

  it("denies clients not on the MCP OAuth allowlist even with an active grant", async () => {
    const repo = new InMemoryFamilyRepository();
    const { profileId } = await seedUserWithSteps(repo, userId);
    const repositories = repositoriesFromFamilyRepository(repo);
    await repositories.mcpConnections.createConnection({
      userId,
      oauthClientId,
      capabilities: ["health_read"],
      consentVersion: "2026-07-18"
    });

    const service = new HealthMcpReadService({
      ...repositories,
      allowedOAuthClientIds: ["only-other-client"],
      now: fixedNow
    });

    await expect(
      service.getHealthData(
        { userId, oauthClientId },
        { personId: profileId, healthMetric: "steps", rangeDays: 7 }
      )
    ).rejects.toMatchObject({ status: 403, code: "oauth_client_not_allowed" });
  });

  it("denies a different-family profile even when the UUID is supplied by the model", async () => {
    const repo = new InMemoryFamilyRepository();
    const { profileId: ownProfileId } = await seedUserWithSteps(repo, userId);
    const { profileId: otherProfileId } = await seedUserWithSteps(repo, otherUserId);

    const repositories = repositoriesFromFamilyRepository(repo);
    await repositories.mcpConnections.createConnection({
      userId,
      oauthClientId,
      capabilities: ["health_read"],
      consentVersion: "2026-07-18"
    });

    const service = new HealthMcpReadService({
      ...repositories,
      now: fixedNow
    });

    await expect(
      service.getHealthData(
        { userId, oauthClientId },
        {
          personId: otherProfileId,
          healthMetric: "steps",
          rangeDays: 30
        }
      )
    ).rejects.toMatchObject({ status: 404, code: "profile_not_found" });

    const own = await service.getHealthData(
      { userId, oauthClientId },
      { personId: ownProfileId, healthMetric: "steps", rangeDays: 30 }
    );
    expect(own.personId).toBe(ownProfileId);
  });

  it("blocks tool calls after connection revocation", async () => {
    const repo = new InMemoryFamilyRepository();
    const { profileId } = await seedUserWithSteps(repo, userId);
    const repositories = repositoriesFromFamilyRepository(repo);
    const connection = await repositories.mcpConnections.createConnection({
      userId,
      oauthClientId,
      capabilities: ["health_read"],
      consentVersion: "2026-07-18"
    });

    const service = new HealthMcpReadService({
      ...repositories,
      now: fixedNow
    });

    await repositories.mcpConnections.revokeConnection(userId, connection.id);

    await expect(
      service.getHealthData(
        { userId, oauthClientId },
        { personId: profileId, healthMetric: "sleep", rangeDays: 30 }
      )
    ).rejects.toMatchObject({ status: 403, code: "mcp_connection_required" });
  });

  it("lists authorized profiles with familiar labels and no family IDs", async () => {
    const repo = new InMemoryFamilyRepository();
    await seedUserWithSteps(repo, userId);
    const repositories = repositoriesFromFamilyRepository(repo);
    await repositories.mcpConnections.createConnection({
      userId,
      oauthClientId,
      capabilities: ["health_read"],
      consentVersion: "2026-07-18"
    });

    const service = new HealthMcpReadService({
      ...repositories,
      now: fixedNow
    });

    const listed = await service.listAuthorizedProfiles({ userId, oauthClientId });
    expect(listed.profiles.length).toBeGreaterThanOrEqual(1);
    expect(listed.profiles[0]?.label).toBeTruthy();
    expect(listed.profiles[0]?.availableMetrics).toEqual(expect.arrayContaining(["steps", "sleep", "blood_pressure", "blood_glucose", "workout", "heart_rate"]));
    expect(JSON.stringify(listed)).not.toContain("familyId");
    expect(JSON.stringify(listed)).not.toContain("dateOfBirth");
  });

  it("returns sleep as daily duration hours attributed to the end day, and blood pressure as a reading table", async () => {
    const repo = new InMemoryFamilyRepository();
    const { profileId } = await seedUserWithSteps(repo, userId);
    const repositories = repositoriesFromFamilyRepository(repo);
    await repositories.mcpConnections.createConnection({
      userId,
      oauthClientId,
      capabilities: ["health_read"],
      consentVersion: "2026-07-18"
    });
    const service = new HealthMcpReadService({ ...repositories, now: fixedNow });

    const sleep = await service.getHealthData(
      { userId, oauthClientId },
      { personId: profileId, healthMetric: "sleep", rangeDays: 30, timezone: "UTC" }
    );
    expect(sleep.viewType).toBe("daily_duration_series");
    if (sleep.viewType === "daily_duration_series") {
      expect(sleep.unit).toBe("hours");
      expect(sleep.points.find((p) => p.bucket === "2026-07-16")?.value).toBe(8);
    }

    const bp = await service.getHealthData(
      { userId, oauthClientId },
      { personId: profileId, healthMetric: "blood_pressure", rangeDays: 30, timezone: "UTC" }
    );
    expect(bp.viewType).toBe("daily_reading_table");
    if (bp.viewType === "daily_reading_table") {
      expect(bp.readings[0]?.systolic).toBe(120);
      expect(bp.readings[0]?.diastolic).toBe(80);
      expect(bp.truncated).toBe(false);
    }
  });

  it("returns daily aggregate statistics, glucose readings, and workouts from canonical HealthKit storage", async () => {
    const repo = new InMemoryFamilyRepository();
    const { api, token, profileId } = await seedUserWithSteps(repo, userId);
    const repositories = repositoriesFromFamilyRepository(repo);
    await repositories.mcpConnections.createConnection({ userId, oauthClientId, capabilities: ["health_read"], consentVersion: "2026-07-18" });
    await api.request(`${HEALTH_API_PREFIX}/healthkit/settings`, {
      method: "PUT",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({
        personId: profileId,
        consentVersion: "2026-07-18",
        enabledGroups: ["activity", "sleep", "vitals", "workouts"],
        healthTimezone: "UTC",
        installationId: "53064303-35cf-4db0-a5d3-8af7d8f747e1"
      })
    });
    const installationId = "53064303-35cf-4db0-a5d3-8af7d8f747e1";
    const hrEvent = {
      opId: crypto.randomUUID(),
      naturalKey: "daily_metric:heart_rate:2026-07-17",
      group: "vitals" as const,
      scopeKey: "heart_rate",
      op: "upsert" as const,
      payload: {
        kind: "daily_metric" as const,
        healthMetric: "heart_rate" as const,
        localDay: "2026-07-17",
        averageValue: 70,
        minimumValue: 50,
        maximumValue: 120,
        latestValue: 72,
        sampleCount: 120
      }
    };
    const glucoseEvent = {
      opId: crypto.randomUUID(),
      naturalKey: "blood_glucose:da6694a6-3f56-4a33-a9d8-3ba481670d57",
      group: "vitals" as const,
      scopeKey: "blood_glucose",
      op: "upsert" as const,
      payload: {
        kind: "blood_glucose" as const,
        sourceSampleKey: "da6694a6-3f56-4a33-a9d8-3ba481670d57",
        measuredAtUtc: "2026-07-17T08:00:00.000Z",
        valueMgDl: 104
      }
    };
    await seedHealthKitReadyGroup(api, token, profileId, installationId, "vitals", [hrEvent, glucoseEvent]);
    const workoutEvent = {
      opId: crypto.randomUUID(),
      naturalKey: "workout:e9758548-5fab-4e47-a4ac-9a05693bea71",
      group: "workouts" as const,
      scopeKey: "workout",
      op: "upsert" as const,
      payload: {
        kind: "workout" as const,
        sourceSampleKey: "e9758548-5fab-4e47-a4ac-9a05693bea71",
        workoutType: "running",
        startedAtUtc: "2026-07-17T10:00:00.000Z",
        endedAtUtc: "2026-07-17T10:30:00.000Z",
        durationSeconds: 1800,
        activeEnergyKcal: 250,
        distanceMeters: 5000,
        averageHeartRateBpm: 145,
        maximumHeartRateBpm: 170
      }
    };
    await seedHealthKitReadyGroup(api, token, profileId, installationId, "workouts", [workoutEvent]);

    const service = new HealthMcpReadService({ ...repositories, now: fixedNow });
    const heartRate = await service.getHealthData({ userId, oauthClientId }, { personId: profileId, healthMetric: "heart_rate", rangeDays: 30, timezone: "UTC" });
    expect(heartRate).toMatchObject({ viewType: "daily_series", unit: "bpm" });
    if (heartRate.viewType === "daily_series") {
      expect(heartRate.points).toEqual(expect.arrayContaining([expect.objectContaining({ bucket: "2026-07-17", value: 70, averageValue: 70, maximumValue: 120 })]));
    }

    const glucose = await service.getHealthData({ userId, oauthClientId }, { personId: profileId, healthMetric: "blood_glucose", rangeDays: 30, timezone: "UTC" });
    expect(glucose).toMatchObject({ healthMetric: "blood_glucose", viewType: "daily_reading_table" });
    if (glucose.healthMetric === "blood_glucose") expect(glucose.readings[0]).toMatchObject({ valueMgDl: 104 });

    const workouts = await service.getHealthData({ userId, oauthClientId }, { personId: profileId, healthMetric: "workout", rangeDays: 30, timezone: "UTC" });
    expect(workouts).toMatchObject({ healthMetric: "workout", viewType: "workout_table" });
    if (workouts.healthMetric === "workout") expect(workouts.workouts[0]).toMatchObject({ workoutType: "running", durationMinutes: 30 });
  });

  it("withholds sleep points after timezone change until backfill completes", async () => {
    const repo = new InMemoryFamilyRepository();
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
    const token = await jwtFor(userId);
    await api.request(`${HEALTH_API_PREFIX}/bootstrap`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}` }
    });
    const profile = await (
      await api.request(`${HEALTH_API_PREFIX}/me/profile`, {
        method: "POST",
        headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
        body: JSON.stringify({ displayName: "Deepanshu" })
      })
    ).json();
    const profileId = profile.data.id as string;
    const installationId = "53064303-35cf-4db0-a5d3-8af7d8f747e1";
    await api.request(`${HEALTH_API_PREFIX}/healthkit/settings`, {
      method: "PUT",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({
        personId: profileId,
        consentVersion: "2026-07-18",
        enabledGroups: ["sleep"],
        healthTimezone: "UTC",
        installationId
      })
    });
    await seedHealthKitReadyGroup(api, token, profileId, installationId, "sleep", [
      sleepDayEvent("2026-07-16")
    ]);

    await api.request(`${HEALTH_API_PREFIX}/healthkit/settings`, {
      method: "PUT",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({
        personId: profileId,
        consentVersion: "2026-07-18",
        enabledGroups: ["sleep"],
        healthTimezone: "Asia/Bangkok",
        installationId
      })
    });

    const repositories = repositoriesFromFamilyRepository(repo);
    await repositories.mcpConnections.createConnection({
      userId,
      oauthClientId,
      capabilities: ["health_read"],
      consentVersion: "2026-07-18"
    });
    const service = new HealthMcpReadService({ ...repositories, now: fixedNow });
    const withheld = await service.getHealthData(
      { userId, oauthClientId },
      { personId: profileId, healthMetric: "sleep", rangeDays: 30, timezone: "UTC" }
    );
    expect(withheld.metricSyncStatus).toBe("never_synced");
    expect(withheld.healthTimezone).toBe("Asia/Bangkok");
    expect(withheld.coverage.complete).toBe(false);
    if (withheld.viewType === "daily_duration_series") {
      expect(withheld.points).toEqual([]);
    }
  });

  it("withholds step points while a metric repair is incomplete", async () => {
    const repo = new InMemoryFamilyRepository();
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
    const token = await jwtFor(userId);
    await api.request(`${HEALTH_API_PREFIX}/bootstrap`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}` }
    });
    const profile = await (
      await api.request(`${HEALTH_API_PREFIX}/me/profile`, {
        method: "POST",
        headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
        body: JSON.stringify({ displayName: "Deepanshu" })
      })
    ).json();
    const profileId = profile.data.id as string;
    const installationId = "53064303-35cf-4db0-a5d3-8af7d8f747e1";
    await api.request(`${HEALTH_API_PREFIX}/healthkit/settings`, {
      method: "PUT",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({
        personId: profileId,
        consentVersion: "2026-07-18",
        enabledGroups: ["activity"],
        healthTimezone: "UTC",
        installationId
      })
    });
    // Start import (syncing) without marking ready.
    await api.request(`${HEALTH_API_PREFIX}/healthkit/groups/activity/start-import`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({
        installationId,
        personId: profileId,
        timezoneVersion: 1
      })
    });
    const step = stepsHourEvent("2026-07-15T08:00:00.000Z", 9999);
    await api.request(`${HEALTH_API_PREFIX}/healthkit/ops:batch`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({
        installationId,
        personId: profileId,
        timezoneVersion: 1,
        ops: [step]
      })
    });

    const repositories = repositoriesFromFamilyRepository(repo);
    await repositories.mcpConnections.createConnection({
      userId,
      oauthClientId,
      capabilities: ["health_read"],
      consentVersion: "2026-07-18"
    });
    const service = new HealthMcpReadService({ ...repositories, now: fixedNow });
    const partial = await service.getHealthData(
      { userId, oauthClientId },
      { personId: profileId, healthMetric: "steps", rangeDays: 30, timezone: "UTC" }
    );
    expect(partial.metricSyncStatus).toBe("syncing");
    expect(partial.coverage.complete).toBe(false);
    if (partial.viewType === "daily_series") {
      expect(partial.points).toEqual([]);
    }

    const readyRes = await api.request(`${HEALTH_API_PREFIX}/healthkit/groups/activity/ready`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({
        installationId,
        personId: profileId,
        timezoneVersion: 1
      })
    });
    expect(readyRes.status).toBe(200);
    const ready = await service.getHealthData(
      { userId, oauthClientId },
      { personId: profileId, healthMetric: "steps", rangeDays: 30, timezone: "UTC" }
    );
    expect(ready.metricSyncStatus).toBe("ready");
    if (ready.viewType === "daily_series") {
      expect(ready.points.find((p) => p.bucket === "2026-07-15")?.value).toBe(9999);
    }
  });

  it("aggregates hourly steps within a 7-day window and splits spanning samples", async () => {
    const repo = new InMemoryFamilyRepository();
    const { profileId } = await seedUserWithSteps(repo, userId);
    const repositories = repositoriesFromFamilyRepository(repo);
    await repositories.mcpConnections.createConnection({
      userId,
      oauthClientId,
      capabilities: ["health_read"],
      consentVersion: "2026-07-18"
    });
    const service = new HealthMcpReadService({ ...repositories, now: fixedNow });

    const hourly = await service.getHealthData(
      { userId, oauthClientId },
      {
        personId: profileId,
        healthMetric: "steps",
        rangeDays: 7,
        granularity: "hourly",
        timezone: "UTC"
      }
    );
    expect(hourly.viewType).toBe("hourly_series");
    if (hourly.viewType === "hourly_series") {
      expect(hourly.points.find((p) => p.bucket === "2026-07-15T08:00")?.value).toBe(1200);
      expect(hourly.points.find((p) => p.bucket === "2026-07-15T14:00")?.value).toBe(800);
      expect(hourly.points.find((p) => p.bucket === "2026-07-17T08:00")?.value).toBeCloseTo(500, 5);
      expect(hourly.points.find((p) => p.bucket === "2026-07-17T09:00")?.value).toBeCloseTo(500, 5);
    }
  });
});
