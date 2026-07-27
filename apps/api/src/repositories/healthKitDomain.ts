import type {
  HealthKitConsentGroup,
  HealthKitEventPayload,
  HealthKitMetric,
  HealthKitSyncEvent,
  HealthMetricSyncStatusCode
} from "@family-os/shared";
import {
  BACKFILL_WINDOW_MS,
  HEALTHKIT_CONSENT_GROUPS,
  HEALTHKIT_METRIC_REGISTRY,
  groupForScopeKey,
  healthKitEntityKey,
  isHealthKitMetricKey,
  requiredScopeKeysForGroup
} from "@family-os/shared";
import { HttpError } from "../errors";

export const HEALTHKIT_METRICS: readonly HealthKitMetric[] = HEALTHKIT_CONSENT_GROUPS;
export const BACKFILL_TTL_MS = 24 * 60 * 60 * 1000;

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

export function isValidIanaTimezone(timezone: string): boolean {
  try {
    Intl.DateTimeFormat(undefined, { timeZone: timezone });
    return true;
  } catch {
    return false;
  }
}

export function coverageComplete(input: {
  status: HealthMetricSyncStatusCode;
  coverageStartAt?: string;
  coverageEndAt?: string;
  rangeStart: string;
  rangeEnd: string;
}): boolean {
  if (input.status === "backfilling" || input.status === "never_synced" || input.status === "disabled" || input.status === "error") {
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
 * Steps are stored as UTC hour buckets. Start their backfill window at the next
 * whole UTC hour so every permitted bucket is fully inside the 90-day window.
 */
export function backfillRangeStart(group: HealthKitConsentGroup, now: Date): Date {
  const start = new Date(now.getTime() - BACKFILL_WINDOW_MS);
  if (group !== "activity") {
    return start;
  }

  start.setUTCMinutes(0, 0, 0);
  if (start.getTime() < now.getTime() - BACKFILL_WINDOW_MS) {
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
    throw new HttpError(400, "payload_invalid", "Invalid calendar day.");
  }
  date.setUTCDate(date.getUTCDate() + delta);
  return date.toISOString().slice(0, 10);
}

/**
 * Inclusive profile-local day window ending on `rangeEndDay` (YYYY-MM-DD in health timezone).
 * `windowDays` counts calendar days (e.g. 90 => end and 89 prior days).
 */
export function profileLocalDayRange(rangeEndDay: string, windowDays = 90): {
  rangeStartDay: string;
  rangeEndDay: string;
} {
  if (windowDays < 1) {
    throw new HttpError(400, "session_invalid", "Backfill window must be at least one day.");
  }
  return {
    rangeStartDay: addCalendarDays(rangeEndDay, -(windowDays - 1)),
    rangeEndDay
  };
}

export type HealthKitBackfillRange = {
  rangeStartIso: string;
  rangeEndIso: string;
  rangeStartDay: string;
  rangeEndDay: string;
};

export function scopesForGroup(group: HealthKitConsentGroup): string[] {
  return requiredScopeKeysForGroup(group);
}

/**
 * Incomplete backfill and post-timezone-change windows must not expose records via MCP
 * until the required backfill completes under the current health timezone version.
 */
export function shouldWithholdMetricRecords(status: HealthMetricSyncStatusCode): boolean {
  return status === "backfilling" || status === "never_synced" || status === "error";
}

const DATE_SANITY_PAST_MS = 10 * 365 * 24 * 60 * 60 * 1000;
const DATE_SANITY_FUTURE_MS = 2 * 24 * 60 * 60 * 1000;

export function assertUtcHourBoundary(hourStartUtc: string) {
  const date = new Date(hourStartUtc);
  if (Number.isNaN(date.getTime())) {
    throw new HttpError(400, "payload_invalid", "hourStartUtc must be a valid UTC instant.");
  }
  if (date.getUTCMinutes() !== 0 || date.getUTCSeconds() !== 0 || date.getUTCMilliseconds() !== 0) {
    throw new HttpError(400, "payload_invalid", "hourStartUtc must fall on a UTC hour boundary.");
  }
}

export function assertDateSanity(iso: string, now = new Date()) {
  const t = Date.parse(iso);
  if (Number.isNaN(t)) {
    throw new HttpError(400, "payload_invalid", "Timestamp is invalid.");
  }
  if (t < now.getTime() - DATE_SANITY_PAST_MS || t > now.getTime() + DATE_SANITY_FUTURE_MS) {
    throw new HttpError(400, "payload_invalid", "Timestamp is outside the allowed sanity window.");
  }
}

export function assertEventCoherent(event: HealthKitSyncEvent): void {
  if (event.entityVersion < 1) {
    throw new HttpError(400, "payload_invalid", "entityVersion must be >= 1.");
  }
  if (!isHealthKitMetricKey(event.scopeKey)) {
    throw new HttpError(400, "payload_invalid", "scopeKey is not allowlisted.");
  }
  const expectedGroup = groupForScopeKey(event.scopeKey);
  if (expectedGroup !== event.group) {
    throw new HttpError(400, "payload_invalid", "group does not match scopeKey.");
  }

  if (event.op === "delete") {
    if (event.payload != null) {
      throw new HttpError(400, "payload_invalid", "delete events must not include a payload.");
    }
    return;
  }

  if (!event.payload) {
    throw new HttpError(400, "payload_invalid", "upsert events require a payload.");
  }
  assertPayloadValid(event.payload, event);
}

function assertPayloadValid(payload: HealthKitEventPayload, event: HealthKitSyncEvent): void {
  const expectedKey = healthKitEntityKey(payload);
  if (event.entityKey !== expectedKey) {
    throw new HttpError(400, "payload_invalid", "entityKey does not match payload.");
  }

  switch (payload.kind) {
    case "steps_hour": {
      if (event.scopeKey !== "steps") throw new HttpError(400, "payload_invalid", "steps payload scope mismatch.");
      assertUtcHourBoundary(payload.hourStartUtc);
      assertDateSanity(payload.hourStartUtc);
      if (!Number.isInteger(payload.count) || payload.count < 0 || payload.count > 200_000) {
        throw new HttpError(400, "payload_invalid", "steps count is invalid.");
      }
      return;
    }
    case "sleep_day": {
      if (event.scopeKey !== "sleep") throw new HttpError(400, "payload_invalid", "sleep payload scope mismatch.");
      assertYmd(payload.sleepDay);
      const fields = [
        payload.totalMinutes,
        payload.coreMinutes,
        payload.deepMinutes,
        payload.remMinutes,
        payload.unspecifiedAsleepMinutes,
        payload.awakeMinutes,
        payload.inBedMinutes
      ];
      for (const value of fields) {
        if (!Number.isInteger(value) || value < 0 || value > 24 * 60) {
          throw new HttpError(400, "payload_invalid", "sleep minutes are invalid.");
        }
      }
      const asleep =
        payload.coreMinutes + payload.deepMinutes + payload.remMinutes + payload.unspecifiedAsleepMinutes;
      if (payload.totalMinutes !== asleep) {
        throw new HttpError(400, "payload_invalid", "sleep stage minutes must sum to totalMinutes.");
      }
      if (payload.inBedMinutes < payload.totalMinutes) {
        throw new HttpError(400, "payload_invalid", "inBedMinutes must be >= totalMinutes.");
      }
      if (
        payload.wristTemperatureCelsius !== undefined &&
        (payload.wristTemperatureCelsius < 25 || payload.wristTemperatureCelsius > 45)
      ) {
        throw new HttpError(400, "payload_invalid", "wrist temperature is out of range.");
      }
      if (
        payload.breathingDisturbanceCount !== undefined &&
        (!Number.isInteger(payload.breathingDisturbanceCount) ||
          payload.breathingDisturbanceCount < 0 ||
          payload.breathingDisturbanceCount > 10_000)
      ) {
        throw new HttpError(400, "payload_invalid", "breathing disturbance count is invalid.");
      }
      return;
    }
    case "daily_metric": {
      if (payload.healthMetric !== event.scopeKey) {
        throw new HttpError(400, "payload_invalid", "daily metric scope mismatch.");
      }
      if (!isHealthKitMetricKey(payload.healthMetric)) {
        throw new HttpError(400, "payload_invalid", "healthMetric is not allowlisted.");
      }
      const definition = HEALTHKIT_METRIC_REGISTRY[payload.healthMetric];
      if (definition.storage !== "daily_numeric" || !definition.aggregation) {
        throw new HttpError(400, "payload_invalid", "healthMetric does not use daily numeric storage.");
      }
      assertYmd(payload.localDay);
      if (!Number.isInteger(payload.sampleCount) || payload.sampleCount < 1 || payload.sampleCount > 1_000_000) {
        throw new HttpError(400, "payload_invalid", "sampleCount is invalid.");
      }
      const provided = [
        payload.sumValue,
        payload.averageValue,
        payload.minimumValue,
        payload.maximumValue,
        payload.latestValue
      ].filter((value) => value !== undefined).length;
      if (definition.aggregation === "sum" && (payload.sumValue === undefined || provided !== 1)) {
        throw new HttpError(400, "payload_invalid", "Summed metric requires only sumValue.");
      }
      if (
        definition.aggregation === "statistics" &&
        (payload.averageValue === undefined ||
          payload.minimumValue === undefined ||
          payload.maximumValue === undefined ||
          payload.latestValue === undefined ||
          provided !== 4)
      ) {
        throw new HttpError(400, "payload_invalid", "Statistics metric requires average, min, max, latest.");
      }
      if (
        definition.aggregation === "statistics" &&
        payload.minimumValue! > payload.maximumValue!
      ) {
        throw new HttpError(400, "payload_invalid", "minimumValue must be <= maximumValue.");
      }
      if (
        definition.aggregation === "statistics" &&
        (payload.averageValue! < payload.minimumValue! || payload.averageValue! > payload.maximumValue!)
      ) {
        throw new HttpError(400, "payload_invalid", "averageValue must fall between min and max.");
      }
      if (definition.aggregation === "latest" && (payload.latestValue === undefined || provided !== 1)) {
        throw new HttpError(400, "payload_invalid", "Latest metric requires only latestValue.");
      }
      return;
    }
    case "blood_pressure": {
      if (event.scopeKey !== "blood_pressure") throw new HttpError(400, "payload_invalid", "BP scope mismatch.");
      assertDateSanity(payload.measuredAtUtc);
      if (payload.systolic < 50 || payload.systolic > 260 || payload.diastolic < 30 || payload.diastolic > 180) {
        throw new HttpError(400, "payload_invalid", "blood pressure values are out of range.");
      }
      if (payload.systolic <= payload.diastolic) {
        throw new HttpError(400, "payload_invalid", "systolic must be greater than diastolic.");
      }
      if (payload.pulse !== undefined && (payload.pulse < 30 || payload.pulse > 220)) {
        throw new HttpError(400, "payload_invalid", "pulse is out of range.");
      }
      return;
    }
    case "blood_glucose": {
      if (event.scopeKey !== "blood_glucose") throw new HttpError(400, "payload_invalid", "glucose scope mismatch.");
      assertDateSanity(payload.measuredAtUtc);
      if (payload.valueMgDl < 20 || payload.valueMgDl > 700) {
        throw new HttpError(400, "payload_invalid", "glucose value is out of range.");
      }
      return;
    }
    case "workout": {
      if (event.scopeKey !== "workout") throw new HttpError(400, "payload_invalid", "workout scope mismatch.");
      assertDateSanity(payload.startedAtUtc);
      assertDateSanity(payload.endedAtUtc);
      const start = Date.parse(payload.startedAtUtc);
      const end = Date.parse(payload.endedAtUtc);
      if (end < start) {
        throw new HttpError(400, "payload_invalid", "workout end must be >= start.");
      }
      if (!Number.isInteger(payload.durationSeconds) || payload.durationSeconds < 0 || payload.durationSeconds > 7 * 24 * 60 * 60) {
        throw new HttpError(400, "payload_invalid", "workout duration is invalid.");
      }
      if (
        payload.averageHeartRateBpm !== undefined &&
        payload.maximumHeartRateBpm !== undefined &&
        payload.averageHeartRateBpm > payload.maximumHeartRateBpm
      ) {
        throw new HttpError(400, "payload_invalid", "average heart rate must be <= maximum.");
      }
      if (payload.workoutType.trim().length < 1 || payload.workoutType.length > 100) {
        throw new HttpError(400, "payload_invalid", "workoutType is invalid.");
      }
      return;
    }
    default: {
      const _exhaustive: never = payload;
      throw new HttpError(400, "payload_invalid", `Unknown payload kind ${(_exhaustive as HealthKitEventPayload).kind}`);
    }
  }
}

function assertYmd(value: string) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    throw new HttpError(400, "payload_invalid", "Date must be YYYY-MM-DD.");
  }
}

