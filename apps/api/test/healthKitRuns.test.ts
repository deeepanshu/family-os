import { SignJWT } from "jose";
import { describe, expect, it } from "vitest";
import { HEALTH_API_PREFIX, bloodPressureNaturalKey } from "@family-os/shared";
import { createApp } from "../src/app";
import { HealthMcpReadService } from "../src/mcp/HealthMcpReadService";
import { repositoriesFromFamilyRepository } from "../src/dependencies";
import { InMemoryFamilyRepository } from "../src/repositories/families";
import {
  beginRun,
  bloodPressureOp,
  completeRun,
  failRun,
  postOps,
  seedHealthKitReadyGroup,
  sleepDayOp
} from "./healthKitTestHelpers";
import { setupSoloUser } from "./soloSetup";

const jwtSecret = "test-supabase-jwt-secret-with-enough-length";
const supabaseUrl = "https://project.supabase.co";
const userId = "00000000-0000-4000-8000-000000004001";
const installationId = "53064303-35cf-4db0-a5d3-8af7d8f747e1";
const otherInstallationId = "63064303-35cf-4db0-a5d3-8af7d8f747e2";
const oauthClientId = "chatgpt-staging";

const DAY_MS = 24 * 60 * 60 * 1000;

function app(repo = new InMemoryFamilyRepository()) {
  return {
    api: createApp({
      config: {
        NODE_ENV: "test",
        PORT: 3001,
        HEALTH_API_ENABLE_DEV_AUTH: false,
        SUPABASE_JWT_SECRET: jwtSecret,
        SUPABASE_URL: supabaseUrl
      },
      familyRepository: repo
    }),
    repo
  };
}

async function jwtFor(subject: string) {
  return new SignJWT({ role: "authenticated", email: `${subject}@example.com` })
    .setProtectedHeader({ alg: "HS256" })
    .setSubject(subject)
    .setIssuer(`${supabaseUrl}/auth/v1`)
    .setAudience("authenticated")
    .setIssuedAt()
    .setExpirationTime("1h")
    .sign(new TextEncoder().encode(jwtSecret));
}

async function setup(api: ReturnType<typeof createApp>) {
  const token = await jwtFor(userId);
  const { profileId } = await setupSoloUser(api, token);
  return { token, profileId };
}

function putSettings(
  api: ReturnType<typeof createApp>,
  token: string,
  profileId: string,
  overrides: Record<string, unknown> = {}
) {
  return api.request(`${HEALTH_API_PREFIX}/healthkit/settings`, {
    method: "PUT",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify({
      personId: profileId,
      consentVersion: "2026-07-25",
      enabledGroups: ["vitals", "sleep", "workouts"],
      healthTimezone: "UTC",
      installationId,
      ...overrides
    })
  });
}

async function getSettings(api: ReturnType<typeof createApp>, token: string) {
  const res = await api.request(`${HEALTH_API_PREFIX}/healthkit/settings`, {
    headers: { authorization: `Bearer ${token}` }
  });
  expect(res.status).toBe(200);
  return (await res.json()).data;
}

async function listBpReadingIds(api: ReturnType<typeof createApp>, token: string, profileId: string) {
  const res = await api.request(`${HEALTH_API_PREFIX}/readings/blood-pressure?personId=${profileId}`, {
    headers: { authorization: `Bearer ${token}` }
  });
  expect(res.status).toBe(200);
  const body = await res.json();
  return body.data.map((r: { id: string }) => r.id) as string[];
}

function isoDaysAgo(days: number) {
  return new Date(Date.now() - days * DAY_MS).toISOString();
}

function dayDaysAgo(days: number) {
  return isoDaysAgo(days).slice(0, 10);
}

