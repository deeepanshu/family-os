/**
 * In-memory HealthKit ops engine for unit tests.
 * Mirrors PostgresHealthKitStore natural-key apply rules without SQL.
 */
import type {
  BeginHealthKitRunInput,
  BloodGlucoseReading,
  BloodPressureReading,
  CompleteHealthKitRunInput,
  HealthDailyMetricRecord,
  HealthKitConsentGroup,
  HealthKitGroupImportStartResult,
  HealthKitGroupReadyResult,
  HealthKitGroupStatus,
  HealthKitMetric,
  HealthKitMetricKey,
  HealthKitOpApplyResult,
  HealthKitOpsBatchInput,
  HealthKitOpsBatchResult,
  HealthKitRunBeginResult,
  HealthKitRunCompleteResult,
  HealthKitSettings,
  HealthKitSyncOp,
  HealthMetricFreshness,
  HealthMetricSyncStatusCode,
  HealthSleepDayRecord,
  HealthStepHourRecord,
  HealthWorkoutRecord,
  MarkHealthKitGroupReadyInput,
  PutHealthKitSettingsInput,
  StartHealthKitImportInput
} from "@family-os/shared";
import { BACKFILL_WINDOW_MS, HEALTHKIT_METRIC_REGISTRY } from "@family-os/shared";
import { HttpError } from "../errors";
import {
  assertOpCoherent,
  assertRunKindAllowed,
  assertRunWindowShape,
  assertSelfProfileMatch,
  backfillRangeStart,
  deriveNeedsInitialImport,
  deriveRunRange,
  HEALTHKIT_METRICS,
  toUtcIso,
  unionCompletedCoverage
} from "./healthKitDomain";

type FamilyCtx = {
  family: { id: string };
};

