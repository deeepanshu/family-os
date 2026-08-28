import {
  HEALTHKIT_METRIC_REGISTRY,
  mcpHealthMetricsForEnabledGroups,
  type McpConnectionGrant,
  type McpGetHealthDataInput,
  type McpGetHealthDataResult,
  type McpHealthMetric,
  type McpListAuthorizedProfilesResult,
  type McpSleepPoint
} from "@family-os/shared";
import { randomUUID } from "node:crypto";
import { HttpError } from "../errors";
import type {
  AuditLogStore,
  FamilyStore,
  HealthKitStore,
  McpConnectionStore,
  ProfileStore,
  RecordAuditInput
} from "../repositories/contracts";
import { coverageComplete } from "../repositories/healthKitDomain";
import { resolveMetricQuery } from "./metricRegistry";
import { McpRateLimiter } from "./rateLimit";
import {
  isDateInInclusiveRange,
  localDateRangeEndingToday,
  localDateString,
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
  mcpConnections: McpConnectionStore;
  auditLogs: AuditLogStore;
  rateLimiter?: McpRateLimiter;
  /**
   * When non-empty, only these OAuth client IDs may use MCP health tools
   * (defense in depth alongside consent-time allowlisting).
   */
  allowedOAuthClientIds?: readonly string[];
  now?: () => Date;
};

export class HealthMcpReadService {
  private readonly rateLimiter: McpRateLimiter;
  private readonly allowedOAuthClientIds: readonly string[];
  private readonly now: () => Date;

  constructor(private readonly deps: HealthMcpReadServiceDeps) {
    this.rateLimiter = deps.rateLimiter ?? new McpRateLimiter(60_000, 60);
    this.allowedOAuthClientIds = deps.allowedOAuthClientIds ?? [];
    this.now = deps.now ?? (() => new Date());
  }

  async listAuthorizedProfiles(caller: McpCallerContext): Promise<McpListAuthorizedProfilesResult> {
    return this.withAudit(caller, "family_os.list_authorized_profiles", undefined, async () => {
      await this.requireActiveConnection(caller);
      const profiles = await this.deps.profiles.listProfiles(caller.userId);
      const listed = await Promise.all(
        profiles.map(async (profile) => ({
          personId: profile.id,
          label: profile.relationshipLabel?.trim() || profile.displayName,
          availableMetrics: await this.availableMetricsForProfile(caller.userId, profile.id)
        }))
      );
      return { profiles: listed };
    });
  }

