import type {
  HealthKitMetric,
  HealthKitSyncOperation,
  HealthKitSyncResult,
  HealthMetricSyncStatusCode
} from "@family-os/shared";
import { HttpError } from "../errors";

export const HEALTHKIT_METRICS: readonly HealthKitMetric[] = ["steps", "sleep", "blood_pressure"] as const;
export const REPAIR_WINDOW_MS = 90 * 24 * 60 * 60 * 1000;
export const REPAIR_TTL_MS = 24 * 60 * 60 * 1000;

export function metricForOperation(op: HealthKitSyncOperation): HealthKitMetric {
  switch (op.kind) {
    case "steps_hour_upsert":
      return "steps";
    case "sleep_day_upsert":
      return "sleep";
    case "blood_pressure_upsert":
    case "blood_pressure_delete":
      return "blood_pressure";
  }
}

export function metricsAffected(operations: HealthKitSyncOperation[]): HealthKitMetric[] {
  return [...new Set(operations.map(metricForOperation))];
}

export function buildSyncResult(input: {
  syncId: string;
  operationCount: number;
  metricsAffected: HealthKitMetric[];
  repairId?: string;
  chunkIndex?: number;
}): HealthKitSyncResult {
  return {
    syncId: input.syncId,
    accepted: true,
    operationCount: input.operationCount,
    metricsAffected: input.metricsAffected,
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
  /** Inclusive UTC instant window for steps/BP. */
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
    case "steps_hour_upsert": {
      const t = Date.parse(op.hourStartUtc);
      if (Number.isNaN(t) || t < rangeStartMs || t > rangeEndMs) {
        throw new HttpError(400, "healthkit_operation_invalid", "steps hour is outside the repair range.");
      }
      return;
    }
    case "sleep_day_upsert": {
      if (op.sleepDay < range.rangeStartDay || op.sleepDay > range.rangeEndDay) {
        throw new HttpError(400, "healthkit_operation_invalid", "sleep day is outside the repair range.");
      }
      return;
    }
    case "blood_pressure_upsert": {
      const t = Date.parse(op.measuredAtUtc);
      if (Number.isNaN(t) || t < rangeStartMs || t > rangeEndMs) {
        throw new HttpError(400, "healthkit_operation_invalid", "blood pressure measurement is outside the repair range.");
      }
      return;
    }
    case "blood_pressure_delete":
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
