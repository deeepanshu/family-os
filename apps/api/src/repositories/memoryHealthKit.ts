/**
 * In-memory HealthKit event/session engine used by unit tests.
 * Mirrors PostgresHealthKitStore apply rules without SQL.
 */
import type {
  AbortHealthKitBackfillSessionInput,
  BloodGlucoseReading,
  BloodPressureReading,
  CompleteHealthKitBackfillSessionInput,
  CreateHealthKitBackfillSessionInput,
  HealthDailyMetricRecord,
  HealthKitBackfillSession,
  HealthKitBackfillSessionAbortResult,
  HealthKitBackfillSessionCompleteResult,
  HealthKitEventApplyResult,
  HealthKitEventsBatchInput,
  HealthKitEventsBatchResult,
  HealthKitGroupManifest,
  HealthKitMetric,
  HealthKitMetricKey,
  HealthKitScopeManifestResult,
  HealthKitSettings,
  HealthKitSyncEvent,
  HealthMetricFreshness,
  HealthMetricSyncStatusCode,
  HealthSleepDayRecord,
  HealthStepHourRecord,
  HealthWorkoutRecord,
  PutHealthKitScopeManifestInput,
  PutHealthKitSettingsInput
} from "@family-os/shared";
import {
  BACKFILL_SESSION_TTL_MS,
  HEALTHKIT_METRIC_REGISTRY,
  fingerprintHealthEvent,
  fingerprintScopeManifest,
  requiredScopeKeysForGroup
} from "@family-os/shared";
import { createHash } from "node:crypto";
import { HttpError } from "../errors";
import { localDateString } from "../mcp/timezone";
import {
  assertEventCoherent,
  assertEventInBackfillRange,
  assertSelfProfileMatch,
  backfillRangeStart,
  HEALTHKIT_METRICS,
  profileLocalDayRange,
  toUtcIso,
  type HealthKitBackfillRange
} from "./healthKitDomain";

function nodeSha256(data: Uint8Array): Uint8Array {
  return createHash("sha256").update(data).digest();
}

type FamilyCtx = {
  family: { id: string };
};

export type MemoryHealthKitHost = {
  requireActiveMember(userId: string): FamilyCtx;
  getSelfProfile(userId: string): Promise<{ id: string } | null>;
  audit(input: {
    familyId: string;
    actorUserId?: string;
    action: string;
    resourceType: string;
    resourceId: string;
    metadata?: Record<string, unknown>;
  }): void;
  bloodPressureReadings: Map<
    string,
    BloodPressureReading & { deletedAt?: string; sourceSampleKey?: string }
  >;
};

type SessionRow = HealthKitBackfillSession & {
  familyId: string;
  completedAt?: string;
  abortedAt?: string;
  abortReason?: string;
};

export class MemoryHealthKitEngine {
  private readonly profileSettings = new Map<
    string,
    {
      personId: string;
      familyId: string;
      userId: string;
      consentVersion?: string;
      consentedAt?: string;
      healthTimezone: string;
      healthTimezoneVersion: number;
    }
  >();
  private readonly groupEnabled = new Map<string, boolean>();
  private readonly syncState = new Map<
    string,
    {
      personId: string;
      familyId: string;
      group: HealthKitMetric;
      lastSuccessfulAt?: string;
      lastAttemptAt?: string;
      lastErrorCode?: string;
      coverageStartAt?: string;
      coverageEndAt?: string;
      status: HealthMetricSyncStatusCode;
    }
  >();
  private readonly installations = new Map<
    string,
    { personId: string; familyId: string; installationId: string; activatedAt: string; revokedAt?: string }
  >();
  readonly stepHours = new Map<string, HealthStepHourRecord & { familyId: string }>();
  readonly sleepDays = new Map<string, HealthSleepDayRecord & { familyId: string }>();
  readonly dailyMetrics = new Map<
    string,
    {
      familyId: string;
      personId: string;
      healthMetric: string;
      localDay: string;
      timezoneVersion: number;
      sumValue?: number;
      averageValue?: number;
      minimumValue?: number;
      maximumValue?: number;
      latestValue?: number;
      sampleCount: number;
    }
  >();
  readonly glucose = new Map<
    string,
    { personId: string; sourceSampleKey: string; measuredAtUtc: string; valueMgDl: number }
  >();
  readonly workouts = new Map<
    string,
    {
      personId: string;
      sourceSampleKey: string;
      workoutType: string;
      startedAtUtc: string;
      endedAtUtc: string;
      durationSeconds: number;
      activeEnergyKcal?: number;
      distanceMeters?: number;
      averageHeartRateBpm?: number;
      maximumHeartRateBpm?: number;
    }
  >();
  private readonly events = new Map<
    string,
    {
      eventId: string;
      personId: string;
      installationId: string;
      entityKey: string;
      entityVersion: number;
      group: HealthKitMetric;
      scopeKey: string;
      op: "upsert" | "delete";
      sessionId?: string | null;
      fingerprint: string;
      applyResult: "applied" | "superseded" | "duplicate";
    }
  >();
  private readonly entities = new Map<
    string,
    {
      personId: string;
      installationId: string;
      entityKey: string;
      entityVersion: number;
      fingerprint: string;
      op: "upsert" | "delete";
      lastEventId: string;
    }
  >();
  private readonly sessions = new Map<string, SessionRow>();
  private readonly manifests = new Map<string, { sessionId: string; scopeKey: string; eventCount: number; manifestHash: string }>();