  async getHealthData(caller: McpCallerContext, input: McpGetHealthDataInput): Promise<McpGetHealthDataResult> {
    return this.withAudit(caller, "family_os.get_health_data", input.personId, async () => {
      await this.requireActiveConnection(caller);
      const query = resolveMetricQuery({
        healthMetric: input.healthMetric,
        rangeDays: input.rangeDays
      });

      let presentationTimezone: string;
      try {
        presentationTimezone = resolveTimezone(input.timezone);
      } catch {
        throw new HttpError(400, "invalid_timezone", "timezone must be a valid IANA time zone.");
      }

      await this.deps.profiles.getProfile(caller.userId, input.personId);
      // Runtime filter: the metric's app toggle must be enabled (plan §8.2).
      await this.assertMetricConsented(caller.userId, input.personId, query.metric);
      const freshness = await this.deps.healthKit.getHealthMetricFreshness(
        caller.userId,
        input.personId,
        query.metric
      );
      if (query.metric === "steps" && freshness.status !== "ready") {
        throw new HttpError(
          409,
          "healthkit_sync_incomplete",
          "Steps are still importing. Complete Activity Import history in Family OS before querying Steps."
        );
      }
      const healthTimezone = freshness.healthTimezone || "UTC";
      // Sleep-day and coverage windows use the profile health timezone; request timezone is presentation-only.
      const rangeTimezone = query.metric === "sleep" ? healthTimezone : presentationTimezone;
      const { rangeStart, rangeEnd } = localDateRangeEndingToday(query.rangeDays, rangeTimezone, this.now());
      // Completed coverage only; an in-progress or interrupted attempt never
      // clears completeness (plan §8.5).
      const complete = coverageComplete({
        coverageStartAt: freshness.coverageStartAt,
        coverageEndAt: freshness.coverageEndAt,
        rangeStart: `${rangeStart}T00:00:00.000Z`,
        rangeEnd: `${rangeEnd}T23:59:59.999Z`
      });
      // Data-first: return whatever rows exist in storage. Import lifecycle is
      // never a reason to withhold stored rows (plan §8.3); consent group must
      // still be enabled (assertMetricConsented above).

      const coverage = {
        requestedRangeDays: query.rangeDays,
        rangeStart,
        rangeEnd,
        complete,
        availableStart: freshness.coverageStartAt,
        availableEnd: freshness.coverageEndAt
      };
      const base = {
        personId: input.personId,
        unit: query.unit,
        healthTimezone,
        timezone: presentationTimezone,
        lastSyncedAt: freshness.lastSuccessfulAt
      };

      if (query.metric === "steps") {
        const { points, daysWithData } = await this.loadStepHourSeries(
          caller.userId,
          input.personId,
          rangeStart,
          rangeEnd,
          presentationTimezone
        );
        return {
          ...base,
          healthMetric: "steps",
          viewType: "hourly_count_series",
          coverage: { ...coverage, daysWithData },
          points
        };
      }

      if (query.metric === "sleep") {
        const points = await this.loadDailySleepHours(caller.userId, input.personId, rangeStart, rangeEnd);
        return {
          ...base,
          healthMetric: "sleep",
          viewType: "daily_duration_series",
          coverage: { ...coverage, daysWithData: points.length },
          points
        };
      }

      const maxReadings = query.maxReadings ?? 200;
      if (query.metric === "workout") {
        const { workouts, truncated } = await this.loadWorkoutTable(
          caller.userId,
          input.personId,
          rangeStart,
          rangeEnd,
          presentationTimezone,
          maxReadings
        );
        return {
          ...base,
          healthMetric: "workout",
          viewType: "workout_table",
          coverage: { ...coverage, daysWithData: countDistinctDaysFromBuckets(workouts.map((workout) => workout.localDate)) },
          workouts,
          truncated
        };
      }
      if (query.metric === "blood_pressure") {
        const { readings, truncated } = await this.loadBloodPressureTable(
          caller.userId,
          input.personId,
          rangeStart,
          rangeEnd,
          presentationTimezone,
          maxReadings
        );
        return {
          ...base,
          healthMetric: "blood_pressure",
          viewType: "daily_reading_table",
          coverage: { ...coverage, daysWithData: countDistinctDaysFromBuckets(readings.map((r) => r.localDate)) },
          readings,
          truncated
        };
      }

      if (query.metric === "blood_glucose") {
        const { readings, truncated } = await this.loadBloodGlucoseTable(
          caller.userId,
          input.personId,
          rangeStart,
          rangeEnd,
          presentationTimezone,
          maxReadings
        );
        return {
          ...base,
          healthMetric: "blood_glucose",
          viewType: "daily_reading_table",
          coverage: { ...coverage, daysWithData: countDistinctDaysFromBuckets(readings.map((r) => r.localDate)) },
          readings,
          truncated
        };
      }

      // Never fall through to an unrelated table shape.
      throw new HttpError(
        400,
        "unsupported_metric",
        `healthMetric ${query.metric} is not supported by Family OS MCP.`
      );
    });
  }

  /**
   * The explicit app-toggle → MCP metric mapping (plan §8.2): Vitals exposes
   * `blood_pressure` and `blood_glucose`, Sleep exposes `sleep`, Workouts
   * exposes `workout`. Settings are readable for any household member. Only
   * expected access/settings failures collapse to []; unexpected errors rethrow.
   */
  private async availableMetricsForProfile(userId: string, personId: string): Promise<McpHealthMetric[]> {
    try {
      const settings = await this.deps.healthKit.getHealthKitSettings(userId, personId);
      const enabled = mcpHealthMetricsForEnabledGroups(settings.enabledGroups);
      const readiness = await Promise.all(
        enabled.map(async (metric) => {
          if (metric !== "steps") return metric;
          const freshness = await this.deps.healthKit.getHealthMetricFreshness(userId, personId, metric);
          return freshness.status === "ready" ? metric : null;
        })
      );
      return readiness.filter((metric): metric is McpHealthMetric => metric !== null);
    } catch (error) {
      if (error instanceof HttpError) {
        // Self-only settings, missing profile, or no HealthKit config → advertise nothing.
        if (
          error.code === "profile_forbidden" ||
          error.code === "profile_not_found" ||
          error.code === "healthkit_self_profile_required" ||
          error.code === "healthkit_self_only" ||
          error.status === 403 ||
          error.status === 404 ||
          error.status === 409
        ) {
          return [];
        }
      }
      throw error;
    }
  }

