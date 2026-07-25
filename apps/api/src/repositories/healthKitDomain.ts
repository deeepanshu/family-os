import type {
  HealthKitConsentGroup,
  HealthKitMetric,
  HealthKitSyncOperation,
  HealthKitSyncResult,
  HealthMetricSyncStatusCode
} from "@family-os/shared";
import { HEALTHKIT_CONSENT_GROUPS, HEALTHKIT_METRIC_REGISTRY } from "@family-os/shared";
import { HttpError } from "../errors";

export const HEALTHKIT_METRICS: readonly HealthKitMetric[] = HEALTHKIT_CONSENT_GROUPS;
export const REPAIR_WINDOW_MS = 90 * 24 * 60 * 60 * 1000;
export const REPAIR_TTL_MS = 24 * 60 * 60 * 1000;

export function groupForOperation(op: HealthKitSyncOperation): HealthKitConsentGroup {
  switch (op.kind) {
    case "steps_hour_upsert":
    case "steps_hour_delete":
      return "activity";
    case "sleep_day_upsert":
    case "sleep_day_delete":
      return "sleep";
    case "daily_metric_upsert":
    case "daily_metric_delete": {
      return HEALTHKIT_METRIC_REGISTRY[op.healthMetric].group;
    }
    case "blood_pressure_upsert":
    case "blood_pressure_delete":
    case "blood_glucose_upsert":
    case "blood_glucose_delete":
      return "vitals";
    case "workout_upsert":
    case "workout_delete":
      return "workouts";
  }
}

export function groupsAffected(operations: HealthKitSyncOperation[]): HealthKitConsentGroup[] {
  return [...new Set(operations.map(groupForOperation))];
}

export function buildSyncResult(input: {
  syncId: string;
  operationCount: number;
  groupsAffected: HealthKitConsentGroup[];
  repairId?: string;
  chunkIndex?: number;
}): HealthKitSyncResult {
  return {
    syncId: input.syncId,
    accepted: true,
    operationCount: input.operationCount,
    groupsAffected: input.groupsAffected,
    repairId: input.repairId,
    chunkIndex: input.chunkIndex
  };
}

export function isValidIanaTimezone(timezone: string): boolean {
  try {
    Intl.DateTimeFormat(undefined, { timeZone: timezone });
    return true;
  } catch {
    return false;
  }
}

export function assertSelfProfileMatch(input: {
  selfProfileId: string | undefined;
  requestedPersonId: string;
}): asserts input is { selfProfileId: string; requestedPersonId: string } {
  if (!input.selfProfileId) {
    throw new HttpError(409, "healthkit_self_profile_required", "Create your self profile before using HealthKit sync.");
  }
  if (input.selfProfileId !== input.requestedPersonId) {
    throw new HttpError(409, "healthkit_self_profile_required", "HealthKit sync can only target your linked Self profile.");
  }
}

export function coverageComplete(input: {
  status: HealthMetricSyncStatusCode;
  coverageStartAt?: string;
  coverageEndAt?: string;
  rangeStart: string;
  rangeEnd: string;
}): boolean {
  if (input.status === "repairing" || input.status === "repair_needed" || input.status === "never_synced" || input.status === "disabled") {
    return false;
  }
  if (!input.coverageStartAt || !input.coverageEndAt) {
    return false;
  }
  return Date.parse(input.coverageStartAt) <= Date.parse(input.rangeStart) && Date.parse(input.coverageEndAt) >= Date.parse(input.rangeEnd);
}

export function toUtcIso(date: Date): string {
  return date.toISOString();
}

/**
 * Steps are stored as UTC hour buckets. Start their repair window at the next
 * whole UTC hour so every permitted bucket is fully inside the 90-day window.
 */
export function repairRangeStart(group: HealthKitConsentGroup, now: Date): Date {
  const start = new Date(now.getTime() - REPAIR_WINDOW_MS);
  if (group !== "activity") {
    return start;
  }

  start.setUTCMinutes(0, 0, 0);
  if (start.getTime() < now.getTime() - REPAIR_WINDOW_MS) {
    start.setUTCHours(start.getUTCHours() + 1);
  }
  return start;
}