  constructor(private readonly host: MemoryHealthKitHost) {}

  async getHealthKitSettings(actorUserId: string, personId?: string): Promise<HealthKitSettings> {
    const current = this.host.requireActiveMember(actorUserId);
    const selfProfile = await this.host.getSelfProfile(actorUserId);
    if (!selfProfile) {
      throw new HttpError(409, "healthkit_self_profile_required", "Create your self profile before using HealthKit sync.");
    }
    const targetPersonId = personId ?? selfProfile.id;
    assertSelfProfileMatch({ selfProfileId: selfProfile.id, requestedPersonId: targetPersonId });
    return this.buildSettings(current.family.id, targetPersonId);
  }

  async putHealthKitSettings(actorUserId: string, input: PutHealthKitSettingsInput): Promise<HealthKitSettings> {
    const current = this.host.requireActiveMember(actorUserId);
    const selfProfile = await this.host.getSelfProfile(actorUserId);
    assertSelfProfileMatch({ selfProfileId: selfProfile?.id, requestedPersonId: input.personId });

    const uniqueGroups = [...new Set(input.enabledGroups)].filter((m): m is HealthKitMetric =>
      (HEALTHKIT_METRICS as readonly string[]).includes(m)
    );
    const nowIso = new Date().toISOString();
    const existing = this.profileSettings.get(input.personId);
    let timezoneVersion = existing?.healthTimezoneVersion ?? 1;
    let timezoneChanged = false;
    if (existing && existing.healthTimezone !== input.healthTimezone) {
      timezoneVersion = existing.healthTimezoneVersion + 1;
      timezoneChanged = true;
    }
    const consentActive = uniqueGroups.length > 0;
    if (consentActive && !input.consentVersion) {
      throw new HttpError(400, "consent_withdrawn", "consentVersion is required when enabling metrics.");
    }

    this.profileSettings.set(input.personId, {
      personId: input.personId,
      familyId: current.family.id,
      userId: actorUserId,
      consentVersion: consentActive ? input.consentVersion : existing?.consentVersion,
      consentedAt: consentActive ? existing?.consentedAt ?? nowIso : undefined,
      healthTimezone: input.healthTimezone,
      healthTimezoneVersion: timezoneVersion
    });

    const active = this.activeInstallation(input.personId);
    if (active && active.installationId !== input.installationId) {
      if (!input.replaceActiveInstallation) {
        throw new HttpError(
          409,
          "installation_inactive",
          "Replacing the active installation requires replaceActiveInstallation=true."
        );
      }
      this.installations.set(`${input.personId}:${active.installationId}`, {
        ...active,
        revokedAt: nowIso
      });
    }
    this.installations.set(`${input.personId}:${input.installationId}`, {
      personId: input.personId,
      familyId: current.family.id,
      installationId: input.installationId,
      activatedAt: nowIso,
      revokedAt: undefined
    });

    for (const metric of HEALTHKIT_METRICS) {
      const enabled = uniqueGroups.includes(metric);
      this.groupEnabled.set(`${input.personId}:${metric}`, enabled);
      const stateKey = `${input.personId}:${metric}`;
      const prev = this.syncState.get(stateKey);
      let status: HealthMetricSyncStatusCode = enabled ? (prev?.status ?? "never_synced") : "disabled";
      if (!enabled) status = "disabled";
      else if (timezoneChanged) status = "never_synced";
      else if (prev?.status === "disabled") status = "never_synced";
      this.syncState.set(stateKey, {
        personId: input.personId,
        familyId: current.family.id,
        group: metric,
        lastSuccessfulAt: timezoneChanged ? undefined : prev?.lastSuccessfulAt,
        lastAttemptAt: prev?.lastAttemptAt,
        lastErrorCode: timezoneChanged ? undefined : prev?.lastErrorCode,
        coverageStartAt: timezoneChanged ? undefined : prev?.coverageStartAt,
        coverageEndAt: timezoneChanged ? undefined : prev?.coverageEndAt,
        status
      });
    }

    this.host.audit({
      familyId: current.family.id,
      actorUserId,
      action: "healthkit.settings_updated",
      resourceType: "health_profile",
      resourceId: input.personId,
      metadata: {
        enabledGroups: uniqueGroups,
        healthTimezone: input.healthTimezone,
        installationReplaced: Boolean(input.replaceActiveInstallation)
      }
    });
    return this.buildSettings(current.family.id, input.personId);
  }