  /** Fail closed when the metric's app toggle is not enabled for this Self profile. */
  private async assertMetricConsented(
    userId: string,
    personId: string,
    metric: McpHealthMetric
  ): Promise<void> {
    const group = HEALTHKIT_METRIC_REGISTRY[metric].group;
    try {
      const settings = await this.deps.healthKit.getHealthKitSettings(userId, personId);
      if (!mcpHealthMetricsForEnabledGroups(settings.enabledGroups).includes(metric)) {
        throw new HttpError(
          403,
          "group_disabled",
          `HealthKit group "${group}" is not enabled for this profile. Re-enable it in Family OS before querying ${metric}.`
        );
      }
    } catch (error) {
      if (error instanceof HttpError && error.code === "group_disabled") {
        throw error;
      }
      if (
        error instanceof HttpError &&
        (error.status === 403 || error.status === 404 || error.status === 409)
      ) {
        // No Self settings / wrong person: treat as unavailable for MCP reads.
        throw new HttpError(
          403,
          "group_disabled",
          `HealthKit group "${group}" is not available for this profile.`
        );
      }
      throw error;
    }
  }

  private async loadDailySleepHours(
    userId: string,
    personId: string,
    rangeStart: string,
    rangeEnd: string
  ): Promise<McpSleepPoint[]> {
    const days = await this.deps.healthKit.listSleepDays(userId, personId, rangeStart, rangeEnd);
    return days
      .filter((day) => isDateInInclusiveRange(day.sleepDay, rangeStart, rangeEnd))
      .map((day) => ({
        bucket: day.sleepDay,
        value: Number((day.totalMinutes / 60).toFixed(4)),
        totalHours: Number((day.totalMinutes / 60).toFixed(4)),
        coreHours: Number((day.coreMinutes / 60).toFixed(4)),
        deepHours: Number((day.deepMinutes / 60).toFixed(4)),
        remHours: Number((day.remMinutes / 60).toFixed(4)),
        unspecifiedAsleepHours: Number((day.unspecifiedAsleepMinutes / 60).toFixed(4)),
        awakeHours: Number((day.awakeMinutes / 60).toFixed(4)),
        inBedHours: Number((day.inBedMinutes / 60).toFixed(4)),
        wristTemperatureCelsius: day.wristTemperatureCelsius,
        breathingDisturbanceCount: day.breathingDisturbanceCount
      }));
  }

