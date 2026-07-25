import { describe, expect, it } from "vitest";
import { HEALTH_API_PREFIX } from "@family-os/shared";
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
      enabledMetrics: ["steps", "sleep", "blood_pressure"],
      healthTimezone: "UTC",
      installationId
    })
  });

  const repair = await (
    await api.request(`${HEALTH_API_PREFIX}/healthkit/repairs`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({
        installationId,
        personId: profileId,
        metric: "steps",
        timezoneVersion: 1
      })
    })
  ).json();

  await api.request(`${HEALTH_API_PREFIX}/healthkit/sync`, {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify({
      syncId: "7afbe594-7e1d-4b31-a9a1-420b7fba4201",
      installationId,
      personId: profileId,
      timezoneVersion: 1,
      repairId: repair.data.repairId,
      chunkIndex: 0,
      operations: [
        { kind: "steps_hour_upsert", hourStartUtc: "2026-07-15T08:00:00.000Z", count: 1200 },
        { kind: "steps_hour_upsert", hourStartUtc: "2026-07-15T14:00:00.000Z", count: 800 },
        { kind: "steps_hour_upsert", hourStartUtc: "2026-07-16T10:00:00.000Z", count: 5000 },
        { kind: "steps_hour_upsert", hourStartUtc: "2026-07-17T08:00:00.000Z", count: 500 },
        { kind: "steps_hour_upsert", hourStartUtc: "2026-07-17T09:00:00.000Z", count: 500 }
      ]
    })
  });
  await api.request(`${HEALTH_API_PREFIX}/healthkit/repairs/${repair.data.repairId}/complete`, {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify({ expectedChunkCount: 1 })
  });

  const sleepRepair = await (
    await api.request(`${HEALTH_API_PREFIX}/healthkit/repairs`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({
        installationId,
        personId: profileId,
        metric: "sleep",
        timezoneVersion: 1
      })
    })
  ).json();
  await api.request(`${HEALTH_API_PREFIX}/healthkit/sync`, {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify({
      syncId: "7afbe594-7e1d-4b31-a9a1-420b7fba4202",
      installationId,
      personId: profileId,
      timezoneVersion: 1,
      repairId: sleepRepair.data.repairId,
      chunkIndex: 0,
      operations: [{ kind: "sleep_day_upsert", sleepDay: "2026-07-16", durationMinutes: 480 }]
    })
  });
  await api.request(`${HEALTH_API_PREFIX}/healthkit/repairs/${sleepRepair.data.repairId}/complete`, {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify({ expectedChunkCount: 1 })
  });

  const bpRepair = await (
    await api.request(`${HEALTH_API_PREFIX}/healthkit/repairs`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({
        installationId,
        personId: profileId,
        metric: "blood_pressure",
        timezoneVersion: 1
      })
    })
  ).json();
  await api.request(`${HEALTH_API_PREFIX}/healthkit/sync`, {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify({
      syncId: "7afbe594-7e1d-4b31-a9a1-420b7fba4203",
      installationId,
      personId: profileId,
      timezoneVersion: 1,
      repairId: bpRepair.data.repairId,
      chunkIndex: 0,
      operations: [
        {
          kind: "blood_pressure_upsert",
          sourceSampleKey: "5e1ed621-4a6c-4e09-969e-31c6f0872c24",
          measuredAtUtc: "2026-07-16T09:30:00.000Z",
          systolic: 120,
          diastolic: 80,
          pulse: 70
        }
      ]
    })
  });
  await api.request(`${HEALTH_API_PREFIX}/healthkit/repairs/${bpRepair.data.repairId}/complete`, {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify({ expectedChunkCount: 1 })
  });

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
    expect(listed.profiles[0]?.availableMetrics).toEqual(["steps", "sleep", "blood_pressure"]);
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

  it("withholds sleep points after timezone change until repair completes", async () => {
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
        enabledMetrics: ["sleep"],
        healthTimezone: "UTC",
        installationId
      })
    });
    await api.request(`${HEALTH_API_PREFIX}/healthkit/sync`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({
        syncId: "7afbe594-7e1d-4b31-a9a1-420b7fba42f1",
        installationId,
        personId: profileId,
        timezoneVersion: 1,
        operations: [{ kind: "sleep_day_upsert", sleepDay: "2026-07-16", durationMinutes: 480 }]
      })
    });

    await api.request(`${HEALTH_API_PREFIX}/healthkit/settings`, {
      method: "PUT",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({
        personId: profileId,
        consentVersion: "2026-07-18",
        enabledMetrics: ["sleep"],
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
    expect(withheld.metricSyncStatus).toBe("repair_needed");
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
        enabledMetrics: ["steps"],
        healthTimezone: "UTC",
        installationId
      })
    });
    const repair = await (
      await api.request(`${HEALTH_API_PREFIX}/healthkit/repairs`, {
        method: "POST",
        headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
        body: JSON.stringify({
          installationId,
          personId: profileId,
          metric: "steps",
          timezoneVersion: 1
        })
      })
    ).json();
    await api.request(`${HEALTH_API_PREFIX}/healthkit/sync`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({
        syncId: "7afbe594-7e1d-4b31-a9a1-420b7fba42e1",
        installationId,
        personId: profileId,
        timezoneVersion: 1,
        repairId: repair.data.repairId,
        chunkIndex: 0,
        operations: [{ kind: "steps_hour_upsert", hourStartUtc: "2026-07-15T08:00:00.000Z", count: 9999 }]
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
    expect(partial.metricSyncStatus).toBe("repairing");
    expect(partial.coverage.complete).toBe(false);
    if (partial.viewType === "daily_series") {
      expect(partial.points).toEqual([]);
    }

    await api.request(`${HEALTH_API_PREFIX}/healthkit/repairs/${repair.data.repairId}/complete`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({ expectedChunkCount: 1 })
    });
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
