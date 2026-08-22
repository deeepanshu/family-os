import { describe, expect, it } from "vitest";
import {
  HEALTH_API_PREFIX,
  MCP_HEALTH_METRICS,
  MCP_HEALTH_METRIC_FOR_PRODUCT_GROUP,
  mcpHealthMetricsForEnabledGroups
} from "@family-os/shared";
import { bloodPressureOp, postOps, seedHealthKitReadyGroup, sleepDayOp, stepsHourOp, workoutOp as makeWorkoutOp, beginRun } from "./healthKitTestHelpers";

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
const installationId = "53064303-35cf-4db0-a5d3-8af7d8f747e1";

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

const workoutOp = {
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

async function seedUserWithHealthData(
  repo: InMemoryFamilyRepository,
  subject: string,
  options: { readyActivity?: boolean } = {}
) {
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

  // Household optional for MCP; keep one for multi-profile access tests.
  await api.request(`${HEALTH_API_PREFIX}/families`, {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify({ name: "Test Family" })
  });

  await api.request(`${HEALTH_API_PREFIX}/healthkit/settings`, {
    method: "PUT",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify({
      personId: profileId,
      consentVersion: "2026-07-18",
      enabledGroups: ["activity", "sleep", "vitals", "workouts"],
      healthTimezone: "UTC",
      installationId
    })
  });

  await seedHealthKitReadyGroup(api, token, profileId, installationId, "sleep", [
    sleepDayOp("2026-07-16")
  ]);

  if (options.readyActivity !== false) {
    await seedHealthKitReadyGroup(api, token, profileId, installationId, "activity", [
      stepsHourOp("2026-07-16T09:00:00.000Z", 1_234)
    ]);
  }

  await seedHealthKitReadyGroup(api, token, profileId, installationId, "vitals", [
    bloodPressureOp({
      sourceObjectKey: "5e1ed621-4a6c-4e09-969e-31c6f0872c24",
      measuredAtUtc: "2026-07-16T09:30:00.000Z",
      systolic: 120,
      diastolic: 80,
      pulse: 70
    })
  ]);

  await seedHealthKitReadyGroup(api, token, profileId, installationId, "workouts", [workoutOp]);

  return { api, token, profileId };
}

async function serviceFor(repo: InMemoryFamilyRepository, options: { allowedOAuthClientIds?: string[] } = {}) {
  const repositories = repositoriesFromFamilyRepository(repo);
  await repositories.mcpConnections.createConnection({
    userId,
    oauthClientId,
    capabilities: ["health_read"],
    consentVersion: "2026-07-18"
  });
  return new HealthMcpReadService({ ...repositories, now: fixedNow, ...options });
}

describe("MCP product allowlist contract", () => {
  it("exposes exactly steps, blood_pressure, sleep, and workout", () => {
    expect([...MCP_HEALTH_METRICS].sort()).toEqual(["blood_pressure", "sleep", "steps", "workout"]);
  });

  it("maps each enabled app toggle to its explicit MCP metric", () => {
    expect(MCP_HEALTH_METRIC_FOR_PRODUCT_GROUP).toEqual({
      activity: "steps",
      vitals: "blood_pressure",
      sleep: "sleep",
      workouts: "workout"
    });
    expect(mcpHealthMetricsForEnabledGroups(["activity"])).toEqual(["steps"]);
    expect(mcpHealthMetricsForEnabledGroups(["vitals"])).toEqual(["blood_pressure"]);
    expect(mcpHealthMetricsForEnabledGroups(["sleep"])).toEqual(["sleep"]);
    expect(mcpHealthMetricsForEnabledGroups(["workouts"])).toEqual(["workout"]);
    // Broad groups never expand into registry metrics.
    expect(mcpHealthMetricsForEnabledGroups(["body", "mobility", "mindfulness_environment", "nutrition"])).toEqual([]);
  });

  it("rejects unknown and previously registry-derived metrics", () => {
    for (const metric of ["heart_rate", "blood_glucose", "oxygen_saturation", "export.xml", "steps'; drop table"]) {
      try {
        resolveMetricQuery({ healthMetric: metric, rangeDays: 7 });
        throw new Error(`expected ${metric} to be rejected`);
      } catch (error) {
        expect(error).toBeInstanceOf(HttpError);
        expect((error as HttpError).code).toBe("unsupported_metric");
      }
    }
  });

  it("rejects sleep attribute metrics and points callers at sleep", () => {
    for (const healthMetric of ["sleeping_wrist_temperature", "sleep_breathing_disturbance_events"] as const) {
      try {
        resolveMetricQuery({ healthMetric, rangeDays: 7 });
        throw new Error(`expected ${healthMetric} to be rejected`);
      } catch (error) {
        expect(error).toBeInstanceOf(HttpError);
        expect((error as HttpError).code).toBe("unsupported_metric");
        expect((error as HttpError).message).toMatch(/sleep/i);
      }
    }
  });

  it("enforces the 90-day range bound", () => {
    expect(resolveMetricQuery({ healthMetric: "sleep", rangeDays: 90 }).viewType).toBe("daily_duration_series");
    try {
      resolveMetricQuery({ healthMetric: "sleep", rangeDays: 91 });
      throw new Error("expected range rejection");
    } catch (error) {
      expect((error as HttpError).code).toBe("range_days_exceeded");
    }
  });
});

describe("HealthMcpReadService", () => {
  it("withholds enabled Steps until the Activity import is ready", async () => {
    const repo = new InMemoryFamilyRepository();
    const { profileId } = await seedUserWithHealthData(repo, userId, { readyActivity: false });
    const service = await serviceFor(repo);

    const listed = await service.listAuthorizedProfiles({ userId, oauthClientId });
    expect(listed.profiles[0]?.availableMetrics).not.toContain("steps");
    await expect(
      service.getHealthData(
        { userId, oauthClientId },
        { personId: profileId, healthMetric: "steps", rangeDays: 30, timezone: "UTC" }
      )
    ).rejects.toMatchObject({ status: 409, code: "healthkit_sync_incomplete" });
  });

  it("returns authorized steps, blood pressure, sleep, and workout data and records an audit event", async () => {
    const repo = new InMemoryFamilyRepository();
    const { profileId } = await seedUserWithHealthData(repo, userId);
    const service = await serviceFor(repo);

    const steps = await service.getHealthData(
      { userId, oauthClientId },
      { personId: profileId, healthMetric: "steps", rangeDays: 30, timezone: "UTC" }
    );
    expect(steps).toMatchObject({
      healthMetric: "steps",
      viewType: "hourly_count_series",
      unit: "count",
      points: [{ hourStartUtc: "2026-07-16T09:00:00.000Z", count: 1_234 }]
    });

    const bp = await service.getHealthData(
      { userId, oauthClientId, correlationId: "corr-1" },
      { personId: profileId, healthMetric: "blood_pressure", rangeDays: 30, timezone: "UTC" }
    );
    expect(bp.viewType).toBe("daily_reading_table");
    if (bp.viewType === "daily_reading_table") {
      expect(bp.readings[0]?.systolic).toBe(120);
      expect(bp.readings[0]?.diastolic).toBe(80);
      expect(bp.truncated).toBe(false);
    }
    expect(bp.unit).toBe("mmHg");
    expect(bp.lastSyncedAt).toBeTruthy();
    expect(bp.coverage.requestedRangeDays).toBe(30);
    // Response contract: no disclaimer or metric sync status anywhere.
    expect(JSON.stringify(bp)).not.toContain("disclaimer");
    expect(JSON.stringify(bp)).not.toContain("metricSyncStatus");

    const sleep = await service.getHealthData(
      { userId, oauthClientId },
      { personId: profileId, healthMetric: "sleep", rangeDays: 30, timezone: "UTC" }
    );
    expect(sleep.viewType).toBe("daily_duration_series");
    if (sleep.viewType === "daily_duration_series") {
      expect(sleep.unit).toBe("hours");
      expect(sleep.points.find((p) => p.bucket === "2026-07-16")?.value).toBe(8);
    }

    const workouts = await service.getHealthData(
      { userId, oauthClientId },
      { personId: profileId, healthMetric: "workout", rangeDays: 30, timezone: "UTC" }
    );
    expect(workouts.viewType).toBe("workout_table");
    if (workouts.viewType === "workout_table") {
      expect(workouts.workouts[0]).toMatchObject({ workoutType: "running", durationMinutes: 30 });
    }

    const repositories = repositoriesFromFamilyRepository(repo);
    const managerLogs = await repositories.auditLogs.listAuditLogs(userId, 20);
    const mcpAudit = managerLogs.find((entry) => entry.action === "mcp.tool_called");
    expect(mcpAudit).toBeTruthy();
    expect(mcpAudit?.metadata?.tool_name).toBe("family_os.get_health_data");
    expect(mcpAudit?.metadata?.outcome).toBe("allowed");
    expect(mcpAudit?.metadata?.oauth_client_id).toBe(oauthClientId);
    expect(JSON.stringify(mcpAudit?.metadata ?? {})).not.toContain("120");
  });

  it("includes saved strength exercises on workout_table rows", async () => {
    const repo = new InMemoryFamilyRepository();
    const { api, token, profileId } = await seedUserWithHealthData(repo, userId);
    const strengthKey = "b9758548-5fab-4e47-a4ac-9a05693bea71";
    const batch = await postOps(api, token, profileId, installationId, [
      makeWorkoutOp({
        sourceSampleKey: strengthKey,
        workoutType: "traditional_strength_training",
        startedAtUtc: "2026-07-17T11:00:00.000Z",
        endedAtUtc: "2026-07-17T11:40:00.000Z",
        durationSeconds: 2400
      })
    ]);
    expect(batch.status).toBe(200);
    const exercises = [{ name: "Hip Thrusts", sets: [{ reps: 6, weightKg: 90 }] }];
    const put = await api.request(`${HEALTH_API_PREFIX}/readings/workouts/${strengthKey}/exercises`, {
      method: "PUT",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({ exercises })
    });
    expect(put.status).toBe(200);

    const service = await serviceFor(repo);
    const workouts = await service.getHealthData(
      { userId, oauthClientId },
      { personId: profileId, healthMetric: "workout", rangeDays: 30, timezone: "UTC" }
    );
    expect(workouts.viewType).toBe("workout_table");
    if (workouts.viewType === "workout_table") {
      const strength = workouts.workouts.find((row) => row.workoutType === "traditional_strength_training");
      expect(strength?.exercises).toEqual(exercises);
    }
  });


  it("denies clients not on the MCP OAuth allowlist even with an active grant", async () => {
    const repo = new InMemoryFamilyRepository();
    const { profileId } = await seedUserWithHealthData(repo, userId);
    const service = await serviceFor(repo, { allowedOAuthClientIds: ["only-other-client"] });

    await expect(
      service.getHealthData(
        { userId, oauthClientId },
        { personId: profileId, healthMetric: "sleep", rangeDays: 7 }
      )
    ).rejects.toMatchObject({ status: 403, code: "oauth_client_not_allowed" });
  });

  it("denies a different-family profile even when the UUID is supplied by the model", async () => {
    const repo = new InMemoryFamilyRepository();
    const { profileId: ownProfileId } = await seedUserWithHealthData(repo, userId);
    const { profileId: otherProfileId } = await seedUserWithHealthData(repo, otherUserId);
    const service = await serviceFor(repo);

    await expect(
      service.getHealthData(
        { userId, oauthClientId },
        { personId: otherProfileId, healthMetric: "sleep", rangeDays: 30 }
      )
    ).rejects.toMatchObject({ status: 403, code: "profile_forbidden" });

    const own = await service.getHealthData(
      { userId, oauthClientId },
      { personId: ownProfileId, healthMetric: "sleep", rangeDays: 30 }
    );
    expect(own.personId).toBe(ownProfileId);
  });

  it("blocks tool calls after connection revocation", async () => {
    const repo = new InMemoryFamilyRepository();
    const { profileId } = await seedUserWithHealthData(repo, userId);
    const repositories = repositoriesFromFamilyRepository(repo);
    const connection = await repositories.mcpConnections.createConnection({
      userId,
      oauthClientId,
      capabilities: ["health_read"],
      consentVersion: "2026-07-18"
    });
    const service = new HealthMcpReadService({ ...repositories, now: fixedNow });

    await repositories.mcpConnections.revokeConnection(userId, connection.id);

    await expect(
      service.getHealthData(
        { userId, oauthClientId },
        { personId: profileId, healthMetric: "sleep", rangeDays: 30 }
      )
    ).rejects.toMatchObject({ status: 403, code: "mcp_connection_required" });
  });

  it("lists authorized profiles with the enabled-subset metrics only, without a disclaimer", async () => {
    const repo = new InMemoryFamilyRepository();
    await seedUserWithHealthData(repo, userId);
    const service = await serviceFor(repo);

    const listed = await service.listAuthorizedProfiles({ userId, oauthClientId });
    expect(listed.profiles.length).toBeGreaterThanOrEqual(1);
    expect(listed.profiles[0]?.label).toBeTruthy();
    // Seed enables Activity + Vitals + Sleep + Workouts, each with its explicit product metric.
    expect(listed.profiles[0]?.availableMetrics).toEqual(["steps", "blood_pressure", "sleep", "workout"]);
    expect(JSON.stringify(listed)).not.toContain("disclaimer");
    expect(JSON.stringify(listed)).not.toContain("familyId");
    expect(JSON.stringify(listed)).not.toContain("dateOfBirth");
  });

  it("enabling Blood pressure never advertises heart rate, glucose, temperature, or oxygen saturation", async () => {
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
        body: JSON.stringify({ displayName: "Solo Self" })
      })
    ).json();
    const profileId = profile.data.id as string;
    await api.request(`${HEALTH_API_PREFIX}/healthkit/settings`, {
      method: "PUT",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({
        personId: profileId,
        consentVersion: "2026-07-18",
        enabledGroups: ["vitals"],
        healthTimezone: "UTC",
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

    const listed = await service.listAuthorizedProfiles({ userId, oauthClientId });
    expect(listed.profiles).toEqual([
      expect.objectContaining({
        personId: profileId,
        availableMetrics: ["blood_pressure"]
      })
    ]);
  });

  it("refuses get_health_data after the app toggle is disabled", async () => {
    const repo = new InMemoryFamilyRepository();
    const { api, token, profileId } = await seedUserWithHealthData(repo, userId);
    const service = await serviceFor(repo);

    const before = await service.getHealthData(
      { userId, oauthClientId },
      { personId: profileId, healthMetric: "blood_pressure", rangeDays: 30, timezone: "UTC" }
    );
    expect(before.viewType).toBe("daily_reading_table");

    // Disable Blood pressure and Sleep; keep Workouts only.
    await api.request(`${HEALTH_API_PREFIX}/healthkit/settings`, {
      method: "PUT",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({
        personId: profileId,
        consentVersion: "2026-07-18",
        enabledGroups: ["workouts"],
        healthTimezone: "UTC",
        installationId
      })
    });

    const listed = await service.listAuthorizedProfiles({ userId, oauthClientId });
    expect(listed.profiles[0]?.availableMetrics).toEqual(["workout"]);

    await expect(
      service.getHealthData(
        { userId, oauthClientId },
        { personId: profileId, healthMetric: "blood_pressure", rangeDays: 30, timezone: "UTC" }
      )
    ).rejects.toMatchObject({ code: "group_disabled", status: 403 });

    // Workouts still readable.
    const workouts = await service.getHealthData(
      { userId, oauthClientId },
      { personId: profileId, healthMetric: "workout", rangeDays: 30, timezone: "UTC" }
    );
    expect(workouts.viewType).toBe("workout_table");
  });

  it("returns stored rows while a phone import is in progress or interrupted (data-first)", async () => {
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
    await api.request(`${HEALTH_API_PREFIX}/families`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({ name: "Test Family" })
    });
    await api.request(`${HEALTH_API_PREFIX}/healthkit/settings`, {
      method: "PUT",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({
        personId: profileId,
        consentVersion: "2026-07-18",
        enabledGroups: ["vitals"],
        healthTimezone: "UTC",
        installationId
      })
    });

    // Begin an initial import (phone shows syncing) and upload one record, then
    // disappear without completing — the interrupted phone state.
    const begin = await beginRun(api, token, profileId, installationId, "vitals", "initial_import");
    expect(begin.status).toBe(200);
    const descriptor = (await begin.json()).data;
    const batch = await postOps(api, token, profileId, installationId, [
      bloodPressureOp({
        sourceObjectKey: "5e1ed621-4a6c-4e09-969e-31c6f0872c24",
        measuredAtUtc: "2026-07-16T09:30:00.000Z",
        systolic: 121,
        diastolic: 81
      })
    ]);
    expect(batch.status).toBe(200);

    const service = await serviceFor(repo);
    const interrupted = await service.getHealthData(
      { userId, oauthClientId },
      { personId: profileId, healthMetric: "blood_pressure", rangeDays: 30, timezone: "UTC" }
    );
    expect(interrupted.viewType).toBe("daily_reading_table");
    if (interrupted.viewType === "daily_reading_table") {
      expect(interrupted.readings[0]?.systolic).toBe(121);
    }
    // No completed coverage yet; completeness is separate from presence.
    expect(interrupted.coverage.complete).toBe(false);
    expect(interrupted.lastSyncedAt).toBeUndefined();

    const complete = await api.request(
      `${HEALTH_API_PREFIX}/healthkit/groups/vitals/runs/complete`,
      {
        method: "POST",
        headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
        body: JSON.stringify({
          installationId,
          personId: profileId,
          timezoneVersion: 1,
          kind: "initial_import",
          rangeStartAt: descriptor.rangeStartAt,
          rangeEndAt: descriptor.rangeEndAt
        })
      }
    );
    expect(complete.status).toBe(200);

    const ready = await service.getHealthData(
      { userId, oauthClientId },
      { personId: profileId, healthMetric: "blood_pressure", rangeDays: 30, timezone: "UTC" }
    );
    expect(ready.lastSyncedAt).toBeTruthy();
    if (ready.viewType === "daily_reading_table") {
      expect(ready.readings[0]?.systolic).toBe(121);
    }
  });

  it("keeps completed coverage semantics when a newer attempt is in progress", async () => {
    const repo = new InMemoryFamilyRepository();
    const { api, token, profileId } = await seedUserWithHealthData(repo, userId);
    const service = await serviceFor(repo);

    const baseline = await service.getHealthData(
      { userId, oauthClientId },
      { personId: profileId, healthMetric: "sleep", rangeDays: 30, timezone: "UTC" }
    );
    expect(baseline.coverage.complete).toBe(true);

    // A newer sync begins (server attempt state is syncing) but coverage is intact.
    const begin = await beginRun(api, token, profileId, installationId, "sleep", "sync");
    expect(begin.status).toBe(200);

    const midAttempt = await service.getHealthData(
      { userId, oauthClientId },
      { personId: profileId, healthMetric: "sleep", rangeDays: 30, timezone: "UTC" }
    );
    expect(midAttempt.coverage.complete).toBe(true);
    if (midAttempt.viewType === "daily_duration_series") {
      expect(midAttempt.points.find((p) => p.bucket === "2026-07-16")?.value).toBe(8);
    }
  });

  it("marks coverage incomplete after a timezone change until a new import completes", async () => {
    const repo = new InMemoryFamilyRepository();
    const { api, token, profileId } = await seedUserWithHealthData(repo, userId);

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

    const service = await serviceFor(repo);
    const afterTz = await service.getHealthData(
      { userId, oauthClientId },
      { personId: profileId, healthMetric: "sleep", rangeDays: 30, timezone: "UTC" }
    );
    expect(afterTz.healthTimezone).toBe("Asia/Bangkok");
    expect(afterTz.coverage.complete).toBe(false);
    // Prior timezone version rows are not read; no current-version data yet.
    if (afterTz.viewType === "daily_duration_series") {
      expect(afterTz.points).toEqual([]);
    }
  });
});
