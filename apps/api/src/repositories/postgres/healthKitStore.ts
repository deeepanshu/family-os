import type {
  BeginHealthKitRunInput,
  BloodGlucoseReading,
  BloodPressureReading,
  CompleteHealthKitRunInput,
  FailHealthKitRunInput,
  HealthDailyMetricRecord,
  HealthKitConsentGroup,
  HealthKitGroupImportStartResult,
  HealthKitGroupReadyResult,
  HealthKitGroupStatus,
  HealthKitMetric,
  HealthKitMetricKey,
  HealthKitOpApplyResult,
  HealthKitOpPayload,
  HealthKitOpsBatchInput,
  HealthKitOpsBatchResult,
  HealthKitRunBeginResult,
  HealthKitRunCompleteResult,
  HealthKitRunFailResult,
  HealthKitSettings,
  HealthKitSyncOp,
  HealthMetricFreshness,
  HealthMetricSyncStatusCode,
  HealthSleepDayRecord,
  HealthStepHourRecord,
  HealthWorkoutExerciseLog,
  HealthWorkoutExerciseWrite,
  HealthWorkoutRecord,

  MarkHealthKitGroupReadyInput,
  PutHealthKitSettingsInput,
  StartHealthKitImportInput
} from "@family-os/shared";
import { BACKFILL_WINDOW_MS, HEALTHKIT_METRIC_REGISTRY, isStrengthWorkoutType } from "@family-os/shared";

import { HttpError } from "../../errors";
import {
  assertOpCoherent,
  assertRunKindAllowed,
  assertRunWindowShape,
  assertSelfProfileMatch,
  backfillRangeStart,
  deriveNeedsInitialImport,
  deriveRunRange,
  HEALTHKIT_METRICS,
  normalizeWorkoutExercises,
  toUtcIso,
  unionCompletedCoverage
} from "../healthKitDomain";

import { PostgresRepositoryContext } from "./context";
import { toDateString, toIso } from "./dateUtils";
import { mapBloodGlucose, mapBloodPressure } from "./mappers";
import type { Row } from "./types";

export class PostgresHealthKitStore {
  constructor(private readonly context: PostgresRepositoryContext) {}

  async getHealthKitSettings(actorUserId: string, personId?: string): Promise<HealthKitSettings> {
    const self = await this.context.requireSelfPerson(actorUserId);
    const targetPersonId = personId ?? self.personId;
    const access = await this.context.requirePersonAccess(actorUserId, targetPersonId);
    return this.loadSettings(actorUserId, access.familyId, targetPersonId);
  }

