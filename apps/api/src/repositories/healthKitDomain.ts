import type {
  HealthKitConsentGroup,
  HealthKitMetric,
  HealthKitOpPayload,
  HealthKitRunKind,
  HealthKitSyncOp,
  HealthMetricSyncStatusCode,
  HealthWorkoutExerciseLog,
  HealthWorkoutExerciseWrite
} from "@family-os/shared";
import {
  BACKFILL_WINDOW_MS,
  HEALTHKIT_CONSENT_GROUPS,
  HEALTHKIT_METRIC_REGISTRY,
  HEALTHKIT_SYNC_OVERLAP_MS,
  groupForScopeKey,
  healthKitNaturalKey,
  isHealthKitMetricKey,
  isHealthKitProductGroup,
  requiredScopeKeysForGroup
} from "@family-os/shared";
import { HttpError } from "../errors";



export const HEALTHKIT_METRICS: readonly HealthKitMetric[] = HEALTHKIT_CONSENT_GROUPS;

export function assertSelfProfileMatch(input: {
  selfProfileId: string | undefined;
  requestedPersonId: string;
}): asserts input is { selfProfileId: string; requestedPersonId: string } {
  if (!input.selfProfileId) {
    throw new HttpError(409, "healthkit_self_profile_required", "Create your self profile before using HealthKit sync.");
  }
  if (input.selfProfileId !== input.requestedPersonId) {
    throw new HttpError(403, "profile_forbidden", "HealthKit writes can only target your linked Self profile.");
  }
}

export function normalizeWorkoutExercises(input: HealthWorkoutExerciseWrite[]): HealthWorkoutExerciseLog[] {
  if (input.length > 40) {
    throw new HttpError(400, "payload_invalid", "A workout can have at most 40 exercises.");
  }
  return input.map((exercise, index) => {
    const name = exercise.name.trim();
    if (name.length < 1 || name.length > 80) {
      throw new HttpError(400, "payload_invalid", `Exercise ${index + 1} name must be 1-80 characters.`);
    }
    if (exercise.sets.length < 1 || exercise.sets.length > 50) {
      throw new HttpError(400, "payload_invalid", `${name} must have 1-50 sets.`);
    }
    return {
      name,
      sets: exercise.sets.map((set, setIndex) => {
        if (!Number.isInteger(set.reps) || set.reps < 1 || set.reps > 1000) {
          throw new HttpError(400, "payload_invalid", `${name} set ${setIndex + 1} reps are invalid.`);
        }
        if (set.weightKg === undefined) {
          return { reps: set.reps };
        }
        if (!Number.isFinite(set.weightKg) || set.weightKg < 0 || set.weightKg > 1000) {
          throw new HttpError(400, "payload_invalid", `${name} set ${setIndex + 1} weight is invalid.`);
        }
        return { reps: set.reps, weightKg: Math.round(set.weightKg * 10) / 10 };
      })
    };
  });
}



export function isValidIanaTimezone(timezone: string): boolean {
  try {
    Intl.DateTimeFormat(undefined, { timeZone: timezone });
    return true;
  } catch {
    return false;
  }
}

/**
 * Completed-coverage comparison only (plan §8.5). Attempt status never clears
 * completeness: coverage moves solely on successful completion, so an
 * in-progress or interrupted run cannot make stored coverage look incomplete.
 */
export function coverageComplete(input: {
  coverageStartAt?: string;
  coverageEndAt?: string;
  rangeStart: string;
  rangeEnd: string;
}): boolean {
  if (!input.coverageStartAt || !input.coverageEndAt) {
    return false;
  }
  return Date.parse(input.coverageStartAt) <= Date.parse(input.rangeStart) && Date.parse(input.coverageEndAt) >= Date.parse(input.rangeEnd);
}

/**
 * A successful run adds proven data coverage; it must never make a previously
 * complete warehouse window look smaller. This is particularly important for
 * routine sync, whose overlap range is intentionally much narrower than the
 * initial history-import range.
 */