  async applyHealthKitEvents(actorUserId: string, input: HealthKitEventsBatchInput): Promise<HealthKitEventsBatchResult> {
    if (input.events.length === 0) {
      throw new HttpError(400, "payload_invalid", "events batch must not be empty.");
    }
    const current = this.host.requireActiveMember(actorUserId);
    const selfProfile = await this.host.getSelfProfile(actorUserId);
    assertSelfProfileMatch({ selfProfileId: selfProfile?.id, requestedPersonId: input.personId });

    const settings = this.profileSettings.get(input.personId);
    if (!settings?.consentedAt) {
      throw new HttpError(403, "consent_withdrawn", "HealthKit upload consent is required.");
    }
    const active = this.activeInstallation(input.personId);
    if (!active || active.installationId !== input.installationId) {
      throw new HttpError(403, "installation_inactive", "Installation is not the active HealthKit installation.");
    }
    if (settings.healthTimezoneVersion !== input.timezoneVersion) {
      throw new HttpError(409, "timezone_stale", "Timezone version is stale.");
    }

    const results: HealthKitEventApplyResult[] = [];
    const nowIso = toUtcIso(new Date());

    for (const event of input.events) {
      try {
        assertEventCoherent(event);
        if (!this.groupEnabled.get(`${input.personId}:${event.group}`)) {
          throw new HttpError(403, "group_disabled", `Group ${event.group} is not enabled.`);
        }
        if (event.sessionId) {
          const session = this.sessions.get(event.sessionId);
          if (!session || session.personId !== input.personId) {
            throw new HttpError(400, "session_expired", "Backfill session is invalid.");
          }
          this.assertOpenSession(session, input);
          if (session.group !== event.group) {
            throw new HttpError(400, "payload_invalid", "Event group does not match session group.");
          }
          assertEventInBackfillRange(event, sessionRange(session));
        }

        const fingerprint = fingerprintHealthEvent(event, nodeSha256);
        results.push(
          this.applyOne(event, fingerprint, {
            familyId: current.family.id,
            personId: input.personId,
            installationId: input.installationId,
            timezoneVersion: input.timezoneVersion,
            actorUserId,
            nowIso
          })
        );
      } catch (error) {
        if (error instanceof HttpError && (error.code === "payload_invalid" || error.code === "event_conflict")) {
          results.push({
            eventId: event.eventId,
            result: error.code,
            errorCode: error.code,
            errorMessage: error.message
          });
          continue;
        }
        throw error;
      }
    }

    return { results };
  }

  async createBackfillSession(
    actorUserId: string,
    input: CreateHealthKitBackfillSessionInput
  ): Promise<HealthKitBackfillSession> {
    const current = this.host.requireActiveMember(actorUserId);
    const selfProfile = await this.host.getSelfProfile(actorUserId);
    assertSelfProfileMatch({ selfProfileId: selfProfile?.id, requestedPersonId: input.personId });

    const settings = this.profileSettings.get(input.personId);
    if (!settings?.consentedAt) {
      throw new HttpError(403, "consent_withdrawn", "HealthKit upload consent is required.");
    }
    const active = this.activeInstallation(input.personId);
    if (!active || active.installationId !== input.installationId) {
      throw new HttpError(403, "installation_inactive", "Installation is not the active HealthKit installation.");
    }
    if (settings.healthTimezoneVersion !== input.timezoneVersion) {
      throw new HttpError(409, "timezone_stale", "Timezone version is stale.");
    }
    if (!this.groupEnabled.get(`${input.personId}:${input.group}`)) {
      throw new HttpError(403, "group_disabled", `Group ${input.group} is not enabled.`);
    }

    const now = new Date();
    const nowIso = toUtcIso(now);
    const rangeEnd = now;
    const rangeStart = backfillRangeStart(input.group, now);
    const expiresAt = new Date(now.getTime() + BACKFILL_SESSION_TTL_MS);
    const localEndDay = localDateString(now, settings.healthTimezone);
    const { rangeStartDay, rangeEndDay } = profileLocalDayRange(localEndDay, 90);

    for (const session of this.sessions.values()) {
      if (session.personId === input.personId && session.group === input.group && session.status === "open") {
        this.sessions.set(session.sessionId, { ...session, status: "expired", expiresAt: nowIso });
      }
    }

    const session: SessionRow = {
      sessionId: crypto.randomUUID(),
      personId: input.personId,
      familyId: current.family.id,
      group: input.group,
      installationId: input.installationId,
      timezoneVersion: input.timezoneVersion,
      rangeStart: toUtcIso(rangeStart),
      rangeEnd: toUtcIso(rangeEnd),
      rangeStartDay,
      rangeEndDay,
      requiredScopeKeys: requiredScopeKeysForGroup(input.group),
      status: "open",
      expiresAt: toUtcIso(expiresAt),
      pendingCount: 0
    };
    this.sessions.set(session.sessionId, session);
    this.touchState({
      familyId: current.family.id,
      personId: input.personId,
      group: input.group,
      nowIso,
      status: "backfilling"
    });
    return { ...session, pendingCount: 0 };
  }

