import {
  MCP_HEALTH_DISCLAIMER,
  MCP_RELEASE1_METRICS,
  type McpConnectionGrant,
  type McpGetHealthDataInput,
  type McpGetHealthDataResult,
  type McpListAuthorizedProfilesResult,
  type McpSeriesPoint
} from "@family-os/shared";
import { randomUUID } from "node:crypto";
import { HttpError } from "../errors";
import type {
  AuditLogStore,
  FamilyStore,
  HealthKitStore,
  McpConnectionStore,
  ProfileStore,
  ReadingStore
} from "../repositories/contracts";
import type { RecordAuditInput } from "../repositories/contracts";
import { resolveMetricQuery } from "./metricRegistry";
import { McpRateLimiter } from "./rateLimit";
import {
  isDateInInclusiveRange,
  localDateRangeEndingToday,
  localDateString,
  localHourBucket,
  localTimeOfDay,
  resolveTimezone
} from "./timezone";

export type McpCallerContext = {
  userId: string;
  oauthClientId: string;
  correlationId?: string;
};

export type HealthMcpReadServiceDeps = {
  families: FamilyStore;
  profiles: ProfileStore;
  healthKit: HealthKitStore;
  readings: ReadingStore;
  mcpConnections: McpConnectionStore;
  auditLogs: AuditLogStore;
  rateLimiter?: McpRateLimiter;
  now?: () => Date;
};

export class HealthMcpReadService {
  private readonly rateLimiter: McpRateLimiter;
  private readonly now: () => Date;

  constructor(private readonly deps: HealthMcpReadServiceDeps) {
    this.rateLimiter = deps.rateLimiter ?? new McpRateLimiter(60_000, 60);
    this.now = deps.now ?? (() => new Date());
  }

  async listAuthorizedProfiles(caller: McpCallerContext): Promise<McpListAuthorizedProfilesResult> {
    return this.withAudit(caller, "family_os.list_authorized_profiles", undefined, async () => {
      await this.requireActiveConnection(caller);
      const profiles = await this.deps.profiles.listProfiles(caller.userId);
      return {
        profiles: profiles.map((profile) => ({
          personId: profile.id,
          label: profile.relationshipLabel?.trim() || profile.displayName,
          availableMetrics: [...MCP_RELEASE1_METRICS]
        })),
        disclaimer: MCP_HEALTH_DISCLAIMER
      };
    });
  }