export function unionCompletedCoverage(input: {
  existingCoverageStartAt?: string | null;
  existingCoverageEndAt?: string | null;
  completedRangeStartAt: string;
  completedRangeEndAt: string;
}): { coverageStartAt: string; coverageEndAt: string } {
  const coverageStartAt =
    input.existingCoverageStartAt && Date.parse(input.existingCoverageStartAt) < Date.parse(input.completedRangeStartAt)
      ? input.existingCoverageStartAt
      : input.completedRangeStartAt;
  const coverageEndAt =
    input.existingCoverageEndAt && Date.parse(input.existingCoverageEndAt) > Date.parse(input.completedRangeEndAt)
      ? input.existingCoverageEndAt
      : input.completedRangeEndAt;
  return { coverageStartAt, coverageEndAt };
}

/**
 * needsInitialImport is true when no completed history marker matches the
 * active installation and current timezone version (plan §7.1). Never derived
 * from the attempt status label.
 */
export function deriveNeedsInitialImport(input: {
  historyImportCompletedAt?: string | null;
  historyImportInstallationId?: string | null;
  historyImportTimezoneVersion?: number | null;
  activeInstallationId?: string | null;
  healthTimezoneVersion: number;
}): boolean {
  if (!input.historyImportCompletedAt) return true;
  if (!input.activeInstallationId) return true;
  if (input.historyImportInstallationId !== input.activeInstallationId) return true;
  return Number(input.historyImportTimezoneVersion) !== Number(input.healthTimezoneVersion);
}

export type DerivedRunRange = {
  rangeStartAt: string;
  rangeEndAt: string;
  allowDeletes: boolean;
};

/**
 * Server-authoritative range + delete permission for a run kind (plan §7.2).
 * The server never trusts client-supplied ranges or deletion authority.
 */
export function deriveRunRange(input: {
  kind: HealthKitRunKind;
  group: HealthKitConsentGroup;
  lastSuccessfulAt?: string | null;
  now: Date;
}): DerivedRunRange {
  const rangeEndAt = toUtcIso(input.now);
  if (input.kind === "sync") {
    const anchor = input.lastSuccessfulAt ? Date.parse(input.lastSuccessfulAt) : input.now.getTime();
    const start = new Date(Math.min(anchor, input.now.getTime()) - HEALTHKIT_SYNC_OVERLAP_MS);
    return { rangeStartAt: toUtcIso(start), rangeEndAt, allowDeletes: false };
  }
  const rangeStartAt = toUtcIso(backfillRangeStart(input.group, input.now));
  return { rangeStartAt, rangeEndAt, allowDeletes: input.kind === "repair_import" };
}

/**
 * Begin-time state transition validation (plan §6.2/§7.2): initial import only
 * when history is incomplete; sync and repair only once it is complete. Repair
 * reconciliation exists only for the implemented product groups.
 */
export function assertRunKindAllowed(kind: HealthKitRunKind, group: HealthKitConsentGroup, needsInitialImport: boolean) {
  if (kind === "initial_import") {
    if (!needsInitialImport) {
      throw new HttpError(409, "run_kind_not_allowed", "Initial history import is already complete for this installation.");
    }
    return;
  }
  if (needsInitialImport) {
    throw new HttpError(409, "initial_import_required", "Complete Import history before running Sync or repair for this metric.");
  }
  if (kind === "repair_import" && !isHealthKitProductGroup(group)) {
    throw new HttpError(400, "run_kind_not_allowed", `Repair is not supported for group ${group}.`);
  }
}

const RUN_WINDOW_TOLERANCE_MS = 2 * 60 * 60 * 1000;

/**
 * Completion-time window validation (plan §7.4). The 90-day windows (initial,
 * repair) must be the bounded window derived at begin; deletion safety depends
 * on it. Sync windows are unbounded below (long gaps re-read more history) and
 * never delete, so only ordering and future-bounds are enforced.
 */