  async putScopeManifest(
    actorUserId: string,
    sessionId: string,
    scopeKey: string,
    input: PutHealthKitScopeManifestInput
  ): Promise<HealthKitScopeManifestResult> {
    await this.host.getSelfProfile(actorUserId);
    this.host.requireActiveMember(actorUserId);
    const session = this.sessions.get(sessionId);
    if (!session || session.personId !== input.personId) {
      throw new HttpError(400, "session_expired", "Backfill session is invalid.");
    }
    this.assertOpenSession(session, input);
    if (!session.requiredScopeKeys.includes(scopeKey)) {
      throw new HttpError(400, "payload_invalid", "scopeKey is not required for this session.");
    }

    const key = `${sessionId}:${scopeKey}`;
    const existing = this.manifests.get(key);
    if (existing) {
      if (existing.manifestHash === input.manifestHash && existing.eventCount === input.eventCount) {
        return { sessionId, scopeKey, status: "duplicate", eventCount: existing.eventCount };
      }
      throw new HttpError(409, "event_conflict", "Scope manifest conflicts with a previous upload.");
    }

    const eventIds = [...this.events.values()]
      .filter((e) => e.sessionId === sessionId && e.scopeKey === scopeKey)
      .map((e) => e.eventId.toLowerCase())
      .sort();
    if (eventIds.length !== input.eventCount) {
      throw new HttpError(
        409,
        "session_incomplete",
        `Manifest eventCount ${input.eventCount} does not match received ${eventIds.length}.`
      );
    }
    const expectedHash = fingerprintScopeManifest({ sessionId, scopeKey, eventIds }, nodeSha256);
    if (expectedHash !== input.manifestHash.toLowerCase()) {
      throw new HttpError(409, "manifest_incomplete", "Scope manifest hash does not match received events.");
    }
    this.manifests.set(key, { sessionId, scopeKey, eventCount: input.eventCount, manifestHash: expectedHash });
    return { sessionId, scopeKey, status: "accepted", eventCount: input.eventCount };
  }

  async completeBackfillSession(
    actorUserId: string,
    sessionId: string,
    input: CompleteHealthKitBackfillSessionInput
  ): Promise<HealthKitBackfillSessionCompleteResult> {
    const current = this.host.requireActiveMember(actorUserId);
    const selfProfile = await this.host.getSelfProfile(actorUserId);
    assertSelfProfileMatch({ selfProfileId: selfProfile?.id, requestedPersonId: input.personId });
    const session = this.sessions.get(sessionId);
    if (!session || session.personId !== input.personId) {
      throw new HttpError(400, "session_expired", "Backfill session is invalid.");
    }
    if (session.status === "completed") {
      return { sessionId, group: session.group, completed: true };
    }
    this.assertOpenSession(session, input);
    for (const scope of session.requiredScopeKeys) {
      if (!this.manifests.has(`${sessionId}:${scope}`)) {
        throw new HttpError(409, "session_incomplete", `Missing scope manifest for ${scope}.`);
      }
    }

    if (session.group === "sleep") {
      for (const [key, row] of this.sleepDays) {
        if (
          row.personId === input.personId &&
          row.timezoneVersion < session.timezoneVersion &&
          row.sleepDay >= session.rangeStartDay &&
          row.sleepDay <= session.rangeEndDay
        ) {
          this.sleepDays.delete(key);
        }
      }
    }

    const nowIso = toUtcIso(new Date());
    this.sessions.set(sessionId, { ...session, status: "completed", completedAt: nowIso });
    this.touchState({
      familyId: current.family.id,
      personId: input.personId,
      group: session.group,
      nowIso,
      status: "ready",
      success: true,
      coverageStartAt: session.rangeStart,
      coverageEndAt: session.rangeEnd
    });
    return { sessionId, group: session.group, completed: true };
  }

  async abortBackfillSession(
    actorUserId: string,
    sessionId: string,
    input: AbortHealthKitBackfillSessionInput
  ): Promise<HealthKitBackfillSessionAbortResult> {
    const current = this.host.requireActiveMember(actorUserId);
    const selfProfile = await this.host.getSelfProfile(actorUserId);
    assertSelfProfileMatch({ selfProfileId: selfProfile?.id, requestedPersonId: input.personId });
    const session = this.sessions.get(sessionId);
    if (!session || session.personId !== input.personId) {
      throw new HttpError(400, "session_expired", "Backfill session is invalid.");
    }
    if (session.status === "aborted" || session.status === "completed") {
      return { sessionId, group: session.group, aborted: true };
    }
    const active = this.activeInstallation(input.personId);
    if (!active || active.installationId !== input.installationId) {
      throw new HttpError(403, "installation_inactive", "Installation is not the active HealthKit installation.");
    }
    const nowIso = toUtcIso(new Date());
    this.sessions.set(sessionId, {
      ...session,
      status: "aborted",
      abortedAt: nowIso,
      abortReason: input.reason
    });
    this.touchState({
      familyId: current.family.id,
      personId: input.personId,
      group: session.group,
      nowIso,
      status: "error",
      lastErrorCode: input.reason ?? "session_aborted"
    });
    return { sessionId, group: session.group, aborted: true };
  }

  async getBackfillSession(actorUserId: string, sessionId: string): Promise<HealthKitBackfillSession> {
    this.host.requireActiveMember(actorUserId);
    const selfProfile = await this.host.getSelfProfile(actorUserId);
    const session = this.sessions.get(sessionId);
    if (!session || session.personId !== selfProfile?.id) {
      throw new HttpError(404, "session_expired", "Backfill session not found.");
    }
    const pendingCount = [...this.events.values()].filter((e) => e.sessionId === sessionId).length;
    return { ...session, pendingCount };
  }