  private async loadBloodPressureTable(
    userId: string,
    personId: string,
    rangeStart: string,
    rangeEnd: string,
    timezone: string,
    maxReadings: number
  ) {
    const start = new Date(`${rangeStart}T00:00:00.000Z`);
    start.setUTCDate(start.getUTCDate() - 1);
    const end = new Date(`${rangeEnd}T23:59:59.999Z`);
    end.setUTCDate(end.getUTCDate() + 1);
    const rows = await this.deps.healthKit.listHealthKitBloodPressure(
      userId,
      personId,
      start.toISOString(),
      end.toISOString(),
      maxReadings + 50
    );
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

  private async loadBloodGlucoseTable(
    userId: string,
    personId: string,
    rangeStart: string,
    rangeEnd: string,
    timezone: string,
    maxReadings: number
  ) {
    const start = new Date(`${rangeStart}T00:00:00.000Z`);
    start.setUTCDate(start.getUTCDate() - 1);
    const end = new Date(`${rangeEnd}T23:59:59.999Z`);
    end.setUTCDate(end.getUTCDate() + 1);
    const rows = await this.deps.healthKit.listHealthKitBloodGlucose(
      userId,
      personId,
      start.toISOString(),
      end.toISOString(),
      maxReadings + 50
    );
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
          value: reading.value,
          mealTime: reading.mealTime
        };
      })
    };
  }

  private async loadStepHourSeries(
    userId: string,
    personId: string,
    rangeStart: string,
    rangeEnd: string,
    timezone: string
  ) {
    const { start, end } = expandedInstantRange(rangeStart, rangeEnd);
    const rows = await this.deps.healthKit.listStepHours(userId, personId, start, end);
    const points = rows
      .filter((row) => isDateInInclusiveRange(localDateString(new Date(row.hourStartUtc), timezone), rangeStart, rangeEnd))
      .map((row) => ({ hourStartUtc: row.hourStartUtc, count: row.count }));
    return {
      points,
      daysWithData: countDistinctDaysFromBuckets(
        points.map((point) => localDateString(new Date(point.hourStartUtc), timezone))
      )
    };
  }

  private async loadWorkoutTable(
    userId: string,
    personId: string,
    rangeStart: string,
    rangeEnd: string,
    timezone: string,
    maxReadings: number
  ) {
    const { start, end } = expandedInstantRange(rangeStart, rangeEnd);
    const rows = await this.deps.healthKit.listHealthKitWorkouts(userId, personId, start, end, maxReadings + 50);
    const inRange = rows
      .filter((workout) => isDateInInclusiveRange(localDateString(new Date(workout.startedAtUtc), timezone), rangeStart, rangeEnd))
      .sort((a, b) => Date.parse(a.startedAtUtc) - Date.parse(b.startedAtUtc));
    const truncated = inRange.length > maxReadings;
    return {
      truncated,
      workouts: (truncated ? inRange.slice(-maxReadings) : inRange).map((workout) => {
        const instant = new Date(workout.startedAtUtc);
        return {
          localDate: localDateString(instant, timezone),
          localTime: localTimeOfDay(instant, timezone),
          workoutType: workout.workoutType,
          durationMinutes: Number((workout.durationSeconds / 60).toFixed(2)),
          activeEnergyKcal: workout.activeEnergyKcal,
          distanceMeters: workout.distanceMeters,
          averageHeartRateBpm: workout.averageHeartRateBpm,
          maximumHeartRateBpm: workout.maximumHeartRateBpm,
          minimumHeartRateBpm: workout.minimumHeartRateBpm,
          sourceName: workout.sourceName,
          isIndoor: workout.isIndoor,
          elevationAscendedMeters: workout.elevationAscendedMeters,
          averageMETs: workout.averageMETs,
          swimmingStrokeCount: workout.swimmingStrokeCount,
          totalFlightsClimbed: workout.totalFlightsClimbed,
          eventCount: workout.events?.length,
          activitySegmentCount: workout.activities?.length,
          exercises: workout.exercises
        };
      })
    };
  }

  private async requireActiveConnection(caller: McpCallerContext): Promise<McpConnectionGrant> {
    this.rateLimiter.check(caller.userId, caller.oauthClientId);
    if (
      this.allowedOAuthClientIds.length > 0 &&
      !this.allowedOAuthClientIds.includes(caller.oauthClientId)
    ) {
      throw new HttpError(
        403,
        "oauth_client_not_allowed",
        "This OAuth client is not allowlisted for Family OS MCP health access."
      );
    }
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
    // Solo-first: an active MCP grant is enough. Profile access is enforced per personId.
    return connection;
  }

  private async withAudit<T>(
    caller: McpCallerContext,
    toolName: string,
    profileId: string | undefined,
    work: () => Promise<T>
  ): Promise<T> {
    const correlationId = caller.correlationId ?? randomUUID();
    let familyId: string | null = null;
    try {
      const current = await this.deps.families.getCurrentFamily(caller.userId);
      familyId = current?.family.id ?? null;
      const result = await work();
      await this.recordToolAudit({
        familyId,
        actorUserId: caller.userId,
        toolName,
        profileId,
        oauthClientId: caller.oauthClientId,
        correlationId,
        outcome: "allowed"
      });
      return result;
    } catch (error) {
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
      throw error;
    }
  }

  private async recordToolAudit(input: {
    familyId: string | null;
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
      resourceId: input.profileId ?? input.familyId ?? input.actorUserId,
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

function countDistinctDaysFromBuckets(days: string[]): number {
  return new Set(days).size;
}

function expandedInstantRange(rangeStart: string, rangeEnd: string) {
  const start = new Date(`${rangeStart}T00:00:00.000Z`);
  start.setUTCDate(start.getUTCDate() - 1);
  const end = new Date(`${rangeEnd}T23:59:59.999Z`);
  end.setUTCDate(end.getUTCDate() + 1);
  return { start: start.toISOString(), end: end.toISOString() };
}
