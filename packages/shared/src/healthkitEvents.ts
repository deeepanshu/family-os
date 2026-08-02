/**
 * Legacy HealthKit event/session types retained only for historical fixtures.
 * New clients and API use healthkitOps.ts (natural-key ops:batch).
 */
import type { HealthKitConsentGroup } from "./healthkitRegistry";
import {
  BACKFILL_WINDOW_MS,
  groupForScopeKey,
  healthKitNaturalKey,
  requiredScopeKeysForGroup,
  scopeKeyForPayload,
  type HealthKitBloodGlucosePayload,
  type HealthKitBloodPressurePayload,
  type HealthKitDailyMetricPayload,
  type HealthKitOpPayload,
  type HealthKitSleepDayPayload,
  type HealthKitStepsHourPayload,
  type HealthKitWorkoutPayload
} from "./healthkitOps";
import {
  canonicalHealthEventString,
  canonicalScopeManifestString,
  sha256HexFromUtf8
} from "./healthkitCanonical";

export {
  BACKFILL_WINDOW_MS,
  groupForScopeKey,
  requiredScopeKeysForGroup,
  scopeKeyForPayload
};

export type HealthKitEventOp = "upsert" | "delete";

/** @deprecated Prefer HealthKitOpApplyCode from healthkitOps. */
export type HealthKitEventApplyCode =
  | "applied"
  | "duplicate"
  | "superseded"
  | "payload_invalid"
  | "event_conflict";

/** @deprecated Prefer HealthKitOpErrorAction from healthkitOps. */
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

/** @deprecated Prefer HealthKitOpErrorCode from healthkitOps. */
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

export type {
  HealthKitStepsHourPayload,
  HealthKitSleepDayPayload,
  HealthKitDailyMetricPayload,
  HealthKitBloodPressurePayload,
  HealthKitBloodGlucosePayload,
  HealthKitWorkoutPayload
};

export type HealthKitEventPayload = HealthKitOpPayload;

/** @deprecated Prefer HealthKitSyncOp. */
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

/** @deprecated Prefer HealthKitOpsBatchInput. */
export type HealthKitEventsBatchInput = {
  installationId: string;
  personId: string;
  timezoneVersion: number;
  events: HealthKitSyncEvent[];
};

/** @deprecated Prefer HealthKitOpApplyResult. */
export type HealthKitEventApplyResult = {
  eventId: string;
  result: HealthKitEventApplyCode;
  errorCode?: string;
  errorMessage?: string;
};

/** @deprecated Prefer HealthKitOpsBatchResult. */
export type HealthKitEventsBatchResult = {
  results: HealthKitEventApplyResult[];
};

/** @deprecated Sessions removed in correctness rewrite. */
export type CreateHealthKitBackfillSessionInput = {
  installationId: string;
  personId: string;
  timezoneVersion: number;
  group: HealthKitConsentGroup;
};

/** @deprecated Sessions removed in correctness rewrite. */
export type HealthKitBackfillSession = {
  sessionId: string;
  personId: string;
  group: HealthKitConsentGroup;
  installationId: string;
  timezoneVersion: number;
  rangeStart: string;
  rangeEnd: string;
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

/** @deprecated Scope manifests removed in correctness rewrite. */
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

/** @deprecated Entity ledgers removed in correctness rewrite. */
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
export const BACKFILL_SESSION_TTL_MS = 24 * 60 * 60 * 1000;

/** @deprecated Prefer healthKitNaturalKey. */
export function healthKitEntityKey(
  payload: HealthKitEventPayload | { kind: "delete"; scopeKey: string; bucketKey: string }
): string {
  return healthKitNaturalKey(payload);
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

export function nodeSha256Hex(_utf8: string): string {
  throw new Error("Use fingerprint helpers with an injected sha256 implementation.");
}
