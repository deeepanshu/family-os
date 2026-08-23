import { zValidator } from "@hono/zod-validator";
import { Hono } from "hono";
import { z } from "zod";
import { WORKOUT_EXERCISE_CATALOG, type HealthDailyMetricRecord, type HealthStepDayRecord, type HealthWorkoutRecord } from "@family-os/shared";
import { requireAuth, type AppVariables } from "../auth";
import { HttpError } from "../errors";
import type { HealthKitStore } from "../repositories/contracts";
import {
  expandedUtcRangeForLocalDays,
  isDateInInclusiveRange,
  localDateRangeEndingToday,
  localDateString,
  resolveTimezone
} from "../mcp/timezone";

const workoutIdParam = z.object({ id: z.string().uuid() });

const workoutSetBody = z
  .object({
    reps: z.number().int().min(1).max(1000),
    weightKg: z.number().min(0).max(1000).optional()
  })
  .strict();

const workoutExercisesBody = z
  .object({
    exercises: z
      .array(
        z
          .object({
            exerciseId: z.string().uuid(),
            sets: z.array(workoutSetBody).min(1).max(50)
          })
          .strict()
      )
      .max(40)
  })
  .strict();

const catalogQuery = z.object({
  q: z.string().trim().max(80).optional(),
  category: z.string().trim().max(40).optional()
});



const ymd = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const query = z.object({
  personId: z.string().uuid().optional(),
  from: ymd.optional(),
  to: ymd.optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50)
});

async function resolveHistoryWindow(
  repository: HealthKitStore,
  userId: string,
  parsed: z.infer<typeof query>
) {
  const settings = await repository.getHealthKitSettings(userId, parsed.personId);
  let timezone = "UTC";
  try {
    timezone = resolveTimezone(settings.healthTimezone);
  } catch {
    timezone = "UTC";
  }
  let { rangeStart, rangeEnd } = localDateRangeEndingToday(90, timezone);
  if (parsed.from) rangeStart = parsed.from;
  if (parsed.to) rangeEnd = parsed.to;
  if (rangeStart > rangeEnd) {
    throw new HttpError(400, "invalid_range", "from must be on or before to.");
  }
  return { personId: settings.personId, timezone, rangeStart, rangeEnd };
}

export function aggregateStepDays(
  hours: Array<{ hourStartUtc: string; count: number }>,
  timezone: string,
  rangeStart: string,
  rangeEnd: string
): HealthStepDayRecord[] {
  const sums = new Map<string, number>();
  for (const row of hours) {
    const localDay = localDateString(new Date(row.hourStartUtc), timezone);
    if (!isDateInInclusiveRange(localDay, rangeStart, rangeEnd)) continue;
    sums.set(localDay, (sums.get(localDay) ?? 0) + row.count);
  }
  return [...sums.entries()]
    .sort((a, b) => b[0].localeCompare(a[0]))
    .map(([localDay, count]) => ({ localDay, count }));
}

function workoutsInLocalRange(
  rows: HealthWorkoutRecord[],
  timezone: string,
  rangeStart: string,
  rangeEnd: string,
  limit: number
): HealthWorkoutRecord[] {
  return rows
    .filter((workout) =>
      isDateInInclusiveRange(localDateString(new Date(workout.startedAtUtc), timezone), rangeStart, rangeEnd)
    )
    .sort((a, b) => Date.parse(b.startedAtUtc) - Date.parse(a.startedAtUtc))
    .slice(0, limit);
}

export function createSleepRoutes(repository: HealthKitStore) {
  const routes = new Hono<{ Variables: AppVariables }>();
  routes.use("*", requireAuth());
  routes.get("/", zValidator("query", query), async (c) => {
    const parsed = c.req.valid("query");
    const window = await resolveHistoryWindow(repository, c.get("user").id, parsed);
    const days = await repository.listSleepDays(
      c.get("user").id,
      window.personId,
      window.rangeStart,
      window.rangeEnd
    );
    return c.json({ data: [...days].sort((a, b) => b.sleepDay.localeCompare(a.sleepDay)) });
  });
  return routes;
}

export function createStepsRoutes(repository: HealthKitStore) {
  const routes = new Hono<{ Variables: AppVariables }>();
  routes.use("*", requireAuth());
  routes.get("/", zValidator("query", query), async (c) => {
    const parsed = c.req.valid("query");
    const window = await resolveHistoryWindow(repository, c.get("user").id, parsed);
    const { start, end } = expandedUtcRangeForLocalDays(window.rangeStart, window.rangeEnd);
    const hours = await repository.listStepHours(c.get("user").id, window.personId, start, end);
    return c.json({
      data: aggregateStepDays(hours, window.timezone, window.rangeStart, window.rangeEnd)
    });
  });
  return routes;
}

export function createHeartRateRoutes(repository: HealthKitStore) {
  const routes = new Hono<{ Variables: AppVariables }>();
  routes.use("*", requireAuth());
  routes.get("/", zValidator("query", query), async (c) => {
    const parsed = c.req.valid("query");
    const window = await resolveHistoryWindow(repository, c.get("user").id, parsed);
    const days = await repository.listDailyMetrics(
      c.get("user").id,
      window.personId,
      "heart_rate",
      window.rangeStart,
      window.rangeEnd
    );
    return c.json({
      data: [...days].sort((a: HealthDailyMetricRecord, b: HealthDailyMetricRecord) =>
        b.localDay.localeCompare(a.localDay)
      )
    });
  });
  return routes;
}

export function createWorkoutRoutes(repository: HealthKitStore) {
  const routes = new Hono<{ Variables: AppVariables }>();
  routes.use("*", requireAuth());
  routes.get("/exercises", zValidator("query", catalogQuery), async (c) => {
    const parsed = c.req.valid("query");
    const needle = parsed.q?.toLowerCase();
    const category = parsed.category;
    const data = WORKOUT_EXERCISE_CATALOG.filter((entry) => {
      if (category && entry.category !== category) return false;
      if (needle && !entry.name.toLowerCase().includes(needle)) return false;
      return true;
    });
    return c.json({ data });
  });
  routes.get("/", zValidator("query", query), async (c) => {
    const parsed = c.req.valid("query");
    const window = await resolveHistoryWindow(repository, c.get("user").id, parsed);
    const { start, end } = expandedUtcRangeForLocalDays(window.rangeStart, window.rangeEnd);
    const rows = await repository.listHealthKitWorkouts(
      c.get("user").id,
      window.personId,
      start,
      end,
      Math.max(parsed.limit * 4, 200)
    );
    return c.json({
      data: workoutsInLocalRange(rows, window.timezone, window.rangeStart, window.rangeEnd, parsed.limit)
    });
  });
  routes.put(
    "/:id/exercises",
    zValidator("param", workoutIdParam),
    zValidator("json", workoutExercisesBody),
    async (c) => {
      const data = await repository.putHealthKitWorkoutExercises(
        c.get("user").id,
        c.req.valid("param").id,
        c.req.valid("json").exercises
      );
      return c.json({ data });
    }
  );
  return routes;
}