  async listBackfillPending(
    actorUserId: string,
    sessionId: string,
    cursor?: string,
    limit = 100
  ): Promise<{ eventIds: string[]; nextCursor?: string }> {
    this.host.requireActiveMember(actorUserId);
    const selfProfile = await this.host.getSelfProfile(actorUserId);
    const session = this.sessions.get(sessionId);
    if (!session || session.personId !== selfProfile?.id) {
      throw new HttpError(404, "session_expired", "Backfill session not found.");
    }
    let ids = [...this.events.values()]
      .filter((e) => e.sessionId === sessionId)
      .map((e) => e.eventId)
      .sort();
    if (cursor) ids = ids.filter((id) => id > cursor);
    const page = ids.slice(0, Math.min(limit, 100));
    return {
      eventIds: page,
      nextCursor: page.length === Math.min(limit, 100) ? page[page.length - 1] : undefined
    };
  }

  async getGroupManifest(
    actorUserId: string,
    group: HealthKitMetric,
    personId?: string
  ): Promise<HealthKitGroupManifest> {
    this.host.requireActiveMember(actorUserId);
    const selfProfile = await this.host.getSelfProfile(actorUserId);
    const target = personId ?? selfProfile?.id;
    if (!target) {
      throw new HttpError(409, "healthkit_self_profile_required", "Create your self profile before using HealthKit sync.");
    }
    assertSelfProfileMatch({ selfProfileId: selfProfile?.id, requestedPersonId: target });
    const active = this.activeInstallation(target);
    if (!active) return { personId: target, group, entityCount: 0, entities: [] };
    const scopes = new Set(requiredScopeKeysForGroup(group));
    const entities = [...this.entities.values()]
      .filter((e) => e.personId === target && e.installationId === active.installationId)
      .filter((e) => entityBelongsToGroup(e.entityKey, scopes))
      .map((e) => ({
        entityKey: e.entityKey,
        entityVersion: e.entityVersion,
        fingerprint: e.fingerprint,
        op: e.op
      }))
      .sort((a, b) => a.entityKey.localeCompare(b.entityKey));
    return {
      personId: target,
      group,
      installationId: active.installationId,
      entityCount: entities.length,
      entities
    };
  }

  async getHealthMetricFreshness(
    actorUserId: string,
    personId: string,
    healthMetric: HealthKitMetricKey
  ): Promise<HealthMetricFreshness> {
    this.host.requireActiveMember(actorUserId);
    const group = HEALTHKIT_METRIC_REGISTRY[healthMetric].group;
    const settings = this.profileSettings.get(personId);
    const state = this.syncState.get(`${personId}:${group}`);
    return {
      healthMetric,
      group,
      healthTimezone: settings?.healthTimezone ?? "UTC",
      healthTimezoneVersion: settings?.healthTimezoneVersion ?? 1,
      lastSuccessfulAt: state?.lastSuccessfulAt,
      status: state?.status ?? "never_synced",
      coverageStartAt: state?.coverageStartAt,
      coverageEndAt: state?.coverageEndAt
    };
  }

  async listStepHours(
    _actorUserId: string,
    personId: string,
    rangeStartUtc: string,
    rangeEndUtc: string
  ): Promise<HealthStepHourRecord[]> {
    return [...this.stepHours.values()]
      .filter((row) => row.personId === personId)
      .filter((row) => row.hourStartUtc >= rangeStartUtc && row.hourStartUtc < rangeEndUtc)
      .sort((a, b) => a.hourStartUtc.localeCompare(b.hourStartUtc))
      .map(({ personId: p, hourStartUtc, count }) => ({ personId: p, hourStartUtc, count }));
  }

  async listSleepDays(
    _actorUserId: string,
    personId: string,
    rangeStartDay: string,
    rangeEndDay: string
  ): Promise<HealthSleepDayRecord[]> {
    const byDay = new Map<string, HealthSleepDayRecord>();
    for (const row of this.sleepDays.values()) {
      if (row.personId !== personId) continue;
      if (row.sleepDay < rangeStartDay || row.sleepDay > rangeEndDay) continue;
      const prev = byDay.get(row.sleepDay);
      if (!prev || row.timezoneVersion >= prev.timezoneVersion) {
        byDay.set(row.sleepDay, row);
      }
    }
    return [...byDay.values()].sort((a, b) => a.sleepDay.localeCompare(b.sleepDay));
  }

  async listHealthKitBloodPressure(
    _actorUserId: string,
    personId: string,
    rangeStartUtc: string,
    rangeEndUtc: string,
    limit: number
  ): Promise<BloodPressureReading[]> {
    return [...this.host.bloodPressureReadings.values()]
      .filter((r) => r.personId === personId && r.source === "healthkit" && !r.deletedAt)
      .filter((r) => r.measuredAt >= rangeStartUtc && r.measuredAt <= rangeEndUtc)
      .sort((a, b) => a.measuredAt.localeCompare(b.measuredAt))
      .slice(0, limit);
  }

