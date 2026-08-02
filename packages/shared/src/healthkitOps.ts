/**
 * Correctness-first HealthKit ops protocol.
 * Source: docs/HEALTHKIT_CORRECTNESS_FIRST_SYNC_PLAN.md
 *
 * Natural-key upsert/delete + short-TTL op_id receipts.
 * No entity versions, fingerprints, or session manifests.
 */
import {
  HEALTHKIT_METRIC_REGISTRY,
  healthKitMetricsForGroup,
  isHealthKitMetricKey,
  type HealthKitConsentGroup,
  type HealthKitMetricKey
} from "./healthkitRegistry";

export type HealthKitOpKind = "upsert" | "delete";

/** Per-op apply outcomes from POST /ops:batch. */
export type HealthKitOpApplyCode = "applied" | "duplicate" | "rejected";

export type HealthKitStepsHourPayload = {
  kind: "steps_hour";
  hourStartUtc: string;
  count: number;
};

export type HealthKitSleepDayPayload = {
  kind: "sleep_day";
  sleepDay: string;
  totalMinutes: number;
  coreMinutes: number;
  deepMinutes: number;
  remMinutes: number;
  unspecifiedAsleepMinutes: number;
  awakeMinutes: number;
  inBedMinutes: number;
  wristTemperatureCelsius?: number;
  breathingDisturbanceCount?: number;
};

export type HealthKitDailyMetricPayload = {
  kind: "daily_metric";
  healthMetric: HealthKitMetricKey;
  localDay: string;
  sumValue?: number;
  averageValue?: number;
  minimumValue?: number;
  maximumValue?: number;
  latestValue?: number;
  sampleCount: number;
};

export type HealthKitBloodPressurePayload = {
  kind: "blood_pressure";
  /** HealthKit correlation UUID for BP. */
  sourceObjectKey: string;
  measuredAtUtc: string;
  systolic: number;
  diastolic: number;
  pulse?: number;
};

export type HealthKitBloodGlucosePayload = {
  kind: "blood_glucose";
  sourceSampleKey: string;
  measuredAtUtc: string;
  valueMgDl: number;
};

export type HealthKitWorkoutPayload = {
  kind: "workout";
  sourceSampleKey: string;
  workoutType: string;
  startedAtUtc: string;
  endedAtUtc: string;
  durationSeconds: number;
  activeEnergyKcal?: number;
  distanceMeters?: number;
  averageHeartRateBpm?: number;
  maximumHeartRateBpm?: number;
};

export type HealthKitOpPayload =
  | HealthKitStepsHourPayload
  | HealthKitSleepDayPayload
  | HealthKitDailyMetricPayload
  | HealthKitBloodPressurePayload
  | HealthKitBloodGlucosePayload
  | HealthKitWorkoutPayload;

export type HealthKitSyncOp = {
  opId: string;
  naturalKey: string;
  group: HealthKitConsentGroup;
  scopeKey: string;
  op: HealthKitOpKind;
  payload?: HealthKitOpPayload | null;
};

export type HealthKitOpsBatchInput = {
  installationId: string;
  personId: string;
  timezoneVersion: number;
  ops: HealthKitSyncOp[];
};

export type HealthKitOpApplyResult = {
  opId: string;
  result: HealthKitOpApplyCode;
  errorCode?: string;
  errorMessage?: string;
};

export type HealthKitOpsBatchResult = {
  results: HealthKitOpApplyResult[];
};

export type StartHealthKitImportInput = {
  installationId: string;
  personId: string;
  timezoneVersion: number;
};

export type HealthKitGroupImportStartResult = {
  group: HealthKitConsentGroup;
  status: "syncing";
  coverageStartAt: string;
  coverageEndAt: string;
};

export type MarkHealthKitGroupReadyInput = {
  installationId: string;
  personId: string;
  timezoneVersion: number;
  coverageStartAt?: string;
  coverageEndAt?: string;
};

export type HealthKitGroupReadyResult = {
  group: HealthKitConsentGroup;
  status: "ready";
  coverageStartAt?: string;
  coverageEndAt?: string;
};

export type HealthKitGroupStatus = {
  personId: string;
  group: HealthKitConsentGroup;
  enabled: boolean;
  status: "never_synced" | "syncing" | "ready" | "error" | "disabled" | "backfilling";
  lastSuccessfulAt?: string;
  lastAttemptAt?: string;
  lastErrorCode?: string;
  coverageStartAt?: string;
  coverageEndAt?: string;
};

