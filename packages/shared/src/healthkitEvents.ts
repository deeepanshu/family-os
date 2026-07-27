import {
  HEALTHKIT_METRIC_REGISTRY,
  healthKitMetricsForGroup,
  isHealthKitMetricKey,
  type HealthKitConsentGroup,
  type HealthKitMetricKey
} from "./healthkitRegistry";
import {
  canonicalHealthEventString,
  canonicalScopeManifestString,
  sha256HexFromUtf8
} from "./healthkitCanonical";

export type HealthKitEventOp = "upsert" | "delete";

/** Per-event apply outcomes returned by POST /events:batch. */
export type HealthKitEventApplyCode =
  | "applied"
  | "duplicate"
  | "superseded"
  | "payload_invalid"
  | "event_conflict";

/**
 * Worker / client actions derived from API and transport outcomes.
 * See docs/HEALTHKIT_SYNC_PLAN.md.
 */
export type HealthKitSyncErrorAction =
  | "delete_local"
  | "fail_permanent"
  | "abort_session"
  | "stop_group"
  | "halt_installation"
  | "refresh_timezone"
  | "new_session"
  | "drain_and_retry"
  | "refresh_auth"
  | "backoff";

export type HealthKitSyncErrorCode =
  | "payload_invalid"
  | "event_conflict"
  | "consent_withdrawn"
  | "group_disabled"
  | "installation_inactive"
  | "timezone_stale"
  | "session_expired"
  | "session_incomplete"
  | "manifest_incomplete"
  | "unauthorized"
  | "rate_limited"
  | "server_error"
  | "network_error";

export function healthKitErrorAction(
  code: HealthKitSyncErrorCode,
  options: { sessionTagged?: boolean } = {}
): HealthKitSyncErrorAction {
  switch (code) {
    case "payload_invalid":
    case "event_conflict":
      return options.sessionTagged ? "abort_session" : "fail_permanent";
    case "consent_withdrawn":
    case "group_disabled":
      return "stop_group";
    case "installation_inactive":
      return "halt_installation";
    case "timezone_stale":
      return "refresh_timezone";
    case "session_expired":
    case "manifest_incomplete":
      return "new_session";
    case "session_incomplete":
      return "drain_and_retry";
    case "unauthorized":
      return "refresh_auth";
    case "rate_limited":
    case "server_error":
    case "network_error":
      return "backoff";
  }
}

export function healthKitSuccessAction(
  result: HealthKitEventApplyCode
): HealthKitSyncErrorAction | "delete_local" {
  switch (result) {
    case "applied":
    case "duplicate":
    case "superseded":
      return "delete_local";
    case "payload_invalid":
    case "event_conflict":
      return "fail_permanent";
  }
}

// --- Payload kinds (upsert bodies; deletes carry null payload) ---

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
  /** HealthKit object UUID (HKCorrelation for BP, not a single quantity sample). */
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

export type HealthKitEventPayload =
  | HealthKitStepsHourPayload
  | HealthKitSleepDayPayload
  | HealthKitDailyMetricPayload
  | HealthKitBloodPressurePayload
  | HealthKitBloodGlucosePayload
  | HealthKitWorkoutPayload;

export type HealthKitSyncEvent = {
  eventId: string;
  entityKey: string;
  entityVersion: number;
  group: HealthKitConsentGroup;
  scopeKey: string;
  op: HealthKitEventOp;
  sessionId?: string | null;
  payload?: HealthKitEventPayload | null;
};

export type HealthKitEventsBatchInput = {
  installationId: string;
  personId: string;
  timezoneVersion: number;
  events: HealthKitSyncEvent[];
};

export type HealthKitEventApplyResult = {
  eventId: string;
  result: HealthKitEventApplyCode;
  errorCode?: string;
  errorMessage?: string;
};

export type HealthKitEventsBatchResult = {
  results: HealthKitEventApplyResult[];
};

export type CreateHealthKitBackfillSessionInput = {
  installationId: string;
  personId: string;
  timezoneVersion: number;
  group: HealthKitConsentGroup;
};

export type HealthKitBackfillSession = {
  sessionId: string;
  personId: string;
  group: HealthKitConsentGroup;
  installationId: string;
  timezoneVersion: number;
  /** Inclusive UTC instant bounds. */
  rangeStart: string;
  rangeEnd: string;
  /** Inclusive profile-local calendar days. */
  rangeStartDay: string;
  rangeEndDay: string;
  requiredScopeKeys: string[];
  status: HealthKitBackfillSessionStatus;
  expiresAt: string;
  pendingCount?: number;
};

export type HealthKitBackfillSessionStatus =
  | "open"
  | "completing"
  | "completed"
  | "aborted"
  | "expired";

export type PutHealthKitScopeManifestInput = {
  installationId: string;
  personId: string;
  timezoneVersion: number;
  eventCount: number;
  manifestHash: string;
};

export type HealthKitScopeManifestResult = {
  sessionId: string;
  scopeKey: string;
  status: "accepted" | "duplicate";
  eventCount: number;
};

export type CompleteHealthKitBackfillSessionInput = {
  installationId: string;
  personId: string;
  timezoneVersion: number;
};

export type HealthKitBackfillSessionCompleteResult = {
  sessionId: string;
  group: HealthKitConsentGroup;
  completed: true;
};

export type AbortHealthKitBackfillSessionInput = {
  installationId: string;
  personId: string;
  timezoneVersion: number;
  reason?: string;
};

export type HealthKitBackfillSessionAbortResult = {
  sessionId: string;
  group: HealthKitConsentGroup;
  aborted: true;
};

export type HealthKitGroupManifest = {
  personId: string;
  group: HealthKitConsentGroup;
  installationId?: string;
  entityCount: number;
  entities: Array<{
    entityKey: string;
    entityVersion: number;
    fingerprint: string;
    op: HealthKitEventOp;
  }>;
};

export const HEALTHKIT_EVENTS_BATCH_MAX = 500;
export const BACKFILL_WINDOW_MS = 90 * 24 * 60 * 60 * 1000;
export const BACKFILL_SESSION_TTL_MS = 24 * 60 * 60 * 1000;

/** Build entity key for a source-keyed or bucketed record. */
export function healthKitEntityKey(
  payload: HealthKitEventPayload | { kind: "delete"; scopeKey: string; bucketKey: string }
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

export function scopeKeyForPayload(payload: HealthKitEventPayload): HealthKitMetricKey {
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

export function fingerprintHealthEvent(
  event: HealthKitSyncEvent,
  sha256: (data: Uint8Array) => Uint8Array | ArrayBuffer
): string {
  return sha256HexFromUtf8(
    canonicalHealthEventString({
      eventId: event.eventId,
      entityKey: event.entityKey,
      entityVersion: event.entityVersion,
      group: event.group,
      scopeKey: event.scopeKey,
      op: event.op,
      sessionId: event.sessionId,
      payload: event.payload
    }),
    sha256
  );
}

export function fingerprintScopeManifest(
  input: { sessionId: string; scopeKey: string; eventIds: string[] },
  sha256: (data: Uint8Array) => Uint8Array | ArrayBuffer
): string {
  return sha256HexFromUtf8(canonicalScopeManifestString(input), sha256);
}

/** Node-friendly SHA-256 hex helper for tests and the API process. */
export function nodeSha256Hex(utf8: string): string {
  // Lazy require pattern avoided; callers in Node should pass createHash.
  throw new Error("Use fingerprint helpers with an injected sha256 implementation.");
}