export type MemoryHealthKitHost = {
  /** Optional; family features only. HealthKit uses Self person. */
  requireActiveMember(userId: string): FamilyCtx;
  getSelfProfile(userId: string): Promise<{ id: string; familyId: string | null } | null>;
  audit(input: {
    familyId: string | null;
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

export class MemoryHealthKitEngine {
  private readonly profileSettings = new Map<
    string,
    {
      personId: string;
      familyId: string | null;
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
      familyId: string | null;
      group: HealthKitConsentGroup;
      lastSuccessfulAt?: string;
      lastAttemptAt?: string;
      lastErrorCode?: string;
      coverageStartAt?: string;
      coverageEndAt?: string;
      historyImportCompletedAt?: string;
      historyImportInstallationId?: string;
      historyImportTimezoneVersion?: number;
      status: HealthMetricSyncStatusCode;
    }
  >();
  private readonly installations = new Map<
    string,
    {
      personId: string;
      familyId: string | null;
      installationId: string;
      activatedAt: string;
      revokedAt?: string;
    }
  >();
  /** Short-TTL op_id receipts (person-scoped). */
  private readonly opReceipts = new Set<string>();

  readonly stepHours = new Map<string, HealthStepHourRecord & { familyId: string | null }>();
  readonly sleepDays = new Map<
    string,
    HealthSleepDayRecord & { familyId: string | null; timezoneVersion: number }
  >();
  readonly dailyMetrics = new Map<
    string,
    HealthDailyMetricRecord & {
      familyId: string | null;
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
    {
      personId: string;
      sourceSampleKey: string;
      measuredAtUtc: string;
      valueMgDl: number;
    }
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
      minimumHeartRateBpm?: number;
      sourceName?: string;
      sourceBundleId?: string;
      deviceName?: string;
      deviceManufacturer?: string;
      isIndoor?: boolean;
      elevationAscendedMeters?: number;
      averageMETs?: number;
      swimmingStrokeCount?: number;
      totalFlightsClimbed?: number;
      events?: HealthWorkoutRecord["events"];
      activities?: HealthWorkoutRecord["activities"];
    }
  >();

  constructor(private readonly host: MemoryHealthKitHost) {}

  private async requireSelf(actorUserId: string): Promise<{ id: string; familyId: string | null }> {
    const self = await this.host.getSelfProfile(actorUserId);
    if (!self) {
      throw new HttpError(
        409,
        "healthkit_self_profile_required",
        "Create your self profile before using HealthKit sync."
      );
    }
    return self;
  }

  async getHealthKitSettings(actorUserId: string, personId?: string): Promise<HealthKitSettings> {
    const self = await this.requireSelf(actorUserId);
    const target = personId ?? self.id;
    assertSelfProfileMatch({ selfProfileId: self.id, requestedPersonId: target });
    return this.buildSettings(self.familyId, target);
  }

  async putHealthKitSettings(actorUserId: string, input: PutHealthKitSettingsInput): Promise<HealthKitSettings> {
    const self = await this.requireSelf(actorUserId);
    assertSelfProfileMatch({ selfProfileId: self.id, requestedPersonId: input.personId });

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
      familyId: self.familyId,
      userId: actorUserId,
      consentVersion: consentActive ? input.consentVersion : existing?.consentVersion,
      consentedAt: consentActive ? existing?.consentedAt ?? nowIso : undefined,
      healthTimezone: input.healthTimezone,
      healthTimezoneVersion: timezoneVersion
    });

    const active = this.activeInstallation(input.personId);
    let installationReplaced = false;
    if (active && active.installationId !== input.installationId) {
      if (!input.replaceActiveInstallation) {
        throw new HttpError(
          409,
          "installation_inactive",
          "Replacing the active installation requires replaceActiveInstallation=true."
        );
      }
      installationReplaced = true;
      this.installations.set(`${input.personId}:${active.installationId}`, {
        ...active,
        revokedAt: nowIso
      });
    }
    this.installations.set(`${input.personId}:${input.installationId}`, {
      personId: input.personId,
      familyId: self.familyId,
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
      else if (timezoneChanged || installationReplaced) status = "never_synced";
      else if (prev?.status === "disabled") status = "never_synced";
      this.syncState.set(stateKey, {
        personId: input.personId,
        familyId: self.familyId,
        group: metric,
        lastSuccessfulAt: timezoneChanged || installationReplaced ? undefined : prev?.lastSuccessfulAt,
        lastAttemptAt: prev?.lastAttemptAt,
        lastErrorCode: timezoneChanged || installationReplaced ? undefined : prev?.lastErrorCode,
        coverageStartAt: timezoneChanged || installationReplaced ? undefined : prev?.coverageStartAt,
        coverageEndAt: timezoneChanged || installationReplaced ? undefined : prev?.coverageEndAt,
        // Keep the marker exactly as Postgres does. Installation/timezone
        // mismatches invalidate it through deriveNeedsInitialImport; settings
        // saves must not erase history completion by themselves.
        historyImportCompletedAt: prev?.historyImportCompletedAt,
        historyImportInstallationId: prev?.historyImportInstallationId,
        historyImportTimezoneVersion: prev?.historyImportTimezoneVersion,
        status
      });
    }

    this.host.audit({
      familyId: self.familyId,
      actorUserId,
      action: "healthkit.settings_updated",
      resourceType: "health_profile",
      resourceId: input.personId,
      metadata: {
        enabledGroups: uniqueGroups,
        healthTimezone: input.healthTimezone,
        installationReplaced
      }
    });
    return this.buildSettings(self.familyId, input.personId);
  }

  async applyHealthKitOps(actorUserId: string, input: HealthKitOpsBatchInput): Promise<HealthKitOpsBatchResult> {
    if (input.ops.length === 0) {
      throw new HttpError(400, "payload_invalid", "ops batch must not be empty.");
    }
    const self = await this.requireSelf(actorUserId);
    assertSelfProfileMatch({ selfProfileId: self.id, requestedPersonId: input.personId });

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

    const results: HealthKitOpApplyResult[] = [];
    const nowIso = toUtcIso(new Date());

    for (const op of input.ops) {
      try {
        assertOpCoherent(op);
        if (op.op === "delete") {
          // Repair completion owns missing-key deletion (plan §7.3).
          throw new HttpError(
            400,
            "payload_invalid",
            "Client delete ops are not accepted; repair completion owns missing-key deletion."
          );
        }
        if (!this.groupEnabled.get(`${input.personId}:${op.group}`)) {
          throw new HttpError(403, "group_disabled", `Group ${op.group} is not enabled.`);
        }
        results.push(
          this.applyOne(op, {
            familyId: self.familyId,
            personId: input.personId,
            timezoneVersion: input.timezoneVersion,
            actorUserId,
            nowIso
          })
        );
      } catch (error) {
        if (error instanceof HttpError && error.code === "payload_invalid") {
          results.push({
            opId: op.opId,
            result: "rejected",
            errorCode: error.code,
            errorMessage: error.message
          });
          continue;
        }
        throw error;
      }
    }

    this.host.audit({
      familyId: self.familyId,
      actorUserId,
      action: "healthkit.ops_batch",
      resourceType: "healthkit_sync",
      resourceId: input.personId,
      metadata: {
        op_count: input.ops.length,
        applied: results.filter((r) => r.result === "applied").length,
        duplicate: results.filter((r) => r.result === "duplicate").length,
        rejected: results.filter((r) => r.result === "rejected").length
      }
    });

    return { results };
  }

  /** Legacy compatibility begin: 90-day window; never writes completed coverage. */
  async startHealthKitImport(
    actorUserId: string,
    group: HealthKitConsentGroup,
    input: StartHealthKitImportInput
  ): Promise<HealthKitGroupImportStartResult> {
    const self = await this.requireSelf(actorUserId);
    assertSelfProfileMatch({ selfProfileId: self.id, requestedPersonId: input.personId });
    this.assertWriteFence(input);

    if (!this.groupEnabled.get(`${input.personId}:${group}`)) {
      throw new HttpError(403, "group_disabled", `Group ${group} is not enabled.`);
    }

    const now = new Date();
    const nowIso = toUtcIso(now);
    const coverageStartAt = toUtcIso(backfillRangeStart(group, now));
    const coverageEndAt = nowIso;

    this.touchState({
      familyId: self.familyId,
      personId: input.personId,
      group,
      nowIso,
      status: "syncing"
    });

    return { group, status: "syncing", coverageStartAt, coverageEndAt };
  }

  /** Legacy compatibility completion: also records the history-import marker. */
  async markHealthKitGroupReady(
    actorUserId: string,
    group: HealthKitConsentGroup,
    input: MarkHealthKitGroupReadyInput
  ): Promise<HealthKitGroupReadyResult> {
    const self = await this.requireSelf(actorUserId);
    assertSelfProfileMatch({ selfProfileId: self.id, requestedPersonId: input.personId });
    this.assertWriteFence(input);

    if (!this.groupEnabled.get(`${input.personId}:${group}`)) {
      throw new HttpError(403, "group_disabled", `Group ${group} is not enabled.`);
    }

    const now = new Date();
    const nowIso = toUtcIso(now);
    const prev = this.syncState.get(`${input.personId}:${group}`);
    const coverageStartAt =
      input.coverageStartAt ?? prev?.coverageStartAt ?? toUtcIso(new Date(now.getTime() - BACKFILL_WINDOW_MS));
    const coverageEndAt = input.coverageEndAt ?? prev?.coverageEndAt ?? nowIso;

    this.touchState({
      familyId: self.familyId,
      personId: input.personId,
      group,
      nowIso,
      status: "ready",
      success: true,
      coverageStartAt,
      coverageEndAt,
      historyMarker: {
        completedAt: nowIso,
        installationId: input.installationId,
        timezoneVersion: input.timezoneVersion
      }
    });

    return { group, status: "ready", coverageStartAt, coverageEndAt };
  }

  async beginHealthKitRun(
    actorUserId: string,
    group: HealthKitConsentGroup,
    input: BeginHealthKitRunInput
  ): Promise<HealthKitRunBeginResult> {
    const self = await this.requireSelf(actorUserId);
    assertSelfProfileMatch({ selfProfileId: self.id, requestedPersonId: input.personId });
    this.assertWriteFence(input);

    if (!this.groupEnabled.get(`${input.personId}:${group}`)) {
      throw new HttpError(403, "group_disabled", `Group ${group} is not enabled.`);
    }

    const settings = this.profileSettings.get(input.personId);
    const state = this.syncState.get(`${input.personId}:${group}`);
    const needsInitialImport = this.needsInitialImport(input.personId, group);
    assertRunKindAllowed(input.kind, group, needsInitialImport);

    const now = new Date();
    const range = deriveRunRange({
      kind: input.kind,
      group,
      lastSuccessfulAt: state?.lastSuccessfulAt ?? null,
      now
    });

    // Begin records the attempt only; completed coverage changes on completion.
    this.touchState({
      familyId: self.familyId,
      personId: input.personId,
      group,
      nowIso: toUtcIso(now),
      status: "syncing"
    });

    this.host.audit({
      familyId: self.familyId,
      actorUserId,
      action: "healthkit.run_begin",
      resourceType: "healthkit_sync",
      resourceId: input.personId,
      metadata: { group, kind: input.kind, timezone_version: settings?.healthTimezoneVersion ?? 1 }
    });

    return { group, kind: input.kind, ...range };
  }

  async completeHealthKitRun(
    actorUserId: string,
    group: HealthKitConsentGroup,
    input: CompleteHealthKitRunInput
  ): Promise<HealthKitRunCompleteResult> {
    const self = await this.requireSelf(actorUserId);
    assertSelfProfileMatch({ selfProfileId: self.id, requestedPersonId: input.personId });
    this.assertWriteFence(input);

    if (!this.groupEnabled.get(`${input.personId}:${group}`)) {
      throw new HttpError(403, "group_disabled", `Group ${group} is not enabled.`);
    }

    const now = new Date();
    const nowIso = toUtcIso(now);

    if (input.kind === "repair_import") {
      if (input.completeSnapshot !== true || !Array.isArray(input.presentNaturalKeys)) {
        throw new HttpError(
          400,
          "payload_invalid",
          "Repair completion requires completeSnapshot=true and the complete presentNaturalKeys manifest."
        );
      }
    } else if (input.completeSnapshot !== undefined || input.presentNaturalKeys !== undefined) {
      throw new HttpError(400, "payload_invalid", "Only repair_import completion may supply a snapshot manifest.");
    }
    assertRunWindowShape({
      kind: input.kind,
      rangeStartAt: input.rangeStartAt,
      rangeEndAt: input.rangeEndAt,
      now
    });

    const needsInitialImport = this.needsInitialImport(input.personId, group);
    if (input.kind !== "initial_import" && needsInitialImport) {
      throw new HttpError(409, "initial_import_required", "Complete Import history before running Sync or repair for this metric.");
    }

    let deletedCount = 0;
    const completedCoverage = unionCompletedCoverage({
      existingCoverageStartAt: this.syncState.get(`${input.personId}:${group}`)?.coverageStartAt,
      existingCoverageEndAt: this.syncState.get(`${input.personId}:${group}`)?.coverageEndAt,
      completedRangeStartAt: input.rangeStartAt,
      completedRangeEndAt: input.rangeEndAt
    });
    if (input.kind === "repair_import") {
      assertRunKindAllowed("repair_import", group, needsInitialImport);
      deletedCount = this.reconcileRepairWindow({
        personId: input.personId,
        group,
        timezoneVersion: input.timezoneVersion,
        rangeStartAt: input.rangeStartAt,
        rangeEndAt: input.rangeEndAt,
        presentNaturalKeys: input.presentNaturalKeys ?? []
      });
    }

    this.touchState({
      familyId: self.familyId,
      personId: input.personId,
      group,
      nowIso,
      status: "ready",
      success: true,
      coverageStartAt: completedCoverage.coverageStartAt,
      coverageEndAt: completedCoverage.coverageEndAt,
      historyMarker:
        input.kind === "sync"
          ? undefined
          : {
              completedAt: nowIso,
              installationId: input.installationId,
              timezoneVersion: input.timezoneVersion
            }
    });

    this.host.audit({
      familyId: self.familyId,
      actorUserId,
      action: "healthkit.run_complete",
      resourceType: "healthkit_sync",
      resourceId: input.personId,
      metadata: { group, kind: input.kind, deleted_count: deletedCount }
    });

    return {
      group,
      kind: input.kind,
      status: "ready",
      deletedCount,
      lastSuccessfulAt: nowIso,
      coverageStartAt: completedCoverage.coverageStartAt,
      coverageEndAt: completedCoverage.coverageEndAt,
      needsInitialImport: false
    };
  }

  /** Repair-only in-memory missing-key reconciliation within the exact window. */
  private reconcileRepairWindow(input: {
    personId: string;
    group: HealthKitConsentGroup;
    timezoneVersion: number;
    rangeStartAt: string;
    rangeEndAt: string;
    presentNaturalKeys: string[];
  }): number {
    const manifest = new Set(input.presentNaturalKeys);
    let deleted = 0;
    switch (input.group) {
      case "vitals": {
        for (const [key, row] of this.host.bloodPressureReadings) {
          if (row.personId !== input.personId || row.deletedAt) continue;
          if (row.measuredAt < input.rangeStartAt || row.measuredAt > input.rangeEndAt) continue;
          if (!manifest.has(`blood_pressure:${key}`)) {
            this.host.bloodPressureReadings.set(key, { ...row, deletedAt: new Date().toISOString() });
            deleted += 1;
          }
        }
        return deleted;
      }
      case "sleep": {
        const healthTimezone = this.profileSettings.get(input.personId)?.healthTimezone ?? "UTC";
        const startDay = localDayStringInTimezone(input.rangeStartAt, healthTimezone);
        const endDay = localDayStringInTimezone(input.rangeEndAt, healthTimezone);
        for (const [key, row] of this.sleepDays) {
          if (row.personId !== input.personId || row.timezoneVersion !== input.timezoneVersion) continue;
          if (row.sleepDay < startDay || row.sleepDay > endDay) continue;
          if (!manifest.has(`sleep_day:${row.sleepDay}`)) {
            this.sleepDays.delete(key);
            deleted += 1;
          }
        }
        return deleted;
      }
      case "workouts": {
        for (const [key, row] of this.workouts) {
          if (row.personId !== input.personId) continue;
          if (row.startedAtUtc < input.rangeStartAt || row.startedAtUtc > input.rangeEndAt) continue;
          if (!manifest.has(`workout:${row.sourceSampleKey}`)) {
            this.workouts.delete(key);
            deleted += 1;
          }
        }
        return deleted;
      }
      default:
        throw new HttpError(400, "run_kind_not_allowed", `Repair is not supported for group ${input.group}.`);
    }
  }

  private needsInitialImport(personId: string, group: HealthKitConsentGroup): boolean {
    const settings = this.profileSettings.get(personId);
    const state = this.syncState.get(`${personId}:${group}`);
    const active = this.activeInstallation(personId);
    return deriveNeedsInitialImport({
      historyImportCompletedAt: state?.historyImportCompletedAt ?? null,
      historyImportInstallationId: state?.historyImportInstallationId ?? null,
      historyImportTimezoneVersion: state?.historyImportTimezoneVersion ?? null,
      activeInstallationId: active?.installationId ?? null,
      healthTimezoneVersion: settings?.healthTimezoneVersion ?? 1
    });
  }

  async getHealthKitGroupStatus(
    actorUserId: string,
    group: HealthKitConsentGroup,
    personId?: string
  ): Promise<HealthKitGroupStatus> {
    const selfProfile = await this.host.getSelfProfile(actorUserId);
    await this.requireSelf(actorUserId);
    const target = personId ?? selfProfile?.id;
    if (!target) {
      throw new HttpError(409, "healthkit_self_profile_required", "Create your self profile before using HealthKit sync.");
    }
    assertSelfProfileMatch({ selfProfileId: selfProfile?.id, requestedPersonId: target });
    const state = this.syncState.get(`${target}:${group}`);
    return {
      personId: target,
      group,
      enabled: this.groupEnabled.get(`${target}:${group}`) === true,
      status: state?.status ?? "never_synced",
      lastSuccessfulAt: state?.lastSuccessfulAt,
      lastAttemptAt: state?.lastAttemptAt,
      lastErrorCode: state?.lastErrorCode,
      coverageStartAt: state?.coverageStartAt,
      coverageEndAt: state?.coverageEndAt,
      needsInitialImport: this.needsInitialImport(target, group),
      historyImportCompletedAt: state?.historyImportCompletedAt
    };
  }

  async getHealthMetricFreshness(
    actorUserId: string,
    personId: string,
    healthMetric: HealthKitMetricKey
  ): Promise<HealthMetricFreshness> {
    await this.requireSelf(actorUserId);
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
    const settings = this.profileSettings.get(personId);
    const timezoneVersion = settings?.healthTimezoneVersion ?? 1;
    return [...this.sleepDays.values()]
      .filter(
        (row) =>
          row.personId === personId &&
          row.timezoneVersion === timezoneVersion &&
          row.sleepDay >= rangeStartDay &&
          row.sleepDay <= rangeEndDay
      )
      .sort((a, b) => a.sleepDay.localeCompare(b.sleepDay));
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
        maximumHeartRateBpm: r.maximumHeartRateBpm,
        minimumHeartRateBpm: r.minimumHeartRateBpm,
        sourceName: r.sourceName,
        sourceBundleId: r.sourceBundleId,
        deviceName: r.deviceName,
        deviceManufacturer: r.deviceManufacturer,
        isIndoor: r.isIndoor,
        elevationAscendedMeters: r.elevationAscendedMeters,
        averageMETs: r.averageMETs,
        swimmingStrokeCount: r.swimmingStrokeCount,
        totalFlightsClimbed: r.totalFlightsClimbed,
        events: r.events,
        activities: r.activities
      }));
  }

  private applyOne(
    op: HealthKitSyncOp,
    ctx: {
      familyId: string | null;
      personId: string;
      timezoneVersion: number;
      actorUserId: string;
      nowIso: string;
    }
  ): HealthKitOpApplyResult {
    if (this.opReceipts.has(op.opId)) {
      return { opId: op.opId, result: "duplicate" };
    }

    if (op.payload) {
      this.applyUpsert(op.payload, ctx);
    }

    this.opReceipts.add(op.opId);
    return { opId: op.opId, result: "applied" };
  }

  private applyUpsert(
    payload: NonNullable<HealthKitSyncOp["payload"]>,
    ctx: { familyId: string | null; personId: string; timezoneVersion: number; actorUserId: string; nowIso: string }
  ) {
    switch (payload.kind) {
      case "steps_hour": {
        const key = `${ctx.personId}:${payload.hourStartUtc}`;
        this.stepHours.set(key, {
          familyId: ctx.familyId,
          personId: ctx.personId,
          hourStartUtc: payload.hourStartUtc,
          count: payload.count
        });
        return;
      }
      case "sleep_day": {
        const key = `${ctx.personId}:${payload.sleepDay}:${ctx.timezoneVersion}`;
        this.sleepDays.set(key, {
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
      }
      case "daily_metric": {
        const key = `${ctx.personId}:${payload.healthMetric}:${payload.localDay}:${ctx.timezoneVersion}`;
        this.dailyMetrics.set(key, {
          familyId: ctx.familyId,
          personId: ctx.personId,
          healthMetric: payload.healthMetric,
          localDay: payload.localDay,
          timezoneVersion: ctx.timezoneVersion,
          unit: HEALTHKIT_METRIC_REGISTRY[payload.healthMetric].unit,
          sumValue: payload.sumValue,
          averageValue: payload.averageValue,
          minimumValue: payload.minimumValue,
          maximumValue: payload.maximumValue,
          latestValue: payload.latestValue,
          sampleCount: payload.sampleCount
        });
        return;
      }
      case "blood_pressure": {
        const id = payload.sourceObjectKey;
        this.host.bloodPressureReadings.set(id, {
          id,
          familyId: ctx.familyId,
          personId: ctx.personId,
          recordedByUserId: ctx.actorUserId,
          systolic: payload.systolic,
          diastolic: payload.diastolic,
          pulse: payload.pulse,
          measuredAt: payload.measuredAtUtc,
          source: "healthkit",
          sourceSampleKey: payload.sourceObjectKey,
          createdAt: ctx.nowIso,
          updatedAt: ctx.nowIso
        });
        return;
      }
      case "blood_glucose": {
        this.glucose.set(`${ctx.personId}:${payload.sourceSampleKey}`, {
          personId: ctx.personId,
          sourceSampleKey: payload.sourceSampleKey,
          measuredAtUtc: payload.measuredAtUtc,
          valueMgDl: payload.valueMgDl
        });
        return;
      }
      case "workout": {
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
          maximumHeartRateBpm: payload.maximumHeartRateBpm,
          minimumHeartRateBpm: payload.minimumHeartRateBpm,
          sourceName: payload.sourceName,
          sourceBundleId: payload.sourceBundleId,
          deviceName: payload.deviceName,
          deviceManufacturer: payload.deviceManufacturer,
          isIndoor: payload.isIndoor,
          elevationAscendedMeters: payload.elevationAscendedMeters,
          averageMETs: payload.averageMETs,
          swimmingStrokeCount: payload.swimmingStrokeCount,
          totalFlightsClimbed: payload.totalFlightsClimbed,
          events: payload.events,
          activities: payload.activities
        });
        return;
      }
    }
  }

  private assertWriteFence(input: {
    personId: string;
    installationId: string;
    timezoneVersion: number;
  }) {
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
  }

  private activeInstallation(personId: string) {
    for (const row of this.installations.values()) {
      if (row.personId === personId && !row.revokedAt) return row;
    }
    return undefined;
  }

  private touchState(input: {
    familyId: string | null;
    personId: string;
    group: HealthKitConsentGroup;
    nowIso: string;
    status: HealthMetricSyncStatusCode;
    success?: boolean;
    lastErrorCode?: string;
    coverageStartAt?: string;
    coverageEndAt?: string;
    /** Set on completed history imports; undefined leaves the marker intact. */
    historyMarker?: {
      completedAt: string;
      installationId: string;
      timezoneVersion: number;
    };
  }) {
    const key = `${input.personId}:${input.group}`;
    const prev = this.syncState.get(key);
    this.syncState.set(key, {
      personId: input.personId,
      familyId: input.familyId,
      group: input.group,
      lastSuccessfulAt: input.success ? input.nowIso : prev?.lastSuccessfulAt,
      lastAttemptAt: input.nowIso,
      lastErrorCode: input.lastErrorCode ?? (input.success ? undefined : prev?.lastErrorCode),
      coverageStartAt: input.coverageStartAt ?? prev?.coverageStartAt,
      coverageEndAt: input.coverageEndAt ?? prev?.coverageEndAt,
      historyImportCompletedAt: input.historyMarker?.completedAt ?? prev?.historyImportCompletedAt,
      historyImportInstallationId: input.historyMarker?.installationId ?? prev?.historyImportInstallationId,
      historyImportTimezoneVersion: input.historyMarker?.timezoneVersion ?? prev?.historyImportTimezoneVersion,
      status: input.status
    });
  }

  private buildSettings(familyId: string | null, personId: string): HealthKitSettings {
    const settings = this.profileSettings.get(personId);
    const active = this.activeInstallation(personId);
    const groups = HEALTHKIT_METRICS.map((group) => {
      const state = this.syncState.get(`${personId}:${group}`);
      const enabled = this.groupEnabled.get(`${personId}:${group}`) === true;
      return {
        group,
        enabled,
        lastSuccessfulAt: state?.lastSuccessfulAt,
        lastAttemptAt: state?.lastAttemptAt,
        lastErrorCode: state?.lastErrorCode,
        coverageStartAt: state?.coverageStartAt,
        coverageEndAt: state?.coverageEndAt,
        status: state?.status ?? (enabled ? "never_synced" : "disabled"),
        needsInitialImport: this.needsInitialImport(personId, group),
        historyImportCompletedAt: state?.historyImportCompletedAt
      };
    });
    return {
      personId,
      consentVersion: settings?.consentVersion,
      consentedAt: settings?.consentedAt,
      healthTimezone: settings?.healthTimezone ?? "UTC",
      healthTimezoneVersion: settings?.healthTimezoneVersion ?? 1,
      enabledGroups: groups.filter((g) => g.enabled).map((g) => g.group),
      activeInstallationId: active?.installationId,
      groups
    };
  }
}

/** In-memory counterpart of the postgres `at time zone` day conversion. */
function localDayStringInTimezone(iso: string, timezone: string): string {
  try {
    const parts = new Intl.DateTimeFormat("en-CA", {
      timeZone: timezone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit"
    }).formatToParts(new Date(iso));
    const year = parts.find((p) => p.type === "year")?.value ?? "1970";
    const month = parts.find((p) => p.type === "month")?.value ?? "01";
    const day = parts.find((p) => p.type === "day")?.value ?? "01";
    return `${year}-${month}-${day}`;
  } catch {
    return iso.slice(0, 10);
  }
}