  async putHealthKitSettings(actorUserId: string, input: PutHealthKitSettingsInput): Promise<HealthKitSettings> {
    const self = await this.context.requireSelfPerson(actorUserId);
    const access = await this.context.requirePersonAccess(actorUserId, input.personId);
    assertSelfProfileMatch({ selfProfileId: self.personId, requestedPersonId: input.personId });

    const uniqueGroups = [...new Set(input.enabledGroups)].filter((m): m is HealthKitMetric =>
      (HEALTHKIT_METRICS as readonly string[]).includes(m)
    );
    const now = new Date();
    const nowIso = toUtcIso(now);
    let installationReplaced = false;

    await this.context.sql.begin(async (tx: any) => {
      const [existing] = await tx`
        select * from healthkit_sync_profile_settings where person_id = ${input.personId}
      `;
      let timezoneVersion = existing?.health_timezone_version ?? 1;
      let timezoneChanged = false;
      if (existing && existing.health_timezone !== input.healthTimezone) {
        timezoneVersion = Number(existing.health_timezone_version) + 1;
        timezoneChanged = true;
      }

      const consentActive = uniqueGroups.length > 0;
      if (consentActive && !input.consentVersion) {
        throw new HttpError(400, "consent_withdrawn", "consentVersion is required when enabling metrics.");
      }

      await tx`
        insert into healthkit_sync_profile_settings (
          person_id, family_id, user_id, consent_version, consented_at,
          health_timezone, health_timezone_version, updated_at
        ) values (
          ${input.personId},
          ${access.familyId},
          ${actorUserId},
          ${consentActive ? input.consentVersion ?? null : existing?.consent_version ?? null},
          ${consentActive ? existing?.consented_at ?? nowIso : null},
          ${input.healthTimezone},
          ${timezoneVersion},
          ${nowIso}
        )
        on conflict (person_id) do update set
          consent_version = excluded.consent_version,
          consented_at = excluded.consented_at,
          health_timezone = excluded.health_timezone,
          health_timezone_version = excluded.health_timezone_version,
          user_id = excluded.user_id,
          updated_at = excluded.updated_at
      `;

      const [activeInstall] = await tx`
        select * from healthkit_sync_installations
        where person_id = ${input.personId} and revoked_at is null
        limit 1
      `;
      if (activeInstall && activeInstall.installation_id !== input.installationId) {
        if (!input.replaceActiveInstallation) {
          throw new HttpError(
            409,
            "installation_inactive",
            "Replacing the active installation requires replaceActiveInstallation=true."
          );
        }
        installationReplaced = true;
        await tx`
          update healthkit_sync_installations
          set revoked_at = ${nowIso}
          where person_id = ${input.personId} and revoked_at is null
        `;
      }
      if (!activeInstall || activeInstall.installation_id !== input.installationId) {
        if (activeInstall && activeInstall.installation_id !== input.installationId) {
          installationReplaced = true;
        }
        await tx`
          insert into healthkit_sync_installations (person_id, family_id, installation_id, activated_at)
          values (${input.personId}, ${access.familyId}, ${input.installationId}, ${nowIso})
          on conflict (person_id, installation_id) do update set
            revoked_at = null,
            activated_at = ${nowIso}
        `;
      }

      for (const metric of HEALTHKIT_METRICS) {
        const enabled = uniqueGroups.includes(metric);
        await tx`
          insert into healthkit_sync_groups (person_id, family_id, group_key, enabled, updated_at)
          values (${input.personId}, ${access.familyId}, ${metric}, ${enabled}, ${nowIso})
          on conflict (person_id, group_key) do update set enabled = excluded.enabled, updated_at = excluded.updated_at
        `;

        const [state] = await tx`
          select * from healthkit_sync_state where person_id = ${input.personId} and group_key = ${metric}
        `;
        let status: HealthMetricSyncStatusCode = enabled ? (state?.status ?? "never_synced") : "disabled";
        if (!enabled) status = "disabled";
        else if (timezoneChanged || installationReplaced) status = "never_synced";
        else if (state?.status === "disabled") status = "never_synced";

        const clearCoverage = timezoneChanged || installationReplaced;
        await tx`
          insert into healthkit_sync_state (
            person_id, family_id, group_key, status, last_successful_at, last_attempt_at,
            last_error_code, coverage_start_at, coverage_end_at, updated_at
          ) values (
            ${input.personId}, ${access.familyId}, ${metric}, ${status},
            ${clearCoverage ? null : state?.last_successful_at ?? null},
            ${state?.last_attempt_at ?? null},
            ${clearCoverage ? null : state?.last_error_code ?? null},
            ${clearCoverage ? null : state?.coverage_start_at ?? null},
            ${clearCoverage ? null : state?.coverage_end_at ?? null},
            ${nowIso}
          )
          on conflict (person_id, group_key) do update set
            status = excluded.status,
            last_successful_at = excluded.last_successful_at,
            last_error_code = excluded.last_error_code,
            coverage_start_at = excluded.coverage_start_at,
            coverage_end_at = excluded.coverage_end_at,
            updated_at = excluded.updated_at
        `;
      }
    });

    await this.context.audit({
      familyId: access.familyId,
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

    return this.loadSettings(actorUserId, access.familyId, input.personId);
  }

  async applyHealthKitOps(actorUserId: string, input: HealthKitOpsBatchInput): Promise<HealthKitOpsBatchResult> {
    if (input.ops.length === 0) {
      throw new HttpError(400, "payload_invalid", "ops batch must not be empty.");
    }

    const self = await this.context.requireSelfPerson(actorUserId);
    const access = await this.context.requirePersonAccess(actorUserId, input.personId);
    assertSelfProfileMatch({ selfProfileId: self.personId, requestedPersonId: input.personId });

    const nowIso = toUtcIso(new Date());
    const results: HealthKitOpApplyResult[] = [];

    await this.context.sql.begin(async (tx: any) => {
      const authority = await this.loadWriteAuthority(tx, actorUserId, access.familyId, input.personId);
      if (!authority.settings?.consented_at) {
        throw new HttpError(403, "consent_withdrawn", "HealthKit upload consent is required.");
      }
      if (authority.activeInstallationId !== input.installationId) {
        throw new HttpError(403, "installation_inactive", "Installation is not the active HealthKit installation.");
      }
      if (authority.settings.health_timezone_version !== input.timezoneVersion) {
        throw new HttpError(409, "timezone_stale", "Timezone version is stale.");
      }

      for (const op of input.ops) {
        const savepoint = `op_${op.opId.replace(/-/g, "").slice(0, 24)}`;
        try {
          await tx.unsafe(`savepoint ${savepoint}`);
          assertOpCoherent(op);

          if (op.op === "delete") {
            // Missing-key deletion lives inside repair completion reconciliation
            // only (plan §7.3); client-supplied deletes can never bypass it.
            throw new HttpError(
              400,
              "payload_invalid",
              "Client delete ops are not accepted; repair completion owns missing-key deletion."
            );
          }

          if (!authority.enabledGroups.has(op.group)) {
            throw new HttpError(403, "group_disabled", `Group ${op.group} is not enabled.`);
          }

          const result = await this.applyOneOp(tx, {
            familyId: access.familyId,
            personId: input.personId,
            timezoneVersion: input.timezoneVersion,
            op,
            nowIso
          });
          await tx.unsafe(`release savepoint ${savepoint}`);
          results.push(result);
        } catch (error) {
          try {
            await tx.unsafe(`rollback to savepoint ${savepoint}`);
            await tx.unsafe(`release savepoint ${savepoint}`);
          } catch {
            // Savepoint may not exist if begin failed before savepoint.
          }
          if (error instanceof HttpError && error.code === "payload_invalid") {
            results.push({
              opId: op.opId,
              result: "rejected",
              errorCode: error.code,
              errorMessage: error.message
            });
            continue;
          }
          if (
            error instanceof HttpError &&
            (error.code === "consent_withdrawn" ||
              error.code === "installation_inactive" ||
              error.code === "timezone_stale" ||
              error.code === "group_disabled")
          ) {
            throw error;
          }
          throw error;
        }
      }
    });

    await this.context.audit({
      familyId: access.familyId,
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

  /**
   * Legacy compatibility route for already-released clients. Behaves like
   * `begin` with a 90-day window but never writes completed coverage — coverage
   * only moves on successful completion (plan §9, "Coverage" row).
   */
  async startHealthKitImport(
    actorUserId: string,
    group: HealthKitConsentGroup,
    input: StartHealthKitImportInput
  ): Promise<HealthKitGroupImportStartResult> {
    const self = await this.context.requireSelfPerson(actorUserId);
    const access = await this.context.requirePersonAccess(actorUserId, input.personId);
    assertSelfProfileMatch({ selfProfileId: self.personId, requestedPersonId: input.personId });

    const now = new Date();
    const nowIso = toUtcIso(now);
    const coverageStartAt = toUtcIso(backfillRangeStart(group, now));
    const coverageEndAt = nowIso;

    await this.context.sql.begin(async (tx: any) => {
      const authority = await this.loadWriteAuthority(tx, actorUserId, access.familyId, input.personId);
      if (!authority.settings?.consented_at) {
        throw new HttpError(403, "consent_withdrawn", "HealthKit upload consent is required.");
      }
      if (authority.activeInstallationId !== input.installationId) {
        throw new HttpError(403, "installation_inactive", "Installation is not the active HealthKit installation.");
      }
      if (authority.settings.health_timezone_version !== input.timezoneVersion) {
        throw new HttpError(409, "timezone_stale", "Timezone version is stale.");
      }
      if (!authority.enabledGroups.has(group)) {
        throw new HttpError(403, "group_disabled", `Group ${group} is not enabled.`);
      }

      await this.touchGroupState(tx, {
        familyId: access.familyId,
        personId: input.personId,
        group,
        nowIso,
        status: "syncing"
      });
    });

    return { group, status: "syncing", coverageStartAt, coverageEndAt };
  }

  /**
   * Legacy compatibility completion. Completes coverage and records the
   * initial-history completion marker so upgraded clients keep their history.
   */
  async markHealthKitGroupReady(
    actorUserId: string,
    group: HealthKitConsentGroup,
    input: MarkHealthKitGroupReadyInput
  ): Promise<HealthKitGroupReadyResult> {
    const self = await this.context.requireSelfPerson(actorUserId);
    const access = await this.context.requirePersonAccess(actorUserId, input.personId);
    assertSelfProfileMatch({ selfProfileId: self.personId, requestedPersonId: input.personId });

    const now = new Date();
    const nowIso = toUtcIso(now);
    let coverageStartAt = input.coverageStartAt;
    let coverageEndAt = input.coverageEndAt;

    await this.context.sql.begin(async (tx: any) => {
      const authority = await this.loadWriteAuthority(tx, actorUserId, access.familyId, input.personId);
      if (!authority.settings?.consented_at) {
        throw new HttpError(403, "consent_withdrawn", "HealthKit upload consent is required.");
      }
      if (authority.activeInstallationId !== input.installationId) {
        throw new HttpError(403, "installation_inactive", "Installation is not the active HealthKit installation.");
      }
      if (authority.settings.health_timezone_version !== input.timezoneVersion) {
        throw new HttpError(409, "timezone_stale", "Timezone version is stale.");
      }
      if (!authority.enabledGroups.has(group)) {
        throw new HttpError(403, "group_disabled", `Group ${group} is not enabled.`);
      }

      const [existing] = await tx`
        select coverage_start_at, coverage_end_at from healthkit_sync_state
        where person_id = ${input.personId} and group_key = ${group}
      `;
      coverageStartAt =
        coverageStartAt ??
        (existing?.coverage_start_at
          ? toIso(existing.coverage_start_at)
          : toUtcIso(new Date(now.getTime() - BACKFILL_WINDOW_MS)));
      coverageEndAt =
        coverageEndAt ?? (existing?.coverage_end_at ? toIso(existing.coverage_end_at) : nowIso);

      await this.touchGroupState(tx, {
        familyId: access.familyId,
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
    });

    return {
      group,
      status: "ready",
      coverageStartAt,
      coverageEndAt
    };
  }

  async beginHealthKitRun(
    actorUserId: string,
    group: HealthKitConsentGroup,
    input: BeginHealthKitRunInput
  ): Promise<HealthKitRunBeginResult> {
    const self = await this.context.requireSelfPerson(actorUserId);
    const access = await this.context.requirePersonAccess(actorUserId, input.personId);
    assertSelfProfileMatch({ selfProfileId: self.personId, requestedPersonId: input.personId });

    const now = new Date();
    const nowIso = toUtcIso(now);

    const descriptor = await this.context.sql.begin(async (tx: any) => {
      const authority = await this.loadWriteAuthority(tx, actorUserId, access.familyId, input.personId);
      if (!authority.settings?.consented_at) {
        throw new HttpError(403, "consent_withdrawn", "HealthKit upload consent is required.");
      }
      if (authority.activeInstallationId !== input.installationId) {
        throw new HttpError(403, "installation_inactive", "Installation is not the active HealthKit installation.");
      }
      if (authority.settings.health_timezone_version !== input.timezoneVersion) {
        throw new HttpError(409, "timezone_stale", "Timezone version is stale.");
      }
      if (!authority.enabledGroups.has(group)) {
        throw new HttpError(403, "group_disabled", `Group ${group} is not enabled.`);
      }

      const [state] = await tx`
        select * from healthkit_sync_state
        where person_id = ${input.personId} and group_key = ${group}
      `;
      const needsInitialImport = deriveNeedsInitialImport({
        historyImportCompletedAt: state?.history_import_completed_at ?? null,
        historyImportInstallationId: state?.history_import_installation_id ?? null,
        historyImportTimezoneVersion: state?.history_import_timezone_version ?? null,
        activeInstallationId: authority.activeInstallationId,
        healthTimezoneVersion: authority.settings.health_timezone_version
      });
      assertRunKindAllowed(input.kind, group, needsInitialImport);

      const range = deriveRunRange({
        kind: input.kind,
        group,
        lastSuccessfulAt: state?.last_successful_at ?? null,
        now
      });

      // Begin records the attempt only. Completed coverage, last success, and
      // the history marker change solely on successful completion (plan §7.2).
      await this.touchGroupState(tx, {
        familyId: access.familyId,
        personId: input.personId,
        group,
        nowIso,
        status: "syncing"
      });

      return range;
    });

    await this.context.audit({
      familyId: access.familyId,
      actorUserId,
      action: "healthkit.run_begin",
      resourceType: "healthkit_sync",
      resourceId: input.personId,
      metadata: { group, kind: input.kind }
    });

    return { group, kind: input.kind, ...descriptor };
  }

  async completeHealthKitRun(
    actorUserId: string,
    group: HealthKitConsentGroup,
    input: CompleteHealthKitRunInput
  ): Promise<HealthKitRunCompleteResult> {
    const self = await this.context.requireSelfPerson(actorUserId);
    const access = await this.context.requirePersonAccess(actorUserId, input.personId);
    assertSelfProfileMatch({ selfProfileId: self.personId, requestedPersonId: input.personId });

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
      // Deletion authority must never ride along on a non-repair completion.
      throw new HttpError(400, "payload_invalid", "Only repair_import completion may supply a snapshot manifest.");
    }
    assertRunWindowShape({
      kind: input.kind,
      rangeStartAt: input.rangeStartAt,
      rangeEndAt: input.rangeEndAt,
      now
    });

    let deletedCount = 0;
    let completedCoverage = {
      coverageStartAt: input.rangeStartAt,
      coverageEndAt: input.rangeEndAt
    };

    await this.context.sql.begin(async (tx: any) => {
      const authority = await this.loadWriteAuthority(tx, actorUserId, access.familyId, input.personId);
      if (!authority.settings?.consented_at) {
        throw new HttpError(403, "consent_withdrawn", "HealthKit upload consent is required.");
      }
      if (authority.activeInstallationId !== input.installationId) {
        throw new HttpError(403, "installation_inactive", "Installation is not the active HealthKit installation.");
      }
      if (authority.settings.health_timezone_version !== input.timezoneVersion) {
        throw new HttpError(409, "timezone_stale", "Timezone version is stale.");
      }
      if (!authority.enabledGroups.has(group)) {
        throw new HttpError(403, "group_disabled", `Group ${group} is not enabled.`);
      }

      const [state] = await tx`
        select * from healthkit_sync_state
        where person_id = ${input.personId} and group_key = ${group}
      `;
      const needsInitialImport = deriveNeedsInitialImport({
        historyImportCompletedAt: state?.history_import_completed_at ?? null,
        historyImportInstallationId: state?.history_import_installation_id ?? null,
        historyImportTimezoneVersion: state?.history_import_timezone_version ?? null,
        activeInstallationId: authority.activeInstallationId,
        healthTimezoneVersion: authority.settings.health_timezone_version
      });
      if (input.kind !== "initial_import" && needsInitialImport) {
        throw new HttpError(409, "initial_import_required", "Complete Import history before running Sync or repair for this metric.");
      }
      if (input.kind === "repair_import") {
        assertRunKindAllowed("repair_import", group, needsInitialImport);
        deletedCount = await this.reconcileRepairWindow(tx, {
          personId: input.personId,
          group,
          healthTimezone: authority.settings.health_timezone,
          timezoneVersion: input.timezoneVersion,
          rangeStartAt: input.rangeStartAt,
          rangeEndAt: input.rangeEndAt,
          presentNaturalKeys: input.presentNaturalKeys ?? []
        });
      }

      completedCoverage = unionCompletedCoverage({
        existingCoverageStartAt: state?.coverage_start_at ? toIso(state.coverage_start_at) : undefined,
        existingCoverageEndAt: state?.coverage_end_at ? toIso(state.coverage_end_at) : undefined,
        completedRangeStartAt: input.rangeStartAt,
        completedRangeEndAt: input.rangeEndAt
      });

      await this.touchGroupState(tx, {
        familyId: access.familyId,
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
    });

    await this.context.audit({
      familyId: access.familyId,
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

  async failHealthKitRun(
    actorUserId: string,
    group: HealthKitConsentGroup,
    input: FailHealthKitRunInput
  ): Promise<HealthKitRunFailResult> {
    const self = await this.context.requireSelfPerson(actorUserId);
    const access = await this.context.requirePersonAccess(actorUserId, input.personId);
    assertSelfProfileMatch({ selfProfileId: self.personId, requestedPersonId: input.personId });

    const now = new Date();
    const nowIso = toUtcIso(now);

    const result = await this.context.sql.begin(async (tx: any) => {
      const authority = await this.loadWriteAuthority(tx, actorUserId, access.familyId, input.personId);
      if (!authority.settings?.consented_at) {
        throw new HttpError(403, "consent_withdrawn", "HealthKit upload consent is required.");
      }
      if (authority.activeInstallationId !== input.installationId) {
        throw new HttpError(403, "installation_inactive", "Installation is not the active HealthKit installation.");
      }
      if (authority.settings.health_timezone_version !== input.timezoneVersion) {
        throw new HttpError(409, "timezone_stale", "Timezone version is stale.");
      }
      if (!authority.enabledGroups.has(group)) {
        throw new HttpError(403, "group_disabled", `Group ${group} is not enabled.`);
      }

      const [state] = await tx`
        select * from healthkit_sync_state
        where person_id = ${input.personId} and group_key = ${group}
      `;
      const restoredStatus: HealthMetricSyncStatusCode = state?.last_successful_at ? "ready" : "error";
      await this.touchGroupState(tx, {
        familyId: access.familyId,
        personId: input.personId,
        group,
        nowIso,
        status: restoredStatus,
        lastErrorCode: input.errorCode
      });

      const needsInitialImport = deriveNeedsInitialImport({
        historyImportCompletedAt: state?.history_import_completed_at ?? null,
        historyImportInstallationId: state?.history_import_installation_id ?? null,
        historyImportTimezoneVersion: state?.history_import_timezone_version ?? null,
        activeInstallationId: authority.activeInstallationId,
        healthTimezoneVersion: authority.settings.health_timezone_version
      });

      return {
        group,
        kind: input.kind,
        status: restoredStatus,
        lastSuccessfulAt: state?.last_successful_at ? toIso(state.last_successful_at) : undefined,
        lastErrorCode: input.errorCode,
        coverageStartAt: state?.coverage_start_at ? toIso(state.coverage_start_at) : undefined,
        coverageEndAt: state?.coverage_end_at ? toIso(state.coverage_end_at) : undefined,
        needsInitialImport
      };
    });

    await this.context.audit({
      familyId: access.familyId,
      actorUserId,
      action: "healthkit.run_fail",
      resourceType: "healthkit_sync",
      resourceId: input.personId,
      metadata: { group, kind: input.kind, error_code: input.errorCode, status: result.status }
    });

    return result;
  }

  /**
   * Repair-only missing-key reconciliation (plan §7.4): delete stored natural
   * keys inside the exact repair window that are absent from the complete
   * snapshot manifest. Records outside the window are untouched.
   */
  private async reconcileRepairWindow(
    tx: any,
    input: {
      personId: string;
      group: HealthKitConsentGroup;
      healthTimezone: string;
      timezoneVersion: number;
      rangeStartAt: string;
      rangeEndAt: string;
      presentNaturalKeys: string[];
    }
  ): Promise<number> {
    const manifest = input.presentNaturalKeys.filter((key) => typeof key === "string" && key.length <= 256);
    switch (input.group) {
      case "vitals": {
        const bpKeys = manifest.filter((key) => key.startsWith("blood_pressure:"));
        const bpRows = await tx`
          delete from health_blood_pressure_readings
          where person_id = ${input.personId}
            and measured_at >= ${input.rangeStartAt}::timestamptz
            and measured_at <= ${input.rangeEndAt}::timestamptz
            and not (('blood_pressure:' || source_sample_key::text) = any(${bpKeys}))
          returning id
        `;
        const hrKeys = manifest.filter((key) => key.startsWith("daily_metric:heart_rate:"));
        const hrRows = await tx`
          delete from health_daily_metrics
          where person_id = ${input.personId}
            and metric_key = 'heart_rate'
            and timezone_version = ${input.timezoneVersion}
            and local_day >= (${input.rangeStartAt}::timestamptz at time zone ${input.healthTimezone})::date
            and local_day <= (${input.rangeEndAt}::timestamptz at time zone ${input.healthTimezone})::date
            and not (('daily_metric:heart_rate:' || local_day::text) = any(${hrKeys}))
          returning id
        `;
        return bpRows.length + hrRows.length;
      }
      case "sleep": {
        const keys = manifest.filter((key) => key.startsWith("sleep_day:"));
        const rows = await tx`
          delete from health_sleep_days
          where person_id = ${input.personId}
            and timezone_version = ${input.timezoneVersion}
            and sleep_day >= (${input.rangeStartAt}::timestamptz at time zone ${input.healthTimezone})::date
            and sleep_day <= (${input.rangeEndAt}::timestamptz at time zone ${input.healthTimezone})::date
            and not (('sleep_day:' || sleep_day::text) = any(${keys}))
          returning id
        `;
        return rows.length;
      }
      case "workouts": {
        const keys = manifest.filter((key) => key.startsWith("workout:"));
        const rows = await tx`
          delete from health_workouts
          where person_id = ${input.personId}
            and started_at >= ${input.rangeStartAt}::timestamptz
            and started_at <= ${input.rangeEndAt}::timestamptz
            and not (('workout:' || source_sample_key::text) = any(${keys}))
          returning id
        `;
        return rows.length;
      }
      default:
        throw new HttpError(400, "run_kind_not_allowed", `Repair is not supported for group ${input.group}.`);
    }
  }

  async getHealthKitGroupStatus(
    actorUserId: string,
    group: HealthKitConsentGroup,
    personId?: string
  ): Promise<HealthKitGroupStatus> {
    const self = await this.context.requireSelfPerson(actorUserId);
    const target = personId ?? self.personId;
    await this.context.requirePersonAccess(actorUserId, target);

    const [state] = await this.context.sql`
      select * from healthkit_sync_state where person_id = ${target} and group_key = ${group}
    `;
    const [enabledRow] = await this.context.sql`
      select enabled from healthkit_sync_groups where person_id = ${target} and group_key = ${group}
    `;
    const [settings] = await this.context.sql`
      select health_timezone_version from healthkit_sync_profile_settings where person_id = ${target}
    `;
    const [active] = await this.context.sql`
      select installation_id from healthkit_sync_installations
      where person_id = ${target} and revoked_at is null
      limit 1
    `;
    return {
      personId: target,
      group,
      enabled: Boolean(enabledRow?.enabled),
      status: (state?.status as HealthMetricSyncStatusCode) ?? "never_synced",
      lastSuccessfulAt: state?.last_successful_at ? toIso(state.last_successful_at) : undefined,
      lastAttemptAt: state?.last_attempt_at ? toIso(state.last_attempt_at) : undefined,
      lastErrorCode: state?.last_error_code ?? undefined,
      coverageStartAt: state?.coverage_start_at ? toIso(state.coverage_start_at) : undefined,
      coverageEndAt: state?.coverage_end_at ? toIso(state.coverage_end_at) : undefined,
      needsInitialImport: deriveNeedsInitialImport({
        historyImportCompletedAt: state?.history_import_completed_at ?? null,
        historyImportInstallationId: state?.history_import_installation_id ?? null,
        historyImportTimezoneVersion: state?.history_import_timezone_version ?? null,
        activeInstallationId: active?.installation_id ?? null,
        healthTimezoneVersion: settings?.health_timezone_version ?? 1
      }),
      historyImportCompletedAt: state?.history_import_completed_at
        ? toIso(state.history_import_completed_at)
        : undefined
    };
  }

  async getHealthMetricFreshness(
    actorUserId: string,
    personId: string,
    healthMetric: HealthKitMetricKey
  ): Promise<HealthMetricFreshness> {
    await this.context.requirePersonAccess(actorUserId, personId);
    const group = HEALTHKIT_METRIC_REGISTRY[healthMetric].group;
    const [settings] = await this.context.sql`
      select * from healthkit_sync_profile_settings where person_id = ${personId}
    `;
    const [state] = await this.context.sql`
      select * from healthkit_sync_state where person_id = ${personId} and group_key = ${group}
    `;
    return {
      healthMetric,
      group,
      healthTimezone: settings?.health_timezone ?? "UTC",
      healthTimezoneVersion: settings?.health_timezone_version ?? 1,
      lastSuccessfulAt: state?.last_successful_at ? toIso(state.last_successful_at) : undefined,
      status: (state?.status as HealthMetricSyncStatusCode) ?? "never_synced",
      coverageStartAt: state?.coverage_start_at ? toIso(state.coverage_start_at) : undefined,
      coverageEndAt: state?.coverage_end_at ? toIso(state.coverage_end_at) : undefined
    };
  }

  async listStepHours(
    actorUserId: string,
    personId: string,
    rangeStartUtc: string,
    rangeEndUtc: string
  ): Promise<HealthStepHourRecord[]> {
    const access = await this.context.requirePersonAccess(actorUserId, personId);
    const rows = await this.context.sql`
      select person_id, hour_start_utc, count
      from health_step_hours
      where person_id = ${personId}
        and hour_start_utc >= ${rangeStartUtc}::timestamptz
        and hour_start_utc < ${rangeEndUtc}::timestamptz
      order by hour_start_utc asc
    `;
    return rows.map((row: Row) => ({
      personId: row.person_id,
      hourStartUtc: toIso(row.hour_start_utc),
      count: row.count
    }));
  }

  async listSleepDays(
    actorUserId: string,
    personId: string,
    rangeStartDay: string,
    rangeEndDay: string
  ): Promise<HealthSleepDayRecord[]> {
    const access = await this.context.requirePersonAccess(actorUserId, personId);
    const [settings] = await this.context.sql`
      select health_timezone_version from healthkit_sync_profile_settings where person_id = ${personId}
    `;
    const currentVersion = settings?.health_timezone_version ?? 1;
    const rows = await this.context.sql`
      select distinct on (sleep_day)
        person_id, sleep_day, timezone_version, total_minutes, core_minutes,
        deep_minutes, rem_minutes, unspecified_asleep_minutes, awake_minutes,
        in_bed_minutes, wrist_temperature_celsius, breathing_disturbance_count
      from health_sleep_days
      where person_id = ${personId}
        and sleep_day >= ${rangeStartDay}::date
        and sleep_day <= ${rangeEndDay}::date
      order by sleep_day asc, timezone_version desc
    `;
    return rows.map((row: Row) => ({
      personId: row.person_id,
      sleepDay: toDateString(row.sleep_day) ?? String(row.sleep_day).slice(0, 10),
      timezoneVersion: row.timezone_version ?? currentVersion,
      totalMinutes: Number(row.total_minutes),
      coreMinutes: Number(row.core_minutes),
      deepMinutes: Number(row.deep_minutes),
      remMinutes: Number(row.rem_minutes),
      unspecifiedAsleepMinutes: Number(row.unspecified_asleep_minutes),
      awakeMinutes: Number(row.awake_minutes),
      inBedMinutes: Number(row.in_bed_minutes),
      wristTemperatureCelsius: row.wrist_temperature_celsius === null ? undefined : Number(row.wrist_temperature_celsius),
      breathingDisturbanceCount: row.breathing_disturbance_count ?? undefined
    }));
  }

  async listHealthKitBloodPressure(
    actorUserId: string,
    personId: string,
    rangeStartUtc: string,
    rangeEndUtc: string,
    limit: number
  ): Promise<BloodPressureReading[]> {
    const access = await this.context.requirePersonAccess(actorUserId, personId);
    const rows = await this.context.sql`
      select r.*, s.user_id as recorded_by_user_id, 'healthkit'::text as source
      from health_blood_pressure_readings r
      join healthkit_sync_profile_settings s on s.person_id = r.person_id
      where r.person_id = ${personId}
        and r.measured_at >= ${rangeStartUtc}::timestamptz
        and r.measured_at <= ${rangeEndUtc}::timestamptz
      order by r.measured_at asc
      limit ${limit}
    `;
    return rows.map(mapBloodPressure);
  }

  async listDailyMetrics(
    actorUserId: string,
    personId: string,
    healthMetric: HealthKitMetricKey,
    rangeStartDay: string,
    rangeEndDay: string
  ): Promise<HealthDailyMetricRecord[]> {
    const definition = HEALTHKIT_METRIC_REGISTRY[healthMetric];
    if (definition.storage !== "daily_numeric") {
      throw new HttpError(400, "payload_invalid", "The requested metric is not stored as a daily aggregate.");
    }
    const access = await this.context.requirePersonAccess(actorUserId, personId);
    const [settings] = await this.context.sql`
      select health_timezone_version
      from healthkit_sync_profile_settings
      where person_id = ${personId}
    `;
    const timezoneVersion = Number(settings?.health_timezone_version ?? 1);
    const rows = await this.context.sql`
      select *
      from health_daily_metrics
      where person_id = ${personId}
        and metric_key = ${healthMetric}
        and timezone_version = ${timezoneVersion}
        and local_day >= ${rangeStartDay}::date
        and local_day <= ${rangeEndDay}::date
      order by local_day asc
    `;
    return rows.map((row: Row) => ({
      personId: row.person_id,
      healthMetric,
      localDay: toDateString(row.local_day) ?? String(row.local_day).slice(0, 10),
      timezoneVersion: Number(row.timezone_version),
      unit: row.unit,
      sumValue: row.sum_value === null ? undefined : Number(row.sum_value),
      averageValue: row.average_value === null ? undefined : Number(row.average_value),
      minimumValue: row.minimum_value === null ? undefined : Number(row.minimum_value),
      maximumValue: row.maximum_value === null ? undefined : Number(row.maximum_value),
      latestValue: row.latest_value === null ? undefined : Number(row.latest_value),
      sampleCount: Number(row.sample_count)
    }));
  }

  async listHealthKitBloodGlucose(
    actorUserId: string,
    personId: string,
    rangeStartUtc: string,
    rangeEndUtc: string,
    limit: number
  ): Promise<BloodGlucoseReading[]> {
    await this.context.requirePersonAccess(actorUserId, personId);
    const rows = await this.context.sql`
      select r.*, s.user_id as recorded_by_user_id, 'healthkit'::text as source
      from health_blood_glucose_readings r
      join healthkit_sync_profile_settings s on s.person_id = r.person_id
      where r.person_id = ${personId}
        and r.measured_at >= ${rangeStartUtc}::timestamptz
        and r.measured_at <= ${rangeEndUtc}::timestamptz
      order by r.measured_at asc
      limit ${limit}
    `;
    return rows.map((row: Row) => mapBloodGlucose(row));
  }

  async listHealthKitWorkouts(

    actorUserId: string,
    personId: string,
    rangeStartUtc: string,
    rangeEndUtc: string,
    limit: number
  ): Promise<HealthWorkoutRecord[]> {
    await this.context.requirePersonAccess(actorUserId, personId);
    const rows = await this.context.sql`
      select *
      from health_workouts
      where person_id = ${personId}
        and started_at >= ${rangeStartUtc}::timestamptz
        and started_at <= ${rangeEndUtc}::timestamptz
      order by started_at asc
      limit ${limit}
    `;
    const logs = await this.loadExerciseLogs(
      personId,
      rows.map((row: Row) => row.source_sample_key as string)
    );
    return rows.map((row: Row) => this.mapWorkout(row, logs.get(row.source_sample_key as string)));
  }

  async putHealthKitWorkoutExercises(
    actorUserId: string,
    workoutId: string,
    exercises: HealthWorkoutExerciseWrite[]
  ): Promise<HealthWorkoutRecord> {
    const self = await this.context.requireSelfPerson(actorUserId);
    const [row] = await this.context.sql`
      select * from health_workouts where id = ${workoutId} limit 1
    `;
    if (!row) {
      throw new HttpError(404, "workout_not_found", "Workout was not found.");
    }
    await this.context.requirePersonAccess(actorUserId, row.person_id as string);
    assertSelfProfileMatch({ selfProfileId: self.personId, requestedPersonId: row.person_id as string });
    if (!isStrengthWorkoutType(row.workout_type as string)) {
      throw new HttpError(400, "workout_not_strength", "Exercise logs are only allowed on strength workouts.");
    }
    const normalized = normalizeWorkoutExercises(exercises);
    await this.context.sql.begin(async (tx: any) => {

      await tx`
        delete from health_workout_exercises
        where person_id = ${row.person_id}
          and source_sample_key = ${row.source_sample_key}
      `;
      for (const [exerciseIndex, exercise] of normalized.entries()) {
        const [inserted] = await tx`
          insert into health_workout_exercises (person_id, source_sample_key, catalog_id, position, name)
          values (
            ${row.person_id},
            ${row.source_sample_key},
            ${exercise.exerciseId},
            ${exerciseIndex},
            ${exercise.name}
          )
          returning id
        `;
        for (const [setIndex, set] of exercise.sets.entries()) {
          await tx`
            insert into health_workout_sets (exercise_id, position, reps, weight_kg)
            values (
              ${inserted.id},
              ${setIndex},
              ${set.reps},
              ${set.weightKg ?? null}
            )
          `;
        }
      }
    });
    return this.mapWorkout(row, normalized.length === 0 ? undefined : normalized);
  }

  private mapWorkout(row: Row, exercises?: HealthWorkoutExerciseLog[]): HealthWorkoutRecord {
    return {
      id: row.id,
      personId: row.person_id,
      workoutType: row.workout_type,
      startedAtUtc: toIso(row.started_at),
      endedAtUtc: toIso(row.ended_at),
      durationSeconds: Number(row.duration_seconds),
      activeEnergyKcal: row.active_energy_kcal === null ? undefined : Number(row.active_energy_kcal),
      distanceMeters: row.distance_meters === null ? undefined : Number(row.distance_meters),
      averageHeartRateBpm: row.average_heart_rate_bpm === null ? undefined : Number(row.average_heart_rate_bpm),
      maximumHeartRateBpm: row.maximum_heart_rate_bpm === null ? undefined : Number(row.maximum_heart_rate_bpm),
      minimumHeartRateBpm:
        row.minimum_heart_rate_bpm === null || row.minimum_heart_rate_bpm === undefined
          ? undefined
          : Number(row.minimum_heart_rate_bpm),
      sourceName: row.source_name ?? undefined,
      sourceBundleId: row.source_bundle_id ?? undefined,
      deviceName: row.device_name ?? undefined,
      deviceManufacturer: row.device_manufacturer ?? undefined,
      isIndoor: row.is_indoor ?? undefined,
      elevationAscendedMeters:
        row.elevation_ascended_meters === null || row.elevation_ascended_meters === undefined
          ? undefined
          : Number(row.elevation_ascended_meters),
      averageMETs: row.average_mets === null || row.average_mets === undefined ? undefined : Number(row.average_mets),
      swimmingStrokeCount: row.swimming_stroke_count ?? undefined,
      totalFlightsClimbed: row.total_flights_climbed ?? undefined,
      events: Array.isArray(row.events_json) ? row.events_json : undefined,
      activities: Array.isArray(row.activities_json) ? row.activities_json : undefined,
      exercises
    };
  }

  private async loadExerciseLogs(
    personId: string,
    sourceSampleKeys: string[]
  ): Promise<Map<string, HealthWorkoutExerciseLog[]>> {
    const logs = new Map<string, HealthWorkoutExerciseLog[]>();
    if (sourceSampleKeys.length === 0) return logs;
    const rows = await this.context.sql`
      select
        e.source_sample_key,
        e.position as exercise_position,
        e.catalog_id,
        e.name,
        s.position as set_position,
        s.reps,
        s.weight_kg
      from health_workout_exercises e
      join health_workout_sets s on s.exercise_id = e.id
      where e.person_id = ${personId}
        and e.source_sample_key = any(${sourceSampleKeys}::uuid[])
      order by e.position asc, s.position asc
    `;
    const byExercise = new Map<string, HealthWorkoutExerciseLog>();
    for (const row of rows) {
      const exerciseKey = `${row.source_sample_key}:${row.exercise_position}`;
      let exercise = byExercise.get(exerciseKey);
      if (!exercise) {
        exercise = {
          exerciseId: row.catalog_id as string,
          name: row.name as string,
          sets: []
        };
        byExercise.set(exerciseKey, exercise);
        const sampleKey = row.source_sample_key as string;
        const list = logs.get(sampleKey) ?? [];
        list.push(exercise);
        logs.set(sampleKey, list);
      }
      exercise.sets.push({
        reps: Number(row.reps),
        weightKg: row.weight_kg === null || row.weight_kg === undefined ? undefined : Number(row.weight_kg)
      });
    }
    return logs;
  }


  private async applyOneOp(
    tx: any,
    input: {
      familyId: string | null;
      personId: string;
      timezoneVersion: number;
      op: HealthKitSyncOp;
      nowIso: string;
    }
  ): Promise<HealthKitOpApplyResult> {
    const { op } = input;
    const [existing] = await tx`
      select op_id from healthkit_op_receipts where op_id = ${op.opId}
    `;
    if (existing) {
      return { opId: op.opId, result: "duplicate" };
    }

    if (op.payload) {
      await this.applyCanonical(tx, {
        familyId: input.familyId,
        personId: input.personId,
        timezoneVersion: input.timezoneVersion,
        payload: op.payload,
        nowIso: input.nowIso
      });
    }

    await tx`
      insert into healthkit_op_receipts (op_id, person_id, family_id, applied_at)
      values (${op.opId}, ${input.personId}, ${input.familyId}, ${input.nowIso})
    `;
    return { opId: op.opId, result: "applied" };
  }



  private async applyCanonical(
    tx: any,
    input: {
      familyId: string | null;
      personId: string;
      timezoneVersion: number;
      payload: HealthKitOpPayload;
      nowIso: string;
    }
  ) {
    const payload = input.payload;
    switch (payload.kind) {
      case "steps_hour":
        await tx`
          insert into health_step_hours (family_id, person_id, hour_start_utc, count, updated_at)
          values (${input.familyId}, ${input.personId}, ${payload.hourStartUtc}, ${payload.count}, ${input.nowIso})
          on conflict (person_id, hour_start_utc) do update set
            count = excluded.count, updated_at = excluded.updated_at
        `;
        return;
      case "sleep_day":
        await tx`
          insert into health_sleep_days (
            family_id, person_id, sleep_day, timezone_version, total_minutes, core_minutes,
            deep_minutes, rem_minutes, unspecified_asleep_minutes, awake_minutes, in_bed_minutes,
            wrist_temperature_celsius, breathing_disturbance_count, updated_at
          ) values (
            ${input.familyId}, ${input.personId}, ${payload.sleepDay}, ${input.timezoneVersion},
            ${payload.totalMinutes}, ${payload.coreMinutes}, ${payload.deepMinutes}, ${payload.remMinutes},
            ${payload.unspecifiedAsleepMinutes}, ${payload.awakeMinutes}, ${payload.inBedMinutes},
            ${payload.wristTemperatureCelsius ?? null}, ${payload.breathingDisturbanceCount ?? null}, ${input.nowIso}
          )
          on conflict (person_id, sleep_day, timezone_version) do update set
            total_minutes = excluded.total_minutes, core_minutes = excluded.core_minutes,
            deep_minutes = excluded.deep_minutes, rem_minutes = excluded.rem_minutes,
            unspecified_asleep_minutes = excluded.unspecified_asleep_minutes,
            awake_minutes = excluded.awake_minutes, in_bed_minutes = excluded.in_bed_minutes,
            wrist_temperature_celsius = excluded.wrist_temperature_celsius,
            breathing_disturbance_count = excluded.breathing_disturbance_count,
            updated_at = excluded.updated_at
        `;
        return;
      case "daily_metric":
        await tx`
          insert into health_daily_metrics (
            family_id, person_id, metric_key, local_day, timezone_version, unit,
            sum_value, average_value, minimum_value, maximum_value, latest_value, sample_count, updated_at
          ) values (
            ${input.familyId}, ${input.personId}, ${payload.healthMetric}, ${payload.localDay},
            ${input.timezoneVersion}, ${HEALTHKIT_METRIC_REGISTRY[payload.healthMetric].unit},
            ${payload.sumValue ?? null}, ${payload.averageValue ?? null}, ${payload.minimumValue ?? null},
            ${payload.maximumValue ?? null}, ${payload.latestValue ?? null}, ${payload.sampleCount}, ${input.nowIso}
          )
          on conflict (person_id, metric_key, local_day, timezone_version) do update set
            unit = excluded.unit, sum_value = excluded.sum_value, average_value = excluded.average_value,
            minimum_value = excluded.minimum_value, maximum_value = excluded.maximum_value,
            latest_value = excluded.latest_value, sample_count = excluded.sample_count,
            updated_at = excluded.updated_at
        `;
        return;
      case "blood_pressure":
        await tx`
          insert into health_blood_pressure_readings (
            family_id, person_id, source_sample_key, measured_at, systolic, diastolic, pulse, updated_at
          ) values (
            ${input.familyId}, ${input.personId}, ${payload.sourceObjectKey}, ${payload.measuredAtUtc},
            ${payload.systolic}, ${payload.diastolic}, ${payload.pulse ?? null}, ${input.nowIso}
          )
          on conflict (person_id, source_sample_key) do update set
            measured_at = excluded.measured_at, systolic = excluded.systolic,
            diastolic = excluded.diastolic, pulse = excluded.pulse, updated_at = excluded.updated_at
        `;
        return;
      case "blood_glucose":
        await tx`
          insert into health_blood_glucose_readings (
            family_id, person_id, source_sample_key, measured_at, value_mg_dl, updated_at
          ) values (
            ${input.familyId}, ${input.personId}, ${payload.sourceSampleKey}, ${payload.measuredAtUtc},
            ${payload.valueMgDl}, ${input.nowIso}
          )
          on conflict (person_id, source_sample_key) do update set
            measured_at = excluded.measured_at, value_mg_dl = excluded.value_mg_dl, updated_at = excluded.updated_at
        `;
        return;
      case "workout":
        await tx`
          insert into health_workouts (
            family_id, person_id, source_sample_key, workout_type, started_at, ended_at,
            duration_seconds, active_energy_kcal, distance_meters, average_heart_rate_bpm,
            maximum_heart_rate_bpm, minimum_heart_rate_bpm, source_name, source_bundle_id,
            device_name, device_manufacturer, is_indoor, elevation_ascended_meters, average_mets,
            swimming_stroke_count, total_flights_climbed, events_json, activities_json, updated_at
          ) values (
            ${input.familyId}, ${input.personId}, ${payload.sourceSampleKey}, ${payload.workoutType},
            ${payload.startedAtUtc}, ${payload.endedAtUtc}, ${payload.durationSeconds},
            ${payload.activeEnergyKcal ?? null}, ${payload.distanceMeters ?? null},
            ${payload.averageHeartRateBpm ?? null}, ${payload.maximumHeartRateBpm ?? null},
            ${payload.minimumHeartRateBpm ?? null}, ${payload.sourceName ?? null},
            ${payload.sourceBundleId ?? null}, ${payload.deviceName ?? null},
            ${payload.deviceManufacturer ?? null}, ${payload.isIndoor ?? null},
            ${payload.elevationAscendedMeters ?? null}, ${payload.averageMETs ?? null},
            ${payload.swimmingStrokeCount ?? null}, ${payload.totalFlightsClimbed ?? null},
            ${payload.events ?? null},
            ${payload.activities ?? null},
            ${input.nowIso}
          )
          on conflict (person_id, source_sample_key) do update set
            workout_type = excluded.workout_type, started_at = excluded.started_at, ended_at = excluded.ended_at,
            duration_seconds = excluded.duration_seconds, active_energy_kcal = excluded.active_energy_kcal,
            distance_meters = excluded.distance_meters, average_heart_rate_bpm = excluded.average_heart_rate_bpm,
            maximum_heart_rate_bpm = excluded.maximum_heart_rate_bpm,
            minimum_heart_rate_bpm = excluded.minimum_heart_rate_bpm,
            source_name = excluded.source_name, source_bundle_id = excluded.source_bundle_id,
            device_name = excluded.device_name, device_manufacturer = excluded.device_manufacturer,
            is_indoor = excluded.is_indoor, elevation_ascended_meters = excluded.elevation_ascended_meters,
            average_mets = excluded.average_mets, swimming_stroke_count = excluded.swimming_stroke_count,
            total_flights_climbed = excluded.total_flights_climbed,
            events_json = excluded.events_json, activities_json = excluded.activities_json,
            updated_at = excluded.updated_at
        `;
        return;
    }
  }


  private async loadSettings(actorUserId: string, familyId: string | null, personId: string): Promise<HealthKitSettings> {
    const [settings] = await this.context.sql`
      select * from healthkit_sync_profile_settings where person_id = ${personId}
    `;
    const metricRows = await this.context.sql`
      select * from healthkit_sync_groups where person_id = ${personId}
    `;
    const stateRows = await this.context.sql`
      select * from healthkit_sync_state where person_id = ${personId}
    `;
    const [active] = await this.context.sql`
      select installation_id from healthkit_sync_installations
      where person_id = ${personId} and revoked_at is null
      limit 1
    `;
    const enabledGroups = metricRows.filter((r: Row) => r.enabled).map((r: Row) => r.group_key as HealthKitMetric);
    const stateByGroup = new Map(stateRows.map((r: Row) => [r.group_key as HealthKitMetric, r]));
    const timezoneVersion = settings?.health_timezone_version ?? 1;
    const groups = HEALTHKIT_METRICS.map((group) => {
      const state = stateByGroup.get(group) as Row | undefined;
      const enabled = enabledGroups.includes(group);
      return {
        group,
        enabled,
        lastSuccessfulAt: state?.last_successful_at ? toIso(state.last_successful_at) : undefined,
        lastAttemptAt: state?.last_attempt_at ? toIso(state.last_attempt_at) : undefined,
        lastErrorCode: state?.last_error_code ?? undefined,
        coverageStartAt: state?.coverage_start_at ? toIso(state.coverage_start_at) : undefined,
        coverageEndAt: state?.coverage_end_at ? toIso(state.coverage_end_at) : undefined,
        status: (state?.status as HealthMetricSyncStatusCode) ?? (enabled ? "never_synced" : "disabled"),
        needsInitialImport: deriveNeedsInitialImport({
          historyImportCompletedAt: state?.history_import_completed_at ?? null,
          historyImportInstallationId: state?.history_import_installation_id ?? null,
          historyImportTimezoneVersion: state?.history_import_timezone_version ?? null,
          activeInstallationId: active?.installation_id ?? null,
          healthTimezoneVersion: timezoneVersion
        }),
        historyImportCompletedAt: state?.history_import_completed_at
          ? toIso(state.history_import_completed_at)
          : undefined
      };
    });
    return {
      personId,
      consentVersion: settings?.consent_version ?? undefined,
      consentedAt: settings?.consented_at ? toIso(settings.consented_at) : undefined,
      healthTimezone: settings?.health_timezone ?? "UTC",
      healthTimezoneVersion: settings?.health_timezone_version ?? 1,
      enabledGroups,
      activeInstallationId: active?.installation_id,
      groups
    };
  }

  private async loadWriteAuthority(tx: any, actorUserId: string, familyId: string | null, personId: string) {
    const [settings] = await tx`
      select * from healthkit_sync_profile_settings
      where person_id = ${personId} and user_id = ${actorUserId}
    `;
    const metricRows = await tx`
      select group_key from healthkit_sync_groups
      where person_id = ${personId} and enabled = true
    `;
    const [active] = await tx`
      select installation_id from healthkit_sync_installations
      where person_id = ${personId} and revoked_at is null
      limit 1
    `;
    return {
      settings,
      enabledGroups: new Set(metricRows.map((r: Row) => r.group_key as HealthKitMetric)),
      activeInstallationId: active?.installation_id as string | undefined
    };
  }

  private async touchGroupState(
    tx: any,
    input: {
      familyId: string | null;
      personId: string;
      group: HealthKitMetric;
      nowIso: string;
      status?: HealthMetricSyncStatusCode;
      success?: boolean;
      coverageStartAt?: string;
      coverageEndAt?: string;
      lastErrorCode?: string;
      /** Set on completed history imports; undefined leaves the marker intact. */
      historyMarker?: {
        completedAt: string;
        installationId: string;
        timezoneVersion: number;
      };
    }
  ) {
    const [existing] = await tx`
      select * from healthkit_sync_state where person_id = ${input.personId} and group_key = ${input.group}
    `;
    const status: HealthMetricSyncStatusCode =
      input.status ?? (existing?.status as HealthMetricSyncStatusCode) ?? "never_synced";

    const success = Boolean(input.success);
    const lastSuccessfulAt = success ? input.nowIso : (existing?.last_successful_at ?? null);
    const lastErrorCode =
      input.lastErrorCode ?? (success ? null : (existing?.last_error_code ?? null));
    const coverageStartAt = input.coverageStartAt ?? existing?.coverage_start_at ?? null;
    const coverageEndAt = input.coverageEndAt ?? existing?.coverage_end_at ?? null;
    const explicitError = input.lastErrorCode ?? null;
    const marker = input.historyMarker;

    await tx`
      insert into healthkit_sync_state (
        person_id, family_id, group_key, last_successful_at, last_attempt_at, last_error_code,
        coverage_start_at, coverage_end_at,
        history_import_completed_at, history_import_installation_id, history_import_timezone_version,
        status, updated_at
      ) values (
        ${input.personId},
        ${input.familyId},
        ${input.group},
        ${lastSuccessfulAt},
        ${input.nowIso},
        ${lastErrorCode},
        ${coverageStartAt},
        ${coverageEndAt},
        ${marker?.completedAt ?? null},
        ${marker?.installationId ?? null},
        ${marker?.timezoneVersion ?? null},
        ${status},
        ${input.nowIso}
      )
      on conflict (person_id, group_key) do update set
        last_successful_at = case when ${success} then ${input.nowIso}::timestamptz else healthkit_sync_state.last_successful_at end,
        last_attempt_at = ${input.nowIso}::timestamptz,
        last_error_code = case
          when ${explicitError !== null} then ${explicitError}
          when ${success} then null
          else healthkit_sync_state.last_error_code
        end,
        coverage_start_at = coalesce(${coverageStartAt}::timestamptz, healthkit_sync_state.coverage_start_at),
        coverage_end_at = coalesce(${coverageEndAt}::timestamptz, healthkit_sync_state.coverage_end_at),
        history_import_completed_at = coalesce(${marker?.completedAt ?? null}::timestamptz, healthkit_sync_state.history_import_completed_at),
        history_import_installation_id = coalesce(${marker?.installationId ?? null}::uuid, healthkit_sync_state.history_import_installation_id),
        history_import_timezone_version = coalesce(${marker?.timezoneVersion ?? null}::integer, healthkit_sync_state.history_import_timezone_version),
        status = ${status},
        updated_at = ${input.nowIso}::timestamptz
    `;
  }

}
