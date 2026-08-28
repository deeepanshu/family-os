import {
  HEALTHKIT_METRIC_REGISTRY,
  MCP_HEALTH_METRICS,
  isMcpHealthMetric,
  type McpHealthMetric,
  type McpHealthViewType
} from "@family-os/shared";
import { HttpError } from "../errors";

const DEFAULT_MAX_DAYS = 90;
const TABLE_MAX_READINGS = 200;

export type MetricRegistryEntry = {
  metric: McpHealthMetric;
  unit: string;
  maxRangeDays: number;
  maxReadings?: number;
  defaultViewType: McpHealthViewType;
};

function entryFor(metric: McpHealthMetric): MetricRegistryEntry {
  const definition = HEALTHKIT_METRIC_REGISTRY[metric];
  // Sleep is the per-night summary; wrist temp / breathing are fields on it.
  if (metric === "sleep") {
    return { metric, unit: "hours", maxRangeDays: DEFAULT_MAX_DAYS, defaultViewType: "daily_duration_series" };
  }
  if (metric === "steps") {
    return { metric, unit: definition.unit, maxRangeDays: DEFAULT_MAX_DAYS, defaultViewType: "hourly_count_series" };
  }
  if (definition.storage === "blood_pressure" || definition.storage === "blood_glucose") {
    return {
      metric,
      unit: definition.unit,
      maxRangeDays: DEFAULT_MAX_DAYS,
      maxReadings: TABLE_MAX_READINGS,
      defaultViewType: "daily_reading_table"
    };
  }
  return {
    metric,
    unit: definition.unit,
    maxRangeDays: DEFAULT_MAX_DAYS,
    maxReadings: TABLE_MAX_READINGS,
    defaultViewType: "workout_table"
  };
}

/**
 * Built from the fixed product allowlist (blood_pressure, blood_glucose, sleep, workout) —
 * never from the broad HealthKit registry (plan §8.2).
 */
export const MCP_METRIC_REGISTRY: Record<McpHealthMetric, MetricRegistryEntry> = Object.fromEntries(
  MCP_HEALTH_METRICS.map((metric) => [metric, entryFor(metric)])
) as Record<McpHealthMetric, MetricRegistryEntry>;

export type ResolvedMetricQuery = {
  metric: McpHealthMetric;
  unit: string;
  rangeDays: number;
  viewType: McpHealthViewType;
  maxReadings?: number;
};

export function resolveMetricQuery(input: {
  healthMetric: string;
  rangeDays: number;
}): ResolvedMetricQuery {
  if (!isMcpHealthMetric(input.healthMetric)) {
    if (
      input.healthMetric === "sleeping_wrist_temperature" ||
      input.healthMetric === "sleep_breathing_disturbance_events"
    ) {
      throw new HttpError(
        400,
        "unsupported_metric",
        "Wrist temperature and breathing disturbances are included in the sleep metric. Query healthMetric=sleep."
      );
    }
    throw new HttpError(400, "unsupported_metric", "healthMetric is not an allowed Family OS MCP metric.");
  }
  if (!Number.isInteger(input.rangeDays) || input.rangeDays < 1) {
    throw new HttpError(400, "invalid_range_days", "rangeDays must be a positive integer.");
  }
  const entry = MCP_METRIC_REGISTRY[input.healthMetric];
  if (input.rangeDays > entry.maxRangeDays) {
    throw new HttpError(400, "range_days_exceeded", `${input.healthMetric} supports at most ${entry.maxRangeDays} days.`);
  }
  return {
    metric: input.healthMetric,
    unit: entry.unit,
    rangeDays: input.rangeDays,
    viewType: entry.defaultViewType,
    maxReadings: entry.maxReadings
  };
}

export { isMcpHealthMetric };