  async getHealthData(caller: McpCallerContext, input: McpGetHealthDataInput): Promise<McpGetHealthDataResult> {
    return this.withAudit(caller, "family_os.get_health_data", input.personId, async () => {
      await this.requireActiveConnection(caller);
      const query = resolveMetricQuery({
        healthMetric: input.healthMetric,
        rangeDays: input.rangeDays,
        granularity: input.granularity
      });

      let timezone: string;
      try {
        timezone = resolveTimezone(input.timezone);
      } catch {
        throw new HttpError(400, "invalid_timezone", "timezone must be a valid IANA time zone.");
      }

      await this.deps.profiles.getProfile(caller.userId, input.personId);

      const { rangeStart, rangeEnd } = localDateRangeEndingToday(query.rangeDays, timezone, this.now());
      const lastSyncedAt = await this.resolveLastSyncedAt(caller.userId, input.personId);

      if (query.metric === "steps" && query.granularity === "hourly") {
        const points = await this.loadHourlySteps(caller.userId, input.personId, rangeStart, rangeEnd, timezone);
        return {
          personId: input.personId,
          healthMetric: "steps",
          viewType: "hourly_series",
          unit: query.unit,
          timezone,
          coverage: {
            requestedRangeDays: query.rangeDays,
            rangeStart,
            rangeEnd,
            daysWithData: countDistinctDaysFromBuckets(points.map((p) => p.bucket.slice(0, 10)))
          },
          lastSyncedAt,
          disclaimer: MCP_HEALTH_DISCLAIMER,
          points
        };
      }

      if (query.metric === "steps") {
        const points = await this.loadDailySteps(caller.userId, input.personId, rangeStart, rangeEnd);
        return {
          personId: input.personId,
          healthMetric: "steps",
          viewType: "daily_series",
          unit: query.unit,
          timezone,
          coverage: {
            requestedRangeDays: query.rangeDays,
            rangeStart,
            rangeEnd,
            daysWithData: points.length
          },
          lastSyncedAt,
          disclaimer: MCP_HEALTH_DISCLAIMER,
          points
        };
      }

      if (query.metric === "sleep") {
        const points = await this.loadDailySleepHours(caller.userId, input.personId, rangeStart, rangeEnd);
        return {
          personId: input.personId,
          healthMetric: "sleep",
          viewType: "daily_duration_series",
          unit: query.unit,
          timezone,
          coverage: {
            requestedRangeDays: query.rangeDays,
            rangeStart,
            rangeEnd,
            daysWithData: points.length
          },
          lastSyncedAt,
          disclaimer: MCP_HEALTH_DISCLAIMER,
          points
        };
      }

      const maxReadings = query.maxReadings ?? 200;
      const { readings, truncated } = await this.loadBloodPressureTable(
        caller.userId,
        input.personId,
        rangeStart,
        rangeEnd,
        timezone,
        maxReadings
      );
      return {
        personId: input.personId,
        healthMetric: "blood_pressure",
        viewType: "daily_reading_table",
        unit: query.unit,
        timezone,
        coverage: {
          requestedRangeDays: query.rangeDays,
          rangeStart,
          rangeEnd,
          daysWithData: countDistinctDaysFromBuckets(readings.map((r) => r.localDate))
        },
        lastSyncedAt,
        disclaimer: MCP_HEALTH_DISCLAIMER,
        readings,
        truncated
      };
    });
  }

  private async loadDailySteps(
    userId: string,
    personId: string,
    rangeStart: string,
    rangeEnd: string
  ): Promise<McpSeriesPoint[]> {
    const summaries = await this.deps.healthKit.listHealthMetricDailySummaries(userId, personId, "steps", 365);
    return summaries
      .filter((row) => isDateInInclusiveRange(row.date, rangeStart, rangeEnd))
      .sort((a, b) => a.date.localeCompare(b.date))
      .map((row) => ({ bucket: row.date, value: row.value }));
  }

  private async loadDailySleepHours(
    userId: string,
    personId: string,
    rangeStart: string,
    rangeEnd: string
  ): Promise<McpSeriesPoint[]> {
    const summaries = await this.deps.healthKit.listHealthMetricDailySummaries(userId, personId, "sleep", 365);
    return summaries
      .filter((row) => isDateInInclusiveRange(row.date, rangeStart, rangeEnd))
      .sort((a, b) => a.date.localeCompare(b.date))
      .map((row) => ({
        bucket: row.date,
        value: roundTo(row.value / 60, 2)
      }));
  }

  private async loadHourlySteps(
    userId: string,
    personId: string,
    rangeStart: string,
    rangeEnd: string,
    timezone: string
  ): Promise<McpSeriesPoint[]> {
    const samples = await this.deps.healthKit.listHealthKitSamplesForMetric(
      userId,
      personId,
      "steps",
      rangeStart,
      rangeEnd
    );
    const totals = new Map<string, number>();
    for (const sample of samples) {
      const instant = new Date(sample.startDate);
      const localDate = localDateString(instant, timezone);
      if (!isDateInInclusiveRange(localDate, rangeStart, rangeEnd)) {
        continue;
      }
      const bucket = localHourBucket(instant, timezone);
      totals.set(bucket, (totals.get(bucket) ?? 0) + (sample.value ?? 0));
    }
    return [...totals.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([bucket, value]) => ({ bucket, value }));
  }

