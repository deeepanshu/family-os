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