export function assertRunWindowShape(input: {
  kind: HealthKitRunKind;
  rangeStartAt: string;
  rangeEndAt: string;
  now: Date;
}) {
  const start = Date.parse(input.rangeStartAt);
  const end = Date.parse(input.rangeEndAt);
  if (Number.isNaN(start) || Number.isNaN(end)) {
    throw new HttpError(400, "payload_invalid", "Run range timestamps are invalid.");
  }
  if (end <= start) {
    throw new HttpError(400, "payload_invalid", "Run range end must be after range start.");
  }
  const nowMs = input.now.getTime();
  if (end > nowMs + RUN_WINDOW_TOLERANCE_MS) {
    throw new HttpError(400, "payload_invalid", "Run range cannot end in the future.");
  }
  if (input.kind === "sync") {
    return;
  }
  const duration = end - start;
  if (
    duration < BACKFILL_WINDOW_MS - RUN_WINDOW_TOLERANCE_MS ||
    duration > BACKFILL_WINDOW_MS + RUN_WINDOW_TOLERANCE_MS
  ) {
    throw new HttpError(400, "payload_invalid", "History import windows must span the 90-day import window.");
  }
  if (start < nowMs - BACKFILL_WINDOW_MS - RUN_WINDOW_TOLERANCE_MS) {
    throw new HttpError(400, "payload_invalid", "History import window cannot start before the 90-day window.");
  }
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
    throw new HttpError(400, "payload_invalid", "Backfill window must be at least one day.");
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
 * @deprecated Prefer data-first reads. MCP and history return stored rows regardless
 * of import status; consent is enforced at the route/service layer.
 * Always returns false (kept so older call sites compile during cleanup).
 */
export function shouldWithholdMetricRecords(_status: HealthMetricSyncStatusCode): boolean {
  return false;
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

export function assertOpCoherent(op: HealthKitSyncOp): void {
  if (!isHealthKitMetricKey(op.scopeKey)) {
    throw new HttpError(400, "payload_invalid", "scopeKey is not allowlisted.");
  }
  const expectedGroup = groupForScopeKey(op.scopeKey);
  if (expectedGroup !== op.group) {
    throw new HttpError(400, "payload_invalid", "group does not match scopeKey.");
  }

  if (op.op === "delete") {
    if (op.payload != null) {
      throw new HttpError(400, "payload_invalid", "delete ops must not include a payload.");
    }
    if (!op.naturalKey || op.naturalKey.length > 256) {
      throw new HttpError(400, "payload_invalid", "naturalKey is invalid.");
    }
    return;
  }

  if (!op.payload) {
    throw new HttpError(400, "payload_invalid", "upsert ops require a payload.");
  }
  assertPayloadValid(op.payload, op);
}

function assertPayloadValid(payload: HealthKitOpPayload, op: HealthKitSyncOp): void {
  const expectedKey = healthKitNaturalKey(payload);
  if (op.naturalKey !== expectedKey) {
    throw new HttpError(400, "payload_invalid", "naturalKey does not match payload.");
  }

  switch (payload.kind) {
    case "steps_hour": {
      if (op.scopeKey !== "steps") throw new HttpError(400, "payload_invalid", "steps payload scope mismatch.");
      assertUtcHourBoundary(payload.hourStartUtc);
      assertDateSanity(payload.hourStartUtc);
      if (!Number.isInteger(payload.count) || payload.count < 0 || payload.count > 200_000) {
        throw new HttpError(400, "payload_invalid", "steps count is invalid.");
      }
      return;
    }
    case "sleep_day": {
      if (op.scopeKey !== "sleep") throw new HttpError(400, "payload_invalid", "sleep payload scope mismatch.");
      assertYmd(payload.sleepDay);
      if (!Number.isInteger(payload.totalMinutes) || payload.totalMinutes < 0 || payload.totalMinutes > 24 * 60) {
        throw new HttpError(400, "payload_invalid", "total sleep minutes are invalid.");
      }
      const rawSourceFields = [
        payload.coreMinutes,
        payload.deepMinutes,
        payload.remMinutes,
        payload.unspecifiedAsleepMinutes,
        payload.awakeMinutes,
        payload.inBedMinutes
      ];
      for (const value of rawSourceFields) {
        if (!Number.isInteger(value) || value < 0 || value > 7 * 24 * 60) {
          throw new HttpError(400, "payload_invalid", "raw sleep source minutes are invalid.");
        }
      }
      const asleep =
        payload.coreMinutes + payload.deepMinutes + payload.remMinutes + payload.unspecifiedAsleepMinutes;
      if (payload.totalMinutes > asleep) {
        throw new HttpError(400, "payload_invalid", "totalMinutes cannot exceed the sleep stage total.");
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
      if (payload.healthMetric !== op.scopeKey) {
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
      if (definition.aggregation === "statistics" && payload.minimumValue! > payload.maximumValue!) {
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
      if (op.scopeKey !== "blood_pressure") throw new HttpError(400, "payload_invalid", "BP scope mismatch.");
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
      if (op.scopeKey !== "blood_glucose") throw new HttpError(400, "payload_invalid", "glucose scope mismatch.");
      assertDateSanity(payload.measuredAtUtc);
      if (payload.valueMgDl < 20 || payload.valueMgDl > 700) {
        throw new HttpError(400, "payload_invalid", "glucose value is out of range.");
      }
      if (payload.mealTime !== undefined && payload.mealTime !== "preprandial" && payload.mealTime !== "postprandial") {
        throw new HttpError(400, "payload_invalid", "glucose mealTime must be preprandial or postprandial.");
      }
      return;
    }
    case "workout": {
      if (op.scopeKey !== "workout") throw new HttpError(400, "payload_invalid", "workout scope mismatch.");
      assertDateSanity(payload.startedAtUtc);
      assertDateSanity(payload.endedAtUtc);
      const start = Date.parse(payload.startedAtUtc);
      const end = Date.parse(payload.endedAtUtc);
      if (end < start) {
        throw new HttpError(400, "payload_invalid", "workout end must be >= start.");
      }
      if (
        !Number.isInteger(payload.durationSeconds) ||
        payload.durationSeconds < 0 ||
        payload.durationSeconds > 7 * 24 * 60 * 60
      ) {
        throw new HttpError(400, "payload_invalid", "workout duration is invalid.");
      }
      if (
        payload.averageHeartRateBpm !== undefined &&
        payload.maximumHeartRateBpm !== undefined &&
        payload.averageHeartRateBpm > payload.maximumHeartRateBpm
      ) {
        throw new HttpError(400, "payload_invalid", "average heart rate must be <= maximum.");
      }
      if (
        payload.minimumHeartRateBpm !== undefined &&
        payload.averageHeartRateBpm !== undefined &&
        payload.minimumHeartRateBpm > payload.averageHeartRateBpm
      ) {
        throw new HttpError(400, "payload_invalid", "minimum heart rate must be <= average.");
      }
      if (payload.workoutType.trim().length < 1 || payload.workoutType.length > 100) {
        throw new HttpError(400, "payload_invalid", "workoutType is invalid.");
      }
      if (payload.events) {
        for (const event of payload.events) {
          assertDateSanity(event.dateUtc);
          if (event.endDateUtc) assertDateSanity(event.endDateUtc);
        }
      }
      if (payload.activities) {
        for (const segment of payload.activities) {
          assertDateSanity(segment.startedAtUtc);
          assertDateSanity(segment.endedAtUtc);
          if (Date.parse(segment.endedAtUtc) < Date.parse(segment.startedAtUtc)) {
            throw new HttpError(400, "payload_invalid", "activity segment end must be >= start.");
          }
        }
      }
      return;
    }
    default: {
      const _exhaustive: never = payload;
      throw new HttpError(400, "payload_invalid", `Unknown payload kind ${(_exhaustive as HealthKitOpPayload).kind}`);
    }
  }
}

function assertYmd(value: string) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    throw new HttpError(400, "payload_invalid", "Date must be YYYY-MM-DD.");
  }
}