  async listDailyMetrics(
    _actorUserId: string,
    personId: string,
    healthMetric: HealthKitMetricKey,
    rangeStartDay: string,
    rangeEndDay: string
  ): Promise<HealthDailyMetricRecord[]> {
    const settings = this.profileSettings.get(personId);
    const timezoneVersion = settings?.healthTimezoneVersion ?? 1;
    return [...this.dailyMetrics.values()]
      .filter(
        (row) =>
          row.personId === personId &&
          row.healthMetric === healthMetric &&
          row.timezoneVersion === timezoneVersion &&
          row.localDay >= rangeStartDay &&
          row.localDay <= rangeEndDay
      )
      .sort((a, b) => a.localDay.localeCompare(b.localDay))
      .map((row) => ({
        personId: row.personId,
        healthMetric,
        localDay: row.localDay,
        timezoneVersion: row.timezoneVersion,
        unit: HEALTHKIT_METRIC_REGISTRY[healthMetric].unit,
        sumValue: row.sumValue,
        averageValue: row.averageValue,
        minimumValue: row.minimumValue,
        maximumValue: row.maximumValue,
        latestValue: row.latestValue,
        sampleCount: row.sampleCount
      }));
  }

  async listHealthKitBloodGlucose(
    _actorUserId: string,
    personId: string,
    rangeStartUtc: string,
    rangeEndUtc: string,
    limit: number
  ): Promise<BloodGlucoseReading[]> {
    return [...this.glucose.values()]
      .filter((r) => r.personId === personId)
      .filter((r) => r.measuredAtUtc >= rangeStartUtc && r.measuredAtUtc <= rangeEndUtc)
      .sort((a, b) => a.measuredAtUtc.localeCompare(b.measuredAtUtc))
      .slice(0, limit)
      .map((r) => ({
        id: r.sourceSampleKey,
        familyId: "",
        personId: r.personId,
        recordedByUserId: "",
        value: r.valueMgDl,
        unit: "mg/dL" as const,
        measuredAt: r.measuredAtUtc,
        source: "healthkit" as const,
        createdAt: r.measuredAtUtc,
        updatedAt: r.measuredAtUtc
      }));
  }

  async listHealthKitWorkouts(
    _actorUserId: string,
    personId: string,
    rangeStartUtc: string,
    rangeEndUtc: string,
    limit: number
  ): Promise<HealthWorkoutRecord[]> {
    return [...this.workouts.values()]
      .filter((r) => r.personId === personId)
      .filter((r) => r.startedAtUtc >= rangeStartUtc && r.startedAtUtc <= rangeEndUtc)
      .sort((a, b) => a.startedAtUtc.localeCompare(b.startedAtUtc))
      .slice(0, limit)
      .map((r) => ({
        id: r.sourceSampleKey,
        personId: r.personId,
        workoutType: r.workoutType,
        startedAtUtc: r.startedAtUtc,
        endedAtUtc: r.endedAtUtc,
        durationSeconds: r.durationSeconds,
        activeEnergyKcal: r.activeEnergyKcal,
        distanceMeters: r.distanceMeters,
        averageHeartRateBpm: r.averageHeartRateBpm,
        maximumHeartRateBpm: r.maximumHeartRateBpm
      }));
  }

  private applyOne(
    event: HealthKitSyncEvent,
    fingerprint: string,
    ctx: {
      familyId: string;
      personId: string;
      installationId: string;
      timezoneVersion: number;
      actorUserId: string;
      nowIso: string;
    }
  ): HealthKitEventApplyResult {
    const existingEvent = this.events.get(event.eventId);
    if (existingEvent) {
      if (existingEvent.fingerprint !== fingerprint) {
        throw new HttpError(409, "event_conflict", "Event id was reused with a different fingerprint.");
      }
      return { eventId: event.eventId, result: "duplicate" };
    }

    const entityKey = `${ctx.personId}:${ctx.installationId}:${event.entityKey}`;
    const entity = this.entities.get(entityKey);
    if (entity) {
      if (event.entityVersion < entity.entityVersion) {
        this.events.set(event.eventId, {
          eventId: event.eventId,
          personId: ctx.personId,
          installationId: ctx.installationId,
          entityKey: event.entityKey,
          entityVersion: event.entityVersion,
          group: event.group,
          scopeKey: event.scopeKey,
          op: event.op,
          sessionId: event.sessionId,
          fingerprint,
          applyResult: "superseded"
        });
        return { eventId: event.eventId, result: "superseded" };
      }
      if (event.entityVersion === entity.entityVersion) {
        if (entity.fingerprint !== fingerprint) {
          throw new HttpError(409, "event_conflict", "Entity version reused with a different fingerprint.");
        }
        this.events.set(event.eventId, {
          eventId: event.eventId,
          personId: ctx.personId,
          installationId: ctx.installationId,
          entityKey: event.entityKey,
          entityVersion: event.entityVersion,
          group: event.group,
          scopeKey: event.scopeKey,
          op: event.op,
          sessionId: event.sessionId,
          fingerprint,
          applyResult: "duplicate"
        });
        return { eventId: event.eventId, result: "duplicate" };
      }
    }

    this.applyCanonical(event, ctx);
    this.entities.set(entityKey, {
      personId: ctx.personId,
      installationId: ctx.installationId,
      entityKey: event.entityKey,
      entityVersion: event.entityVersion,
      fingerprint,
      op: event.op,
      lastEventId: event.eventId
    });
    this.events.set(event.eventId, {
      eventId: event.eventId,
      personId: ctx.personId,
      installationId: ctx.installationId,
      entityKey: event.entityKey,
      entityVersion: event.entityVersion,
      group: event.group,
      scopeKey: event.scopeKey,
      op: event.op,
      sessionId: event.sessionId,
      fingerprint,
      applyResult: "applied"
    });

    if (!event.sessionId) {
      this.touchState({
        familyId: ctx.familyId,
        personId: ctx.personId,
        group: event.group,
        nowIso: ctx.nowIso,
        success: true,
        touchOnly: true
      });
    }

    return { eventId: event.eventId, result: "applied" };
  }