describe("HealthKit run lifecycle", () => {
  it("initial import begin returns the 90-day range with allowDeletes=false", async () => {
    const { api } = app();
    const { token, profileId } = await setup(api);
    await putSettings(api, token, profileId);

    const res = await beginRun(api, token, profileId, installationId, "vitals", "initial_import");
    expect(res.status).toBe(200);
    const data = (await res.json()).data;
    expect(data.kind).toBe("initial_import");
    expect(data.allowDeletes).toBe(false);
    const duration = Date.parse(data.rangeEndAt) - Date.parse(data.rangeStartAt);
    expect(duration).toBeGreaterThan(89 * DAY_MS);
    expect(duration).toBeLessThanOrEqual(90 * DAY_MS + 60_000);
  });

  it("rejects sync and repair before initial completion, and initial after completion", async () => {
    const { api } = app();
    const { token, profileId } = await setup(api);
    await putSettings(api, token, profileId);

    const sync = await beginRun(api, token, profileId, installationId, "vitals", "sync");
    expect(sync.status).toBe(409);
    expect((await sync.json()).error.code).toBe("initial_import_required");

    const repair = await beginRun(api, token, profileId, installationId, "vitals", "repair_import");
    expect(repair.status).toBe(409);
    expect((await repair.json()).error.code).toBe("initial_import_required");

    await seedHealthKitReadyGroup(api, token, profileId, installationId, "vitals", []);

    const initialAgain = await beginRun(api, token, profileId, installationId, "vitals", "initial_import");
    expect(initialAgain.status).toBe(409);
    expect((await initialAgain.json()).error.code).toBe("run_kind_not_allowed");
  });

  it("sync after initial completion uses last success minus 24 hours and never deletes", async () => {
    const { api } = app();
    const { token, profileId } = await setup(api);
    await putSettings(api, token, profileId);
    await seedHealthKitReadyGroup(api, token, profileId, installationId, "vitals", [
      bloodPressureOp({ measuredAtUtc: isoDaysAgo(10), systolic: 120, diastolic: 80 })
    ]);

    const settings = await getSettings(api, token);
    const vitals = settings.groups.find((g: { group: string }) => g.group === "vitals");
    const lastSuccess = Date.parse(vitals.lastSuccessfulAt);

    const begin = await beginRun(api, token, profileId, installationId, "vitals", "sync");
    expect(begin.status).toBe(200);
    const descriptor = (await begin.json()).data;
    expect(descriptor.allowDeletes).toBe(false);
    const rangeStart = Date.parse(descriptor.rangeStartAt);
    expect(Math.abs(rangeStart - (lastSuccess - DAY_MS))).toBeLessThan(60_000);

    // A snapshot manifest on a non-repair completion is rejected outright.
    const withManifest = await completeRun(api, token, profileId, installationId, "vitals", {
      kind: "sync",
      rangeStartAt: descriptor.rangeStartAt,
      rangeEndAt: descriptor.rangeEndAt,
      completeSnapshot: true,
      presentNaturalKeys: []
    });
    expect(withManifest.status).toBe(400);

    const complete = await completeRun(api, token, profileId, installationId, "vitals", {
      kind: "sync",
      rangeStartAt: descriptor.rangeStartAt,
      rangeEndAt: descriptor.rangeEndAt
    });
    expect(complete.status).toBe(200);
    const done = (await complete.json()).data;
    expect(done.deletedCount).toBe(0);
    expect(done.needsInitialImport).toBe(false);

    // Sync deleted nothing.
    expect((await listBpReadingIds(api, token, profileId)).length).toBe(1);
  });

  it("sync completion preserves completed coverage and returns the unioned window", async () => {
    const { api } = app();
    const { token, profileId } = await setup(api);
    await putSettings(api, token, profileId);
    await seedHealthKitReadyGroup(api, token, profileId, installationId, "vitals", []);

    const before = (await getSettings(api, token)).groups.find((g: { group: string }) => g.group === "vitals");
    const begin = await beginRun(api, token, profileId, installationId, "vitals", "sync");
    expect(begin.status).toBe(200);
    const descriptor = (await begin.json()).data;

    const complete = await completeRun(api, token, profileId, installationId, "vitals", {
      kind: "sync",
      rangeStartAt: descriptor.rangeStartAt,
      rangeEndAt: descriptor.rangeEndAt
    });
    expect(complete.status).toBe(200);
    const done = (await complete.json()).data;

    expect(done.coverageStartAt).toBe(before.coverageStartAt);
    expect(Date.parse(done.coverageEndAt)).toBeGreaterThanOrEqual(Date.parse(before.coverageEndAt));

    const after = (await getSettings(api, token)).groups.find((g: { group: string }) => g.group === "vitals");
    expect(after.coverageStartAt).toBe(before.coverageStartAt);
    expect(after.coverageEndAt).toBe(done.coverageEndAt);
  });

  it("unchanged settings saves preserve history markers in the memory store", async () => {
    const { api } = app();
    const { token, profileId } = await setup(api);
    await putSettings(api, token, profileId);
    await seedHealthKitReadyGroup(api, token, profileId, installationId, "sleep", []);

    const savedAgain = await putSettings(api, token, profileId);
    expect(savedAgain.status).toBe(200);
    const sleep = (await savedAgain.json()).data.groups.find((g: { group: string }) => g.group === "sleep");
    expect(sleep.needsInitialImport).toBe(false);
    expect(sleep.historyImportCompletedAt).toBeTruthy();

    const sync = await beginRun(api, token, profileId, installationId, "sleep", "sync");
    expect(sync.status).toBe(200);
  });

  it("begin records the attempt without moving completed coverage or last success", async () => {
    const { api } = app();
    const { token, profileId } = await setup(api);
    await putSettings(api, token, profileId);
    await seedHealthKitReadyGroup(api, token, profileId, installationId, "vitals", []);

    const before = (await getSettings(api, token)).groups.find((g: { group: string }) => g.group === "vitals");

    const begin = await beginRun(api, token, profileId, installationId, "vitals", "sync");
    expect(begin.status).toBe(200);

    const after = (await getSettings(api, token)).groups.find((g: { group: string }) => g.group === "vitals");
    expect(after.status).toBe("syncing");
    expect(after.coverageStartAt).toBe(before.coverageStartAt);
    expect(after.coverageEndAt).toBe(before.coverageEndAt);
    expect(after.lastSuccessfulAt).toBe(before.lastSuccessfulAt);
    expect(after.needsInitialImport).toBe(false);
  });

  it("successful completion updates readiness, last success, and completed coverage", async () => {
    const { api } = app();
    const { token, profileId } = await setup(api);
    await putSettings(api, token, profileId);

    const begin = await beginRun(api, token, profileId, installationId, "sleep", "initial_import");
    const descriptor = (await begin.json()).data;
    const complete = await completeRun(api, token, profileId, installationId, "sleep", {
      kind: "initial_import",
      rangeStartAt: descriptor.rangeStartAt,
      rangeEndAt: descriptor.rangeEndAt
    });
    expect(complete.status).toBe(200);

    const sleep = (await getSettings(api, token)).groups.find((g: { group: string }) => g.group === "sleep");
    expect(sleep.status).toBe("ready");
    expect(sleep.lastSuccessfulAt).toBeTruthy();
    expect(sleep.coverageStartAt).toBe(descriptor.rangeStartAt);
    expect(sleep.coverageEndAt).toBe(descriptor.rangeEndAt);
    expect(sleep.needsInitialImport).toBe(false);
    expect(sleep.historyImportCompletedAt).toBeTruthy();
  });

  it("repair completion removes only absent keys inside its exact window", async () => {
    const { api } = app();
    const { token, profileId } = await setup(api);
    await putSettings(api, token, profileId);

    const keepInWindow = crypto.randomUUID();
    const deleteInWindow = crypto.randomUUID();
    const keepOutOfWindow = crypto.randomUUID();
    await seedHealthKitReadyGroup(api, token, profileId, installationId, "vitals", [
      bloodPressureOp({ sourceObjectKey: keepInWindow, measuredAtUtc: isoDaysAgo(10), systolic: 120, diastolic: 80 }),
      bloodPressureOp({ sourceObjectKey: deleteInWindow, measuredAtUtc: isoDaysAgo(20), systolic: 130, diastolic: 85 }),
      bloodPressureOp({ sourceObjectKey: keepOutOfWindow, measuredAtUtc: isoDaysAgo(100), systolic: 140, diastolic: 90 })
    ]);

    const begin = await beginRun(api, token, profileId, installationId, "vitals", "repair_import");
    expect(begin.status).toBe(200);
    const descriptor = (await begin.json()).data;
    expect(descriptor.allowDeletes).toBe(true);
    const duration = Date.parse(descriptor.rangeEndAt) - Date.parse(descriptor.rangeStartAt);
    expect(duration).toBeGreaterThan(89 * DAY_MS);

    // Repair upload re-upserts the still-present in-window record.
    const reupload = await postOps(api, token, profileId, installationId, [
      bloodPressureOp({ sourceObjectKey: keepInWindow, measuredAtUtc: isoDaysAgo(10), systolic: 121, diastolic: 81 })
    ]);
    expect(reupload.status).toBe(200);

    const complete = await completeRun(api, token, profileId, installationId, "vitals", {
      kind: "repair_import",
      rangeStartAt: descriptor.rangeStartAt,
      rangeEndAt: descriptor.rangeEndAt,
      completeSnapshot: true,
      presentNaturalKeys: [bloodPressureNaturalKey(keepInWindow)]
    });
    expect(complete.status).toBe(200);
    const done = (await complete.json()).data;
    expect(done.deletedCount).toBe(1);

    const ids = await listBpReadingIds(api, token, profileId);
    expect(ids).toContain(keepInWindow);
    expect(ids).not.toContain(deleteInWindow);
    // Absent from the manifest but outside the window: untouched.
    expect(ids).toContain(keepOutOfWindow);
  });

  it("treats an empty repair manifest as a legitimately empty snapshot", async () => {
    const { api } = app();
    const { token, profileId } = await setup(api);
    await putSettings(api, token, profileId);

    const inWindow = crypto.randomUUID();
    const outOfWindow = crypto.randomUUID();
    await seedHealthKitReadyGroup(api, token, profileId, installationId, "vitals", [
      bloodPressureOp({ sourceObjectKey: inWindow, measuredAtUtc: isoDaysAgo(5), systolic: 120, diastolic: 80 }),
      bloodPressureOp({ sourceObjectKey: outOfWindow, measuredAtUtc: isoDaysAgo(95), systolic: 125, diastolic: 82 })
    ]);

    const begin = await beginRun(api, token, profileId, installationId, "vitals", "repair_import");
    const descriptor = (await begin.json()).data;
    const complete = await completeRun(api, token, profileId, installationId, "vitals", {
      kind: "repair_import",
      rangeStartAt: descriptor.rangeStartAt,
      rangeEndAt: descriptor.rangeEndAt,
      completeSnapshot: true,
      presentNaturalKeys: []
    });
    expect(complete.status).toBe(200);
    expect((await complete.json()).data.deletedCount).toBe(1);

    const ids = await listBpReadingIds(api, token, profileId);
    expect(ids).not.toContain(inWindow);
    expect(ids).toContain(outOfWindow);
  });

  it("deletes nothing when the app disappears before repair completion", async () => {
    const { api } = app();
    const { token, profileId } = await setup(api);
    await putSettings(api, token, profileId);

    const existing = crypto.randomUUID();
    await seedHealthKitReadyGroup(api, token, profileId, installationId, "vitals", [
      bloodPressureOp({ sourceObjectKey: existing, measuredAtUtc: isoDaysAgo(3), systolic: 118, diastolic: 76 })
    ]);

    const begin = await beginRun(api, token, profileId, installationId, "vitals", "repair_import");
    expect(begin.status).toBe(200);
    // App exits here: no completion request arrives.

    const ids = await listBpReadingIds(api, token, profileId);
    expect(ids).toContain(existing);

    // The interrupted attempt leaves the stale attempt state but intact coverage.
    const vitals = (await getSettings(api, token)).groups.find((g: { group: string }) => g.group === "vitals");
    expect(vitals.status).toBe("syncing");
    expect(vitals.needsInitialImport).toBe(false);
  });

  it("fail restores ready after a leftover syncing attempt without moving coverage", async () => {
    const { api } = app();
    const { token, profileId } = await setup(api);
    await putSettings(api, token, profileId);
    await seedHealthKitReadyGroup(api, token, profileId, installationId, "vitals", []);

    const before = (await getSettings(api, token)).groups.find((g: { group: string }) => g.group === "vitals");
    const begin = await beginRun(api, token, profileId, installationId, "vitals", "sync");
    expect(begin.status).toBe(200);
    expect((await getSettings(api, token)).groups.find((g: { group: string }) => g.group === "vitals").status).toBe(
      "syncing"
    );

    const failed = await failRun(api, token, profileId, installationId, "vitals", "sync", "sync_timeout");
    expect(failed.status).toBe(200);
    const body = (await failed.json()).data;
    expect(body.status).toBe("ready");
    expect(body.lastErrorCode).toBe("sync_timeout");
    expect(body.needsInitialImport).toBe(false);

    const after = (await getSettings(api, token)).groups.find((g: { group: string }) => g.group === "vitals");
    expect(after.status).toBe("ready");
    expect(after.lastSuccessfulAt).toBe(before.lastSuccessfulAt);
    expect(after.coverageStartAt).toBe(before.coverageStartAt);
    expect(after.coverageEndAt).toBe(before.coverageEndAt);
    expect(after.lastErrorCode).toBe("sync_timeout");
  });

  it("fail without a prior success records error and keeps import required", async () => {
    const { api } = app();
    const { token, profileId } = await setup(api);
    await putSettings(api, token, profileId);

    const begin = await beginRun(api, token, profileId, installationId, "sleep", "initial_import");
    expect(begin.status).toBe(200);

    const failed = await failRun(api, token, profileId, installationId, "sleep", "initial_import", "sync_timeout");
    expect(failed.status).toBe(200);
    const body = (await failed.json()).data;
    expect(body.status).toBe("error");
    expect(body.needsInitialImport).toBe(true);

    const sleep = (await getSettings(api, token)).groups.find((g: { group: string }) => g.group === "sleep");
    expect(sleep.status).toBe("error");
    expect(sleep.needsInitialImport).toBe(true);
    expect(sleep.lastErrorCode).toBe("sync_timeout");
  });

  it("replayed completion is idempotent", async () => {
    const { api } = app();
    const { token, profileId } = await setup(api);
    await putSettings(api, token, profileId);

    const keep = crypto.randomUUID();
    const drop = crypto.randomUUID();
    await seedHealthKitReadyGroup(api, token, profileId, installationId, "vitals", [
      bloodPressureOp({ sourceObjectKey: keep, measuredAtUtc: isoDaysAgo(2), systolic: 120, diastolic: 80 }),
      bloodPressureOp({ sourceObjectKey: drop, measuredAtUtc: isoDaysAgo(2), systolic: 130, diastolic: 85 })
    ]);

    const begin = await beginRun(api, token, profileId, installationId, "vitals", "repair_import");
    const descriptor = (await begin.json()).data;
    const body = {
      kind: "repair_import",
      rangeStartAt: descriptor.rangeStartAt,
      rangeEndAt: descriptor.rangeEndAt,
      completeSnapshot: true,
      presentNaturalKeys: [bloodPressureNaturalKey(keep)]
    };

    const first = await completeRun(api, token, profileId, installationId, "vitals", body);
    expect(first.status).toBe(200);
    expect((await first.json()).data.deletedCount).toBe(1);

    const second = await completeRun(api, token, profileId, installationId, "vitals", body);
    expect(second.status).toBe(200);
    expect((await second.json()).data.deletedCount).toBe(0);

    const ids = await listBpReadingIds(api, token, profileId);
    expect(ids).toEqual([keep]);
  });

  it("initial import with an empty upload deletes nothing", async () => {
    const { api } = app();
    const { token, profileId } = await setup(api);
    await putSettings(api, token, profileId);

    const existing = crypto.randomUUID();
    await seedHealthKitReadyGroup(api, token, profileId, installationId, "vitals", [
      bloodPressureOp({ sourceObjectKey: existing, measuredAtUtc: isoDaysAgo(7), systolic: 119, diastolic: 79 })
    ]);

    // Installation replacement invalidates the marker and allows a fresh initial import.
    const replaced = await putSettings(api, token, profileId, {
      installationId: otherInstallationId,
      replaceActiveInstallation: true
    });
    expect(replaced.status).toBe(200);

    const begin = await beginRun(api, token, profileId, otherInstallationId, "vitals", "initial_import");
    const descriptor = (await begin.json()).data;
    const complete = await completeRun(api, token, profileId, otherInstallationId, "vitals", {
      kind: "initial_import",
      rangeStartAt: descriptor.rangeStartAt,
      rangeEndAt: descriptor.rangeEndAt
    });
    expect(complete.status).toBe(200);
    expect((await complete.json()).data.deletedCount).toBe(0);

    expect(await listBpReadingIds(api, token, profileId)).toContain(existing);
  });

  it("repair completion rejects windows that are not the 90-day repair window", async () => {
    const { api } = app();
    const { token, profileId } = await setup(api);
    await putSettings(api, token, profileId);
    await seedHealthKitReadyGroup(api, token, profileId, installationId, "vitals", []);

    const complete = await completeRun(api, token, profileId, installationId, "vitals", {
      kind: "repair_import",
      rangeStartAt: isoDaysAgo(30),
      rangeEndAt: new Date().toISOString(),
      completeSnapshot: true,
      presentNaturalKeys: []
    });
    expect(complete.status).toBe(400);
    expect((await complete.json()).error.code).toBe("payload_invalid");
  });

  it("timezone change invalidates history completion and requires a new initial import", async () => {
    const { api } = app();
    const { token, profileId } = await setup(api);
    await putSettings(api, token, profileId);
    await seedHealthKitReadyGroup(api, token, profileId, installationId, "sleep", [sleepDayOp(dayDaysAgo(2))]);

    const changed = await putSettings(api, token, profileId, { healthTimezone: "Asia/Bangkok" });
    expect(changed.status).toBe(200);
    const sleep = (await changed.json()).data.groups.find((g: { group: string }) => g.group === "sleep");
    expect(sleep.needsInitialImport).toBe(true);
    expect(sleep.status).toBe("never_synced");

    const sync = await beginRun(api, token, profileId, installationId, "sleep", "sync", 2);
    expect(sync.status).toBe(409);
    expect((await sync.json()).error.code).toBe("initial_import_required");

    const initial = await beginRun(api, token, profileId, installationId, "sleep", "initial_import", 2);
    expect(initial.status).toBe(200);
  });

  it("repair reconciliation removes absent sleep days only inside the window", async () => {
    const { api, repo } = app();
    const { token, profileId } = await setup(api);
    await putSettings(api, token, profileId);

    const keepDay = dayDaysAgo(4);
    const dropDay = dayDaysAgo(30);
    const outsideDay = dayDaysAgo(100);
    await seedHealthKitReadyGroup(api, token, profileId, installationId, "sleep", [
      sleepDayOp(keepDay),
      sleepDayOp(dropDay),
      sleepDayOp(outsideDay)
    ]);

    const begin = await beginRun(api, token, profileId, installationId, "sleep", "repair_import");
    const descriptor = (await begin.json()).data;
    const complete = await completeRun(api, token, profileId, installationId, "sleep", {
      kind: "repair_import",
      rangeStartAt: descriptor.rangeStartAt,
      rangeEndAt: descriptor.rangeEndAt,
      completeSnapshot: true,
      presentNaturalKeys: [`sleep_day:${keepDay}`]
    });
    expect(complete.status).toBe(200);
    expect((await complete.json()).data.deletedCount).toBe(1);

    const repositories = repositoriesFromFamilyRepository(repo);
    await repositories.mcpConnections.createConnection({
      userId,
      oauthClientId,
      capabilities: ["health_read"],
      consentVersion: "2026-07-25"
    });
    const service = new HealthMcpReadService({ ...repositories });
    const sleep = await service.getHealthData(
      { userId, oauthClientId },
      { personId: profileId, healthMetric: "sleep", rangeDays: 90, timezone: "UTC" }
    );
    if (sleep.viewType !== "daily_duration_series") throw new Error("expected sleep series");
    const days = sleep.points.map((p) => p.bucket);
    expect(days).toContain(keepDay);
    expect(days).not.toContain(dropDay);

    // Outside the 90-day repair window: untouched even though absent from the manifest.
    const stored = await repositories.healthKit.listSleepDays(userId, profileId, outsideDay, outsideDay);
    expect(stored.map((row) => row.sleepDay)).toEqual([outsideDay]);
  });
});
