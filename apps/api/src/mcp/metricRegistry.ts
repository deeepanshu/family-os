import type { McpHealthMetric, McpHealthViewType, McpStepsGranularity } from "@family-os/shared";
import { HttpError } from "../errors";

export type MetricRegistryEntry = {
  metric: McpHealthMetric;
  unit: string;
  maxRangeDays: number;
  maxReadings?: number;
  defaultViewType: McpHealthViewType;
  allowedGranularities?: readonly McpStepsGranularity[];
  maxRangeDaysByGranularity?: Partial<Record<McpStepsGranularity, number>>;
};

const STEPS_HOURLY_MAX_DAYS = 7;
const STEPS_DAILY_MAX_DAYS = 90;
const SLEEP_MAX_DAYS = 90;
const BLOOD_PRESSURE_MAX_DAYS = 90;
const BLOOD_PRESSURE_MAX_READINGS = 200;

export const MCP_METRIC_REGISTRY: Record<McpHealthMetric, MetricRegistryEntry> = {
  steps: {
    metric: "steps",
    unit: "count",
    maxRangeDays: STEPS_DAILY_MAX_DAYS,
    defaultViewType: "daily_series",
    allowedGranularities: ["hourly", "daily"],
    maxRangeDaysByGranularity: {
      hourly: STEPS_HOURLY_MAX_DAYS,
      daily: STEPS_DAILY_MAX_DAYS
    }
  },
  sleep: {
    metric: "sleep",
    unit: "hours",
    maxRangeDays: SLEEP_MAX_DAYS,
    defaultViewType: "daily_duration_series"
  },
  blood_pressure: {
    metric: "blood_pressure",
    unit: "mmHg",
    maxRangeDays: BLOOD_PRESSURE_MAX_DAYS,
    maxReadings: BLOOD_PRESSURE_MAX_READINGS,
    defaultViewType: "daily_reading_table"
  }
};

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
      throw new HttpError(
        400,
        "range_days_exceeded",
        `steps ${granularity} data supports at most ${maxDays} days.`
      );
    }
    return {
      metric: "steps",
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
    throw new HttpError(
      400,
      "range_days_exceeded",
      `${input.healthMetric} supports at most ${entry.maxRangeDays} days.`
    );
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
  if (value === undefined || value === "daily") {
    return "daily";
  }
  if (value === "hourly") {
    return "hourly";
  }
  throw new HttpError(400, "invalid_granularity", "steps granularity must be hourly or daily.");
}

export function isMcpHealthMetric(value: string): value is McpHealthMetric {
  return value === "steps" || value === "sleep" || value === "blood_pressure";
}