  private async loadBloodPressureTable(
    userId: string,
    personId: string,
    rangeStart: string,
    rangeEnd: string,
    timezone: string,
    maxReadings: number
  ) {
    const rows = await this.deps.readings.listBloodPressure(userId, personId, maxReadings + 1);
    const inRange = rows
      .filter((reading) => {
        const localDate = localDateString(new Date(reading.measuredAt), timezone);
        return isDateInInclusiveRange(localDate, rangeStart, rangeEnd);
      })
      .sort((a, b) => Date.parse(a.measuredAt) - Date.parse(b.measuredAt));

    const truncated = inRange.length > maxReadings;
    const limited = truncated ? inRange.slice(-maxReadings) : inRange;
    return {
      truncated,
      readings: limited.map((reading) => {
        const instant = new Date(reading.measuredAt);
        return {
          localDate: localDateString(instant, timezone),
          localTime: localTimeOfDay(instant, timezone),
          systolic: reading.systolic,
          diastolic: reading.diastolic,
          pulse: reading.pulse
        };
      })
    };
  }

  private async resolveLastSyncedAt(userId: string, personId: string): Promise<string | undefined> {
    const status = await this.deps.healthKit.getHealthKitSyncStatus(userId);
    if (status.linkedProfileId === personId && status.lastSync?.finishedAt) {
      return status.lastSync.finishedAt;
    }
    return undefined;
  }

  private async requireActiveConnection(caller: McpCallerContext): Promise<McpConnectionGrant> {
    this.rateLimiter.check(caller.userId, caller.oauthClientId);
    const connection = await this.deps.mcpConnections.getActiveConnection(caller.userId, caller.oauthClientId);
    if (!connection) {
      throw new HttpError(
        403,
        "mcp_connection_required",
        "An active Family OS MCP connection grant is required for this client."
      );
    }
    if (!connection.capabilities.includes("health_read")) {
      throw new HttpError(403, "mcp_capability_denied", "This connection is not permitted to read health data.");
    }
    const current = await this.deps.families.getCurrentFamily(caller.userId);
    if (!current) {
      throw new HttpError(403, "active_member_required", "Active family membership is required.");
    }
    return connection;
  }

  private async withAudit<T>(
    caller: McpCallerContext,
    toolName: string,
    profileId: string | undefined,
    work: () => Promise<T>
  ): Promise<T> {
    const correlationId = caller.correlationId ?? randomUUID();
    let familyId: string | undefined;
    try {
      const current = await this.deps.families.getCurrentFamily(caller.userId);
      familyId = current?.family.id;
      const result = await work();
      if (familyId) {
        await this.recordToolAudit({
          familyId,
          actorUserId: caller.userId,
          toolName,
          profileId,
          oauthClientId: caller.oauthClientId,
          correlationId,
          outcome: "allowed"
        });
      }
      return result;
    } catch (error) {
      if (familyId) {
        await this.recordToolAudit({
          familyId,
          actorUserId: caller.userId,
          toolName,
          profileId,
          oauthClientId: caller.oauthClientId,
          correlationId,
          outcome: error instanceof HttpError && (error.status === 403 || error.status === 404) ? "denied" : "failed",
          errorCode: error instanceof HttpError ? error.code : "internal_error"
        });
      }
      throw error;
    }
  }

  private async recordToolAudit(input: {
    familyId: string;
    actorUserId: string;
    toolName: string;
    profileId?: string;
    oauthClientId: string;
    correlationId: string;
    outcome: "allowed" | "denied" | "failed";
    errorCode?: string;
  }) {
    const audit: RecordAuditInput = {
      familyId: input.familyId,
      actorUserId: input.actorUserId,
      action: "mcp.tool_called",
      resourceType: "mcp_tool",
      resourceId: input.profileId ?? input.familyId,
      metadata: {
        tool_name: input.toolName,
        oauth_client_id: input.oauthClientId,
        outcome: input.outcome,
        correlation_id: input.correlationId,
        ...(input.errorCode ? { error_code: input.errorCode } : {}),
        ...(input.profileId ? { has_profile_id: true } : {})
      }
    };
    await this.deps.auditLogs.recordAudit(audit);
  }
}

function roundTo(value: number, digits: number): number {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

function countDistinctDaysFromBuckets(days: string[]): number {
  return new Set(days).size;
}
