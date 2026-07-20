import type { HealthKitSampleRecord } from "../repositories/contracts";
import type { McpSeriesPoint } from "@family-os/shared";
import { isDateInInclusiveRange, localDateString, localHourBucket } from "./timezone";

export function expandDateRangeForTimezoneEdges(rangeStart: string, rangeEnd: string): {
  fetchStart: string;
  fetchEnd: string;
} {
  const startMs = Date.parse(`${rangeStart}T12:00:00.000Z`) - 24 * 60 * 60 * 1000;
  const endMs = Date.parse(`${rangeEnd}T12:00:00.000Z`) + 24 * 60 * 60 * 1000;
  return {
    fetchStart: new Date(startMs).toISOString().slice(0, 10),
    fetchEnd: new Date(endMs).toISOString().slice(0, 10)
  };
}

export function aggregateHourlySteps(
  samples: HealthKitSampleRecord[],
  rangeStart: string,
  rangeEnd: string,
  timezone: string
): McpSeriesPoint[] {
  const totals = new Map<string, number>();
  for (const sample of samples) {
    const value = sample.value ?? 0;
    if (value === 0) continue;
    const allocations = allocateValueAcrossLocalHours(
      sample.startDate,
      sample.endDate,
      value,
      timezone
    );
    for (const [bucket, amount] of allocations) {
      const localDate = bucket.slice(0, 10);
      if (!isDateInInclusiveRange(localDate, rangeStart, rangeEnd)) continue;
      totals.set(bucket, (totals.get(bucket) ?? 0) + amount);
    }
  }
  return [...totals.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([bucket, value]) => ({ bucket, value: roundTo(value, 3) }));
}

export function aggregateDailySteps(
  samples: HealthKitSampleRecord[],
  rangeStart: string,
  rangeEnd: string,
  timezone: string
): McpSeriesPoint[] {
  const totals = new Map<string, number>();
  for (const sample of samples) {
    const value = sample.value ?? 0;
    if (value === 0) continue;
    const allocations = allocateValueAcrossLocalHours(
      sample.startDate,
      sample.endDate,
      value,
      timezone
    );
    for (const [hourBucket, amount] of allocations) {
      const localDate = hourBucket.slice(0, 10);
      if (!isDateInInclusiveRange(localDate, rangeStart, rangeEnd)) continue;
      totals.set(localDate, (totals.get(localDate) ?? 0) + amount);
    }
  }
  return [...totals.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([bucket, value]) => ({ bucket, value: roundTo(value, 3) }));
}

export function aggregateDailySleepHours(
  samples: HealthKitSampleRecord[],
  rangeStart: string,
  rangeEnd: string,
  timezone: string
): McpSeriesPoint[] {
  const totals = new Map<string, number>();
  for (const sample of samples) {
    const minutes = sample.value ?? 0;
    if (minutes === 0) continue;
    const endInstant = new Date(sample.endDate ?? sample.startDate);
    const localDate = localDateString(endInstant, timezone);
    if (!isDateInInclusiveRange(localDate, rangeStart, rangeEnd)) continue;
    totals.set(localDate, (totals.get(localDate) ?? 0) + minutes / 60);
  }
  return [...totals.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([bucket, value]) => ({ bucket, value: roundTo(value, 2) }));
}

export function allocateValueAcrossLocalHours(
  startDate: string,
  endDate: string | undefined,
  value: number,
  timezone: string
): Map<string, number> {
  const startMs = Date.parse(startDate);
  let endMs = endDate ? Date.parse(endDate) : startMs;
  if (!Number.isFinite(startMs)) {
    return new Map();
  }
  if (!Number.isFinite(endMs) || endMs <= startMs) {
    const bucket = localHourBucket(new Date(startMs), timezone);
    return new Map([[bucket, value]]);
  }

  const totalMs = endMs - startMs;
  const amounts = new Map<string, number>();
  let cursor = startMs;
  let guard = 0;
  while (cursor < endMs && guard < 10_000) {
    guard += 1;
    const bucket = localHourBucket(new Date(cursor), timezone);
    const nextBoundary = nextLocalHourBoundaryMs(cursor, timezone);
    const segmentEnd = Math.min(endMs, nextBoundary);
    const fraction = (segmentEnd - cursor) / totalMs;
    amounts.set(bucket, (amounts.get(bucket) ?? 0) + value * fraction);
    cursor = segmentEnd;
  }
  return amounts;
}

/**
 * UTC instant of the next local-hour boundary after `fromMs`.
 *
 * Uses binary search over the local hour bucket so samples with non-zero
 * seconds/milliseconds (e.g. 08:30:30) land on the true wall-clock hour
 * (09:00:00), and DST spring-forward / fall-back transitions stay correct.
 */
export function nextLocalHourBoundaryMs(fromMs: number, timezone: string): number {
  const current = localHourBucket(new Date(fromMs), timezone);
  // Search up to 3 hours ahead to cover fall-back (25h day) and clock skew.
  let lo = fromMs + 1;
  let hi = fromMs + 3 * 3_600_000;

  if (localHourBucket(new Date(hi), timezone) === current) {
    // Degenerate timezone / clock: fall back to nominal hour.
    return fromMs + 3_600_000;
  }

  while (lo < hi) {
    const mid = Math.floor((lo + hi) / 2);
    if (localHourBucket(new Date(mid), timezone) === current) {
      lo = mid + 1;
    } else {
      hi = mid;
    }
  }
  return lo;
}

function roundTo(value: number, digits: number): number {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}
