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

  await api.request(`${HEALTH_API_PREFIX}/healthkit/link-profile`, {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify({ personId: profileId })
  });
  await api.request(`${HEALTH_API_PREFIX}/healthkit/sync/settings`, {
    method: "PATCH",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify({ enabledMetrics: ["steps", "sleep", "blood_pressure"] })
  });
  await api.request(`${HEALTH_API_PREFIX}/healthkit/samples/batch`, {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify({
      samples: [
        {
          metricType: "steps",
          sourceSampleKey: "steps-day-1",
          startDate: "2026-07-15T08:00:00.000Z",
          endDate: "2026-07-15T09:00:00.000Z",
          value: 1200,
          unit: "count"
        },
        {
          metricType: "steps",
          sourceSampleKey: "steps-day-1b",
          startDate: "2026-07-15T14:00:00.000Z",
          endDate: "2026-07-15T15:00:00.000Z",
          value: 800,
          unit: "count"
        },
        {
          metricType: "steps",
          sourceSampleKey: "steps-day-2",
          startDate: "2026-07-16T10:00:00.000Z",
          endDate: "2026-07-16T11:00:00.000Z",
          value: 5000,
          unit: "count"
        },
        {
          metricType: "sleep",
          sourceSampleKey: "sleep-1",
          startDate: "2026-07-15T23:00:00.000Z",
          endDate: "2026-07-16T07:00:00.000Z",
          value: 480,
          unit: "min"
        },
        {
          metricType: "blood_pressure",
          sourceSampleKey: "bp-1",
          startDate: "2026-07-16T09:30:00.000Z",
          systolic: 120,
          diastolic: 80,
          pulse: 70
        }
      ]
    })
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

  it("returns sleep as daily duration hours and blood pressure as a reading table", async () => {
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
      expect(sleep.points.some((p) => p.value === 8)).toBe(true);
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

  it("aggregates hourly steps within a 7-day window", async () => {
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
    }
  });
});