/** Worker / client actions for transport + fencing errors (no session abort). */
export type HealthKitOpErrorAction =
  | "delete_local"
  | "fail_permanent"
  | "stop_group"
  | "halt_installation"
  | "refresh_timezone"
  | "refresh_auth"
  | "backoff";

export type HealthKitOpErrorCode =
  | "payload_invalid"
  | "consent_withdrawn"
  | "group_disabled"
  | "installation_inactive"
  | "timezone_stale"
  | "unauthorized"
  | "rate_limited"
  | "server_error"
  | "network_error";

export function healthKitOpErrorAction(code: HealthKitOpErrorCode): HealthKitOpErrorAction {
  switch (code) {
    case "payload_invalid":
      return "fail_permanent";
    case "consent_withdrawn":
    case "group_disabled":
      return "stop_group";
    case "installation_inactive":
      return "halt_installation";
    case "timezone_stale":
      return "refresh_timezone";
    case "unauthorized":
      return "refresh_auth";
    case "rate_limited":
    case "server_error":
    case "network_error":
      return "backoff";
  }
}

export function healthKitOpSuccessAction(result: HealthKitOpApplyCode): HealthKitOpErrorAction {
  switch (result) {
    case "applied":
    case "duplicate":
      return "delete_local";
    case "rejected":
      return "fail_permanent";
  }
}

export const HEALTHKIT_OPS_BATCH_MAX = 200;
export const BACKFILL_WINDOW_MS = 90 * 24 * 60 * 60 * 1000;
/** Short-TTL op receipt retention (days). */
export const HEALTHKIT_OP_RECEIPT_TTL_DAYS = 30;

/**
 * Narrow v1 allowlist for the correctness milestone.
 * Expand only after foreground soak is green.
 */
export const HEALTHKIT_V1_METRIC_KEYS = [
  "steps",
  "active_energy_burned",
  "exercise_time",
  "sleep",
  "heart_rate",
  "resting_heart_rate",
  "heart_rate_variability_sdnn",
  "blood_pressure",
  "blood_glucose",
  "body_mass",
  "workout"
] as const satisfies readonly HealthKitMetricKey[];

export type HealthKitV1MetricKey = (typeof HEALTHKIT_V1_METRIC_KEYS)[number];

export function isHealthKitV1MetricKey(value: string): value is HealthKitV1MetricKey {
  return (HEALTHKIT_V1_METRIC_KEYS as readonly string[]).includes(value);
}

/** Natural key for a source-keyed or bucketed record (sole consistency identity). */
export function healthKitNaturalKey(
  payload: HealthKitOpPayload | { kind: "delete"; scopeKey: string; bucketKey: string }
): string {
  if ("kind" in payload && payload.kind === "delete") {
    return `${payload.scopeKey}:${payload.bucketKey}`;
  }
  switch (payload.kind) {
    case "steps_hour":
      return `steps_hour:${payload.hourStartUtc}`;
    case "sleep_day":
      return `sleep_day:${payload.sleepDay}`;
    case "daily_metric":
      return `daily_metric:${payload.healthMetric}:${payload.localDay}`;
    case "blood_pressure":
      return `blood_pressure:${payload.sourceObjectKey}`;
    case "blood_glucose":
      return `blood_glucose:${payload.sourceSampleKey}`;
    case "workout":
      return `workout:${payload.sourceSampleKey}`;
  }
}

export function scopeKeyForPayload(payload: HealthKitOpPayload): HealthKitMetricKey {
  switch (payload.kind) {
    case "steps_hour":
      return "steps";
    case "sleep_day":
      return "sleep";
    case "daily_metric":
      return payload.healthMetric;
    case "blood_pressure":
      return "blood_pressure";
    case "blood_glucose":
      return "blood_glucose";
    case "workout":
      return "workout";
  }
}

export function groupForScopeKey(scopeKey: string): HealthKitConsentGroup | null {
  if (!isHealthKitMetricKey(scopeKey)) return null;
  return HEALTHKIT_METRIC_REGISTRY[scopeKey].group;
}

export function requiredScopeKeysForGroup(group: HealthKitConsentGroup): string[] {
  return healthKitMetricsForGroup(group);
}

export function bloodPressureNaturalKey(sourceObjectKey: string): string {
  return `blood_pressure:${sourceObjectKey}`;
}