  private applyCanonical(
    event: HealthKitSyncEvent,
    ctx: {
      familyId: string;
      personId: string;
      timezoneVersion: number;
      actorUserId: string;
      nowIso: string;
    }
  ) {
    if (event.op === "delete") {
      this.applyDelete(ctx.personId, event.entityKey, ctx.timezoneVersion);
      return;
    }
    const payload = event.payload!;
    switch (payload.kind) {
      case "steps_hour":
        this.stepHours.set(`${ctx.personId}:${payload.hourStartUtc}`, {
          familyId: ctx.familyId,
          personId: ctx.personId,
          hourStartUtc: payload.hourStartUtc,
          count: payload.count
        });
        return;
      case "sleep_day":
        this.sleepDays.set(`${ctx.personId}:${payload.sleepDay}:${ctx.timezoneVersion}`, {
          familyId: ctx.familyId,
          personId: ctx.personId,
          sleepDay: payload.sleepDay,
          timezoneVersion: ctx.timezoneVersion,
          totalMinutes: payload.totalMinutes,
          coreMinutes: payload.coreMinutes,
          deepMinutes: payload.deepMinutes,
          remMinutes: payload.remMinutes,
          unspecifiedAsleepMinutes: payload.unspecifiedAsleepMinutes,
          awakeMinutes: payload.awakeMinutes,
          inBedMinutes: payload.inBedMinutes,
          wristTemperatureCelsius: payload.wristTemperatureCelsius,
          breathingDisturbanceCount: payload.breathingDisturbanceCount
        });
        return;
      case "daily_metric":
        this.dailyMetrics.set(
          `${ctx.personId}:${payload.healthMetric}:${payload.localDay}:${ctx.timezoneVersion}`,
          {
            familyId: ctx.familyId,
            personId: ctx.personId,
            healthMetric: payload.healthMetric,
            localDay: payload.localDay,
            timezoneVersion: ctx.timezoneVersion,
            sumValue: payload.sumValue,
            averageValue: payload.averageValue,
            minimumValue: payload.minimumValue,
            maximumValue: payload.maximumValue,
            latestValue: payload.latestValue,
            sampleCount: payload.sampleCount
          }
        );
        return;
      case "blood_pressure": {
        const existingEntry = [...this.host.bloodPressureReadings.entries()].find(
          ([, reading]) =>
            reading.personId === ctx.personId &&
            reading.source === "healthkit" &&
            reading.sourceSampleKey === payload.sourceObjectKey
        );
        const storeKey = existingEntry?.[0] ?? crypto.randomUUID();
        const existing = existingEntry?.[1];
        this.host.bloodPressureReadings.set(storeKey, {
          id: existing?.id ?? storeKey,
          familyId: ctx.familyId,
          personId: ctx.personId,
          recordedByUserId: ctx.actorUserId,
          systolic: payload.systolic,
          diastolic: payload.diastolic,
          pulse: payload.pulse,
          measuredAt: payload.measuredAtUtc,
          source: "healthkit",
          sourceSampleKey: payload.sourceObjectKey,
          createdAt: existing?.createdAt ?? ctx.nowIso,
          updatedAt: ctx.nowIso,
          deletedAt: undefined
        });
        return;
      }
      case "blood_glucose":
        this.glucose.set(`${ctx.personId}:${payload.sourceSampleKey}`, {
          personId: ctx.personId,
          sourceSampleKey: payload.sourceSampleKey,
          measuredAtUtc: payload.measuredAtUtc,
          valueMgDl: payload.valueMgDl
        });
        return;
      case "workout":
        this.workouts.set(`${ctx.personId}:${payload.sourceSampleKey}`, {
          personId: ctx.personId,
          sourceSampleKey: payload.sourceSampleKey,
          workoutType: payload.workoutType,
          startedAtUtc: payload.startedAtUtc,
          endedAtUtc: payload.endedAtUtc,
          durationSeconds: payload.durationSeconds,
          activeEnergyKcal: payload.activeEnergyKcal,
          distanceMeters: payload.distanceMeters,
          averageHeartRateBpm: payload.averageHeartRateBpm,
          maximumHeartRateBpm: payload.maximumHeartRateBpm
        });
        return;
    }
  }

