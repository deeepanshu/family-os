import {
  HEALTHKIT_METRIC_REGISTRY,
  isMcpHealthMetric,
  type McpHealthMetric,
  type McpHealthViewType,
  type McpStepsGranularity
} from "@family-os/shared";
import { HttpError } from "../errors";

const HOURLY_MAX_DAYS = 7;
const DEFAULT_MAX_DAYS = 90;
const TABLE_MAX_READINGS = 200;

export type MetricRegistryEntry = {
  metric: McpHealthMetric;
  unit: string;
  maxRangeDays: number;
  maxReadings?: number;
  defaultViewType: McpHealthViewType;
  allowedGranularities?: readonly McpStepsGranularity[];
  maxRangeDaysByGranularity?: Partial<Record<McpStepsGranularity, number>>;
};

function entryFor(metric: McpHealthMetric): MetricRegistryEntry {
  const definition = HEALTHKIT_METRIC_REGISTRY[metric];
  if (metric === "steps") {
    return {
      metric,
      unit: definition.unit,
      maxRangeDays: DEFAULT_MAX_DAYS,
      defaultViewType: "daily_series",
      allowedGranularities: ["hourly", "daily"],
      maxRangeDaysByGranularity: { hourly: HOURLY_MAX_DAYS, daily: DEFAULT_MAX_DAYS }
    };
  }
  // Only the primary sleep metric is queryable; wrist temp / breathing are fields on sleep.
  if (metric === "sleep") {
    return { metric, unit: "hours", maxRangeDays: DEFAULT_MAX_DAYS, defaultViewType: "daily_duration_series" };
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
  if (definition.storage === "workout") {
    return {
      metric,
      unit: definition.unit,
      maxRangeDays: DEFAULT_MAX_DAYS,
      maxReadings: TABLE_MAX_READINGS,
      defaultViewType: "workout_table"
    };
  }
  return { metric, unit: definition.unit, maxRangeDays: DEFAULT_MAX_DAYS, defaultViewType: "daily_series" };
}

export const MCP_METRIC_REGISTRY: Record<McpHealthMetric, MetricRegistryEntry> = Object.fromEntries(
  // Build from the MCP allowlist so sleep-attribute keys never appear.
  (Object.keys(HEALTHKIT_METRIC_REGISTRY) as string[])
    .filter(isMcpHealthMetric)
    .map((metric) => [metric, entryFor(metric)])
) as Record<McpHealthMetric, MetricRegistryEntry>;

export type ResolvedMetricQuery = {
  metric: McpHealthMetric;
  unit: string;
  rangeDays: number;
  viewType: McpHealthViewType;
  granularity?: McpStepsGranularity;
  maxReadings?: number;
};

export function resolveMetricQuery(input: {
  healthMetric: string;
  rangeDays: number;
  granularity?: string;
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
  if (input.healthMetric === "steps") {
    const granularity = resolveStepsGranularity(input.granularity);
    const maxDays = entry.maxRangeDaysByGranularity![granularity]!;
    if (input.rangeDays > maxDays) {
      throw new HttpError(400, "range_days_exceeded", `steps ${granularity} data supports at most ${maxDays} days.`);
    }
    return {
      metric: input.healthMetric,
      unit: entry.unit,
      rangeDays: input.rangeDays,
      viewType: granularity === "hourly" ? "hourly_series" : "daily_series",
      granularity
    };
  }
  if (input.granularity !== undefined) {
    throw new HttpError(400, "granularity_not_supported", `${input.healthMetric} does not accept granularity.`);
  }
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

function resolveStepsGranularity(value: string | undefined): McpStepsGranularity {
  if (value === undefined || value === "daily") return "daily";
  if (value === "hourly") return "hourly";
  throw new HttpError(400, "invalid_granularity", "steps granularity must be hourly or daily.");
}

export { isMcpHealthMetric };
