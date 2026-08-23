/**
 * Correctness-first HealthKit ops protocol.
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

/** Pause / resume / lap / marker style events on a workout (layer B). */
export type HealthKitWorkoutEvent = {
  type: string;
  dateUtc: string;
  endDateUtc?: string;
};

/** Multi-sport segment from HKWorkoutActivity (layer C). */
export type HealthKitWorkoutActivitySegment = {
  workoutType: string;
  startedAtUtc: string;
  endedAtUtc: string;
  durationSeconds: number;
};

/** Fat workout summary (layer A) + optional events/activities (B/C). No GPS or metric series. */
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
  minimumHeartRateBpm?: number;
  sourceName?: string;
  sourceBundleId?: string;
  deviceName?: string;
  deviceManufacturer?: string;
  isIndoor?: boolean;
  elevationAscendedMeters?: number;
  averageMETs?: number;
  swimmingStrokeCount?: number;
  totalFlightsClimbed?: number;
  events?: HealthKitWorkoutEvent[];
  activities?: HealthKitWorkoutActivitySegment[];
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

/**
 * Run kinds for the generic run lifecycle.
 * - initial_import: first 90-day fill; never deletes.
 * - sync: incremental (last success minus overlap); never deletes.
 * - repair_import: explicit 90-day repair; only kind allowed to delete, via
 *   completion-time missing-key reconciliation.
 */
export const HEALTHKIT_RUN_KINDS = ["initial_import", "sync", "repair_import"] as const;
export type HealthKitRunKind = (typeof HEALTHKIT_RUN_KINDS)[number];

export function isHealthKitRunKind(value: string): value is HealthKitRunKind {
  return (HEALTHKIT_RUN_KINDS as readonly string[]).includes(value);
}

export type BeginHealthKitRunInput = {
  installationId: string;
  personId: string;
  timezoneVersion: number;
  kind: HealthKitRunKind;
};

/** Authoritative run descriptor derived by the server at begin time. */
export type HealthKitRunBeginResult = {
  group: HealthKitConsentGroup;
  kind: HealthKitRunKind;
  rangeStartAt: string;
  rangeEndAt: string;
  allowDeletes: boolean;
};

export type CompleteHealthKitRunInput = {
  installationId: string;
  personId: string;
  timezoneVersion: number;
  kind: HealthKitRunKind;
  /** Authoritative range echoed back from the begin descriptor. */
  rangeStartAt: string;
  rangeEndAt: string;
  /**
   * Repair only: explicit declaration that the client read the complete Apple
   * Health snapshot for the repair window. Required for repair_import; forbidden
   * for initial_import and sync.
   */
  completeSnapshot?: boolean;
  /**
   * Repair only: complete set of present natural keys inside the repair window.
   * May be empty (a user can legitimately have no matching records). Forbidden
   * for initial_import and sync so deletes can never bypass repair reconciliation.
   */
  presentNaturalKeys?: string[];
};

export type HealthKitRunCompleteResult = {
  group: HealthKitConsentGroup;
  kind: HealthKitRunKind;
  status: "ready";
  deletedCount: number;
  lastSuccessfulAt: string;
  coverageStartAt?: string;
  coverageEndAt?: string;
  needsInitialImport: boolean;
};

/** Client could not finish after begin. Never deletes and never moves coverage. */
export type FailHealthKitRunInput = {
  installationId: string;
  personId: string;
  timezoneVersion: number;
  kind: HealthKitRunKind;
  errorCode: string;
};

export type HealthKitRunFailResult = {
  group: HealthKitConsentGroup;
  kind: HealthKitRunKind;
  status: "ready" | "error";
  lastSuccessfulAt?: string;
  lastErrorCode: string;
  coverageStartAt?: string;
  coverageEndAt?: string;
  needsInitialImport: boolean;
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
  /** True until a completed history import matches the active installation + timezone version. */
  needsInitialImport: boolean;
  historyImportCompletedAt?: string;
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
/** Routine sync re-reads this much already-synced history (idempotent upserts make it safe). */
export const HEALTHKIT_SYNC_OVERLAP_MS = 24 * 60 * 60 * 1000;

/**
 * Consent groups with an implemented product surface in this release
 * (app labels: Activity, Vitals, Sleep, Workouts).
 */
export const HEALTHKIT_PRODUCT_GROUPS = ["activity", "vitals", "sleep", "workouts"] as const satisfies readonly HealthKitConsentGroup[];
export type HealthKitProductGroup = (typeof HEALTHKIT_PRODUCT_GROUPS)[number];

export function isHealthKitProductGroup(value: string): value is HealthKitProductGroup {
  return (HEALTHKIT_PRODUCT_GROUPS as readonly string[]).includes(value);
}

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