  private applyDelete(personId: string, entityKey: string, timezoneVersion: number) {
    if (entityKey.startsWith("steps_hour:")) {
      this.stepHours.delete(`${personId}:${entityKey.slice("steps_hour:".length)}`);
      return;
    }
    if (entityKey.startsWith("sleep_day:")) {
      this.sleepDays.delete(`${personId}:${entityKey.slice("sleep_day:".length)}:${timezoneVersion}`);
      return;
    }
    if (entityKey.startsWith("daily_metric:")) {
      const rest = entityKey.slice("daily_metric:".length);
      const idx = rest.lastIndexOf(":");
      const metric = rest.slice(0, idx);
      const day = rest.slice(idx + 1);
      this.dailyMetrics.delete(`${personId}:${metric}:${day}:${timezoneVersion}`);
      return;
    }
    if (entityKey.startsWith("blood_pressure:")) {
      const key = entityKey.slice("blood_pressure:".length);
      for (const [id, reading] of this.host.bloodPressureReadings) {
        if (reading.personId === personId && reading.sourceSampleKey === key) {
          this.host.bloodPressureReadings.delete(id);
        }
      }
      return;
    }
    if (entityKey.startsWith("blood_glucose:")) {
      this.glucose.delete(`${personId}:${entityKey.slice("blood_glucose:".length)}`);
      return;
    }
    if (entityKey.startsWith("workout:")) {
      this.workouts.delete(`${personId}:${entityKey.slice("workout:".length)}`);
      return;
    }
    throw new HttpError(400, "payload_invalid", "Unknown entity key for delete.");
  }

  private buildSettings(familyId: string, personId: string): HealthKitSettings {
    const settings = this.profileSettings.get(personId);
    const enabledGroups = HEALTHKIT_METRICS.filter((group) => this.groupEnabled.get(`${personId}:${group}`));
    const groups = HEALTHKIT_METRICS.map((group) => {
      const state = this.syncState.get(`${personId}:${group}`);
      const enabled = enabledGroups.includes(group);
      return {
        group,
        enabled,
        lastSuccessfulAt: state?.lastSuccessfulAt,
        lastAttemptAt: state?.lastAttemptAt,
        lastErrorCode: state?.lastErrorCode,
        coverageStartAt: state?.coverageStartAt,
        coverageEndAt: state?.coverageEndAt,
        status: state?.status ?? (enabled ? "never_synced" : "disabled")
      };
    });
    return {
      personId,
      consentVersion: settings?.consentVersion,
      consentedAt: settings?.consentedAt,
      healthTimezone: settings?.healthTimezone ?? "UTC",
      healthTimezoneVersion: settings?.healthTimezoneVersion ?? 1,
      enabledGroups,
      activeInstallationId: this.activeInstallation(personId)?.installationId,
      groups
    };
  }

  private activeInstallation(personId: string) {
    return [...this.installations.values()].find((row) => row.personId === personId && !row.revokedAt);
  }

  private assertOpenSession(session: SessionRow, input: { installationId: string; timezoneVersion: number }) {
    if (session.status !== "open") {
      throw new HttpError(400, "session_expired", "Backfill session is not open.");
    }
    if (Date.parse(session.expiresAt) <= Date.now()) {
      throw new HttpError(400, "session_expired", "Backfill session is expired.");
    }
    if (session.installationId !== input.installationId) {
      throw new HttpError(403, "installation_inactive", "Session does not belong to this installation.");
    }
    if (session.timezoneVersion !== input.timezoneVersion) {
      throw new HttpError(409, "timezone_stale", "Timezone version is stale.");
    }
  }

  private touchState(input: {
    familyId: string;
    personId: string;
    group: HealthKitMetric;
    nowIso: string;
    status?: HealthMetricSyncStatusCode;
    success?: boolean;
    touchOnly?: boolean;
    coverageStartAt?: string;
    coverageEndAt?: string;
    lastErrorCode?: string;
  }) {
    const key = `${input.personId}:${input.group}`;
    const prev = this.syncState.get(key);
    const status = input.status ?? prev?.status ?? "never_synced";
    this.syncState.set(key, {
      personId: input.personId,
      familyId: input.familyId,
      group: input.group,
      lastSuccessfulAt: input.success ? input.nowIso : prev?.lastSuccessfulAt,
      lastAttemptAt: input.nowIso,
      lastErrorCode: input.lastErrorCode ?? (input.success ? undefined : prev?.lastErrorCode),
      coverageStartAt: input.coverageStartAt ?? prev?.coverageStartAt,
      coverageEndAt: input.coverageEndAt ?? prev?.coverageEndAt,
      status
    });
  }
}

function sessionRange(session: HealthKitBackfillSession): HealthKitBackfillRange {
  return {
    rangeStartIso: session.rangeStart,
    rangeEndIso: session.rangeEnd,
    rangeStartDay: session.rangeStartDay,
    rangeEndDay: session.rangeEndDay
  };
}

function entityBelongsToGroup(entityKey: string, scopes: Set<string>): boolean {
  if (entityKey.startsWith("steps_hour:")) return scopes.has("steps");
  if (entityKey.startsWith("sleep_day:")) return scopes.has("sleep");
  if (entityKey.startsWith("daily_metric:")) {
    const metric = entityKey.split(":")[1] ?? "";
    return scopes.has(metric);
  }
  if (entityKey.startsWith("blood_pressure:")) return scopes.has("blood_pressure");
  if (entityKey.startsWith("blood_glucose:")) return scopes.has("blood_glucose");
  if (entityKey.startsWith("workout:")) return scopes.has("workout");
  return false;
}