export function dayStringFromUtcIso(iso: string): string {
  return iso.slice(0, 10);
}

/** Calendar-day arithmetic on YYYY-MM-DD (independent of timezone offset). */
export function addCalendarDays(day: string, delta: number): string {
  const date = new Date(`${day}T12:00:00.000Z`);
  if (Number.isNaN(date.getTime())) {
    throw new HttpError(400, "healthkit_operation_invalid", "Invalid calendar day.");
  }
  date.setUTCDate(date.getUTCDate() + delta);
  return date.toISOString().slice(0, 10);
}

/**
 * Inclusive profile-local sleep-day window ending on `rangeEndDay` (YYYY-MM-DD in health timezone).
 * `windowDays` counts calendar days (e.g. 90 => end and 89 prior days).
 */
export function profileLocalSleepDayRange(rangeEndDay: string, windowDays = 90): {
  rangeStartDay: string;
  rangeEndDay: string;
} {
  if (windowDays < 1) {
    throw new HttpError(400, "healthkit_repair_invalid", "Repair window must be at least one day.");
  }
  return {
    rangeStartDay: addCalendarDays(rangeEndDay, -(windowDays - 1)),
    rangeEndDay
  };
}

export type HealthKitRepairRange = {
  /** Inclusive UTC instant window for all instant-backed record types. */
  rangeStartIso: string;
  rangeEndIso: string;
  /** Inclusive profile-local sleep days (health timezone calendar). */
  rangeStartDay: string;
  rangeEndDay: string;
};

/**
 * Ensures a repair chunk operation falls within the server-issued repair window.
 * Instants use UTC bounds; sleep days use profile-local calendar days.
 */
export function assertOperationInRepairRange(op: HealthKitSyncOperation, range: HealthKitRepairRange): void {
  const rangeStartMs = Date.parse(range.rangeStartIso);
  const rangeEndMs = Date.parse(range.rangeEndIso);
  if (Number.isNaN(rangeStartMs) || Number.isNaN(rangeEndMs)) {
    throw new HttpError(400, "healthkit_repair_invalid", "Repair range is invalid.");
  }

  switch (op.kind) {
    case "steps_hour_upsert":
    case "steps_hour_delete": {
      const t = Date.parse(op.hourStartUtc);
      if (Number.isNaN(t) || t < rangeStartMs || t > rangeEndMs) {
        throw new HttpError(400, "healthkit_operation_invalid", "steps hour is outside the repair range.");
      }
      return;
    }
    case "sleep_day_upsert":
    case "sleep_day_delete":
    case "daily_metric_upsert":
    case "daily_metric_delete": {
      const localDay = op.kind === "daily_metric_upsert" || op.kind === "daily_metric_delete" ? op.localDay : op.sleepDay;
      if (localDay < range.rangeStartDay || localDay > range.rangeEndDay) {
        throw new HttpError(400, "healthkit_operation_invalid", "daily record is outside the repair range.");
      }
      return;
    }
    case "blood_pressure_upsert":
    case "blood_glucose_upsert":
    case "workout_upsert": {
      const instant = op.kind === "workout_upsert" ? op.startedAtUtc : op.measuredAtUtc;
      const t = Date.parse(instant);
      if (Number.isNaN(t) || t < rangeStartMs || t > rangeEndMs) {
        throw new HttpError(400, "healthkit_operation_invalid", "record is outside the repair range.");
      }
      return;
    }
    case "blood_pressure_delete":
    case "blood_glucose_delete":
    case "workout_delete":
      // Delete is keyed by correlation UUID; range is enforced against stored rows at apply time when available.
      return;
    default: {
      const _exhaustive: never = op;
      throw new HttpError(400, "healthkit_operation_invalid", `Unknown operation ${(_exhaustive as HealthKitSyncOperation).kind}`);
    }
  }
}

/**
 * Incomplete repair and post-timezone-change windows must not expose records via MCP
 * until the required repair completes under the current health timezone version.
 */
export function shouldWithholdMetricRecords(status: HealthMetricSyncStatusCode): boolean {
  return status === "repairing" || status === "repair_needed";
}