export function assertEventInBackfillRange(event: HealthKitSyncEvent, range: HealthKitBackfillRange): void {
  if (event.op === "delete") {
    // Delete entity keys encode the bucket/source; range is soft for deletes.
    return;
  }
  const payload = event.payload!;
  const rangeStartMs = Date.parse(range.rangeStartIso);
  const rangeEndMs = Date.parse(range.rangeEndIso);

  switch (payload.kind) {
    case "steps_hour": {
      const t = Date.parse(payload.hourStartUtc);
      if (t < rangeStartMs || t > rangeEndMs) {
        throw new HttpError(400, "payload_invalid", "steps hour is outside the backfill range.");
      }
      return;
    }
    case "sleep_day":
    case "daily_metric": {
      const day = payload.kind === "daily_metric" ? payload.localDay : payload.sleepDay;
      if (day < range.rangeStartDay || day > range.rangeEndDay) {
        throw new HttpError(400, "payload_invalid", "daily record is outside the backfill range.");
      }
      return;
    }
    case "blood_pressure":
    case "blood_glucose": {
      const t = Date.parse(payload.measuredAtUtc);
      if (t < rangeStartMs || t > rangeEndMs) {
        throw new HttpError(400, "payload_invalid", "reading is outside the backfill range.");
      }
      return;
    }
    case "workout": {
      const t = Date.parse(payload.startedAtUtc);
      if (t < rangeStartMs || t > rangeEndMs) {
        throw new HttpError(400, "payload_invalid", "workout is outside the backfill range.");
      }
      return;
    }
  }
}
