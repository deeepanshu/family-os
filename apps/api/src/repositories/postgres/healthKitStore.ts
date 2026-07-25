import type {
  BloodPressureReading,
  CompleteHealthKitRepairInput,
  CreateHealthKitRepairInput,
  HealthKitMetric,
  HealthKitRepair,
  HealthKitRepairCompleteResult,
  HealthKitSettings,
  HealthKitSyncInput,
  HealthKitSyncOperation,
  HealthKitSyncResult,
  HealthMetricFreshness,
  HealthMetricSyncStatusCode,
  HealthSleepDayRecord,
  HealthStepHourRecord,
  PutHealthKitSettingsInput
} from "@family-os/shared";
import { HttpError } from "../../errors";
import {
  assertSelfProfileMatch,
  buildSyncResult,
  HEALTHKIT_METRICS,
  metricForOperation,
  metricsAffected,
  REPAIR_TTL_MS,
  REPAIR_WINDOW_MS,
  toUtcIso
} from "../healthKitDomain";
import { PostgresRepositoryContext } from "./context";
import { toIso, toOptionalIso } from "./dateUtils";
import { mapBloodPressure } from "./mappers";
import type { Row } from "./types";

export class PostgresHealthKitStore {
  constructor(private readonly context: PostgresRepositoryContext) {}

  async getHealthKitSettings(actorUserId: string, personId?: string): Promise<HealthKitSettings> {
    const current = await this.context.requireActiveMember(actorUserId);
    const selfId = await this.requireLinkedSelfProfileId(actorUserId, current.family.id);
    const targetPersonId = personId ?? selfId;
    assertSelfProfileMatch({ selfProfileId: selfId, requestedPersonId: targetPersonId });
    return this.loadSettings(actorUserId, current.family.id, targetPersonId);
  }

  async putHealthKitSettings(actorUserId: string, input: PutHealthKitSettingsInput): Promise<HealthKitSettings> {
    const current = await this.context.requireActiveMember(actorUserId);
    const selfId = await this.requireLinkedSelfProfileId(actorUserId, current.family.id);
    assertSelfProfileMatch({ selfProfileId: selfId, requestedPersonId: input.personId });

    const uniqueMetrics = [...new Set(input.enabledMetrics)].filter((m): m is HealthKitMetric =>
      (HEALTHKIT_METRICS as readonly string[]).includes(m)
    );
    const now = new Date();
    const nowIso = toUtcIso(now);

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

      const consentActive = uniqueMetrics.length > 0;
      if (consentActive && !input.consentVersion) {
        throw new HttpError(400, "healthkit_consent_required", "consentVersion is required when enabling metrics.");
      }

      await tx`
        insert into healthkit_sync_profile_settings (
          person_id, family_id, user_id, consent_version, consented_at,
          health_timezone, health_timezone_version, updated_at
        ) values (
          ${input.personId},
          ${current.family.id},
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
            "healthkit_installation_inactive",
            "Replacing the active installation requires replaceActiveInstallation=true."
          );
        }
        await tx`
          update healthkit_sync_installations
          set revoked_at = ${nowIso}
          where person_id = ${input.personId} and revoked_at is null
        `;
      }
      if (!activeInstall || activeInstall.installation_id !== input.installationId) {
        await tx`
          insert into healthkit_sync_installations (person_id, family_id, installation_id, activated_at)
          values (${input.personId}, ${current.family.id}, ${input.installationId}, ${nowIso})
          on conflict (person_id, installation_id) do update set
            revoked_at = null,
            activated_at = ${nowIso}
        `;
      }

      for (const metric of HEALTHKIT_METRICS) {
        const enabled = uniqueMetrics.includes(metric);
        await tx`
          insert into healthkit_sync_metrics (person_id, family_id, metric, enabled, updated_at)
          values (${input.personId}, ${current.family.id}, ${metric}, ${enabled}, ${nowIso})
          on conflict (person_id, metric) do update set enabled = excluded.enabled, updated_at = excluded.updated_at
        `;

        const [state] = await tx`
          select * from health_metric_sync_state where person_id = ${input.personId} and metric = ${metric}
        `;
        let status: HealthMetricSyncStatusCode = enabled ? (state?.status ?? "never_synced") : "disabled";
        if (!enabled) status = "disabled";
        else if (timezoneChanged) status = "repair_needed";
        else if (state?.status === "disabled") status = "never_synced";

        await tx`
          insert into health_metric_sync_state (
            person_id, family_id, metric, status, last_successful_at, last_attempt_at,
            last_error_code, coverage_start_at, coverage_end_at, updated_at
          ) values (
            ${input.personId}, ${current.family.id}, ${metric}, ${status},
            ${state?.last_successful_at ?? null}, ${state?.last_attempt_at ?? null},
            ${state?.last_error_code ?? null}, ${state?.coverage_start_at ?? null},
            ${state?.coverage_end_at ?? null}, ${nowIso}
          )
          on conflict (person_id, metric) do update set
            status = excluded.status,
            updated_at = excluded.updated_at
        `;
      }
    });

    await this.context.audit({
      familyId: current.family.id,
      actorUserId,
      action: "healthkit.settings_updated",
      resourceType: "health_profile",
      resourceId: input.personId,
      metadata: {
        enabledMetrics: uniqueMetrics,
        healthTimezone: input.healthTimezone,
        installationReplaced: Boolean(input.replaceActiveInstallation)
      }
    });

    return this.loadSettings(actorUserId, current.family.id, input.personId);
  }

  async syncHealthKit(actorUserId: string, input: HealthKitSyncInput): Promise<HealthKitSyncResult> {
    const current = await this.context.requireActiveMember(actorUserId);
    const selfId = await this.requireLinkedSelfProfileId(actorUserId, current.family.id);
    assertSelfProfileMatch({ selfProfileId: selfId, requestedPersonId: input.personId });

    const [receipt] = await this.context.sql`
      select response_json from healthkit_sync_receipts
      where user_id = ${actorUserId} and person_id = ${input.personId} and sync_id = ${input.syncId}
    `;
    if (receipt) {
      return receipt.response_json as HealthKitSyncResult;
    }

    const now = new Date();
    const nowIso = toUtcIso(now);
    const affected = metricsAffected(input.operations);

    try {
      const result = await this.context.sql.begin(async (tx: any) => {
        const authority = await this.loadWriteAuthority(tx, actorUserId, current.family.id, input.personId);
        if (!authority.settings?.consented_at) {
          throw new HttpError(403, "healthkit_consent_required", "HealthKit upload consent is required.");
        }
        if (authority.activeInstallationId !== input.installationId) {
          throw new HttpError(403, "healthkit_installation_inactive", "Installation is not the active HealthKit installation.");
        }
        if (authority.settings.health_timezone_version !== input.timezoneVersion) {
          throw new HttpError(409, "healthkit_timezone_version_invalid", "Timezone version is stale.");
        }

        let repair: Row | undefined;
        if (input.repairId !== undefined) {
          if (input.chunkIndex === undefined) {
            throw new HttpError(400, "healthkit_repair_invalid", "chunkIndex is required with repairId.");
          }
          const [chunk] = await tx`
            select response_json from healthkit_repair_chunks
            where repair_id = ${input.repairId} and chunk_index = ${input.chunkIndex}
          `;
          if (chunk) {
            return chunk.response_json as HealthKitSyncResult;
          }
          const [row] = await tx`
            select * from healthkit_repairs where repair_id = ${input.repairId}
          `;
          if (!row || row.person_id !== input.personId) {
            throw new HttpError(400, "healthkit_repair_invalid", "Repair session is invalid.");
          }
          if (row.completed_at || Date.parse(String(row.expires_at)) <= now.getTime()) {
            throw new HttpError(400, "healthkit_repair_invalid", "Repair session is expired or already completed.");
          }
          if (row.installation_id !== input.installationId) {
            throw new HttpError(400, "healthkit_repair_invalid", "Repair does not belong to this installation.");
          }
          if (row.timezone_version !== input.timezoneVersion) {
            throw new HttpError(409, "healthkit_timezone_version_invalid", "Timezone version is stale.");
          }
          if (affected.length !== 1 || affected[0] !== row.metric) {
            throw new HttpError(400, "healthkit_repair_invalid", "Repair chunks may only include the repair metric.");
          }
          repair = row;
        }

        for (const metric of affected) {
          if (!authority.enabledMetrics.has(metric)) {
            throw new HttpError(403, "healthkit_metric_disabled", `Metric ${metric} is not enabled.`);
          }
        }

        await this.applyOperations(tx, {
          familyId: current.family.id,
          personId: input.personId,
          actorUserId,
          timezoneVersion: input.timezoneVersion,
          operations: input.operations,
          nowIso
        });

        for (const metric of affected) {
          await this.touchMetricState(tx, {
            familyId: current.family.id,
            personId: input.personId,
            metric,
            nowIso,
            success: true,
            repairing: Boolean(repair),
            coverageStartAt: repair ? toIso(repair.range_start) : undefined,
            coverageEndAt: repair ? toIso(repair.range_end) : undefined
          });
        }

        const result = buildSyncResult({
          syncId: input.syncId,
          operationCount: input.operations.length,
          metricsAffected: affected,
          repairId: input.repairId,
          chunkIndex: input.chunkIndex
        });

        await tx`
          insert into healthkit_sync_receipts (user_id, person_id, family_id, sync_id, response_json)
          values (${actorUserId}, ${input.personId}, ${current.family.id}, ${input.syncId}, ${tx.json(result)})
        `;

        if (repair && input.chunkIndex !== undefined) {
          await tx`
            insert into healthkit_repair_chunks (repair_id, chunk_index, sync_id, response_json)
            values (${repair.repair_id}, ${input.chunkIndex}, ${input.syncId}, ${tx.json(result)})
          `;
        }

        return result;
      });

      await this.context.audit({
        familyId: current.family.id,
        actorUserId,
        action: "healthkit.sync_accepted",
        resourceType: "healthkit_sync",
        resourceId: input.personId,
        metadata: {
          sync_id: input.syncId,
          operation_count: input.operations.length,
          metrics: affected,
          repair_id: input.repairId,
          status: "accepted"
        }
      });

      return result;
    } catch (error) {
      if (error instanceof HttpError && error.status !== 500) {
        for (const metric of affected) {
          await this.context.sql`
            insert into health_metric_sync_state (
              person_id, family_id, metric, last_attempt_at, last_error_code, status, updated_at
            ) values (
              ${input.personId}, ${current.family.id}, ${metric}, ${nowIso}, ${error.code}, 'error', ${nowIso}
            )
            on conflict (person_id, metric) do update set
              last_attempt_at = excluded.last_attempt_at,
              last_error_code = excluded.last_error_code,
              status = case
                when health_metric_sync_state.status = 'repairing' then 'repairing'
                when health_metric_sync_state.status = 'disabled' then 'disabled'
                else 'error'
              end,
              updated_at = excluded.updated_at
          `;
        }
      }
      throw error;
    }
  }

  async createHealthKitRepair(actorUserId: string, input: CreateHealthKitRepairInput): Promise<HealthKitRepair> {
    const current = await this.context.requireActiveMember(actorUserId);
    const selfId = await this.requireLinkedSelfProfileId(actorUserId, current.family.id);
    assertSelfProfileMatch({ selfProfileId: selfId, requestedPersonId: input.personId });

    const now = new Date();
    const nowIso = toUtcIso(now);
    const rangeEnd = now;
    const rangeStart = new Date(now.getTime() - REPAIR_WINDOW_MS);
    const expiresAt = new Date(now.getTime() + REPAIR_TTL_MS);

    const repair = await this.context.sql.begin(async (tx: any) => {
      const authority = await this.loadWriteAuthority(tx, actorUserId, current.family.id, input.personId);
      if (!authority.settings?.consented_at) {
        throw new HttpError(403, "healthkit_consent_required", "HealthKit upload consent is required.");
      }
      if (authority.activeInstallationId !== input.installationId) {
        throw new HttpError(403, "healthkit_installation_inactive", "Installation is not the active HealthKit installation.");
      }
      if (authority.settings.health_timezone_version !== input.timezoneVersion) {
        throw new HttpError(409, "healthkit_timezone_version_invalid", "Timezone version is stale.");
      }
      if (!authority.enabledMetrics.has(input.metric)) {
        throw new HttpError(403, "healthkit_metric_disabled", `Metric ${input.metric} is not enabled.`);
      }

      await tx`
        update healthkit_repairs
        set expires_at = ${nowIso}
        where person_id = ${input.personId}
          and metric = ${input.metric}
          and completed_at is null
          and expires_at > ${nowIso}
      `;

      const [row] = await tx`
        insert into healthkit_repairs (
          person_id, family_id, metric, installation_id, timezone_version,
          range_start, range_end, expires_at
        ) values (
          ${input.personId}, ${current.family.id}, ${input.metric}, ${input.installationId},
          ${input.timezoneVersion}, ${toUtcIso(rangeStart)}, ${toUtcIso(rangeEnd)}, ${toUtcIso(expiresAt)}
        )
        returning *
      `;

      await this.touchMetricState(tx, {
        familyId: current.family.id,
        personId: input.personId,
        metric: input.metric,
        nowIso,
        success: false,
        repairing: true
      });

      return row;
    });

    await this.context.audit({
      familyId: current.family.id,
      actorUserId,
      action: "healthkit.repair_created",
      resourceType: "healthkit_repair",
      resourceId: repair.repair_id,
      metadata: { metric: input.metric, status: "created" }
    });

    return {
      repairId: repair.repair_id,
      personId: repair.person_id,
      metric: repair.metric,
      installationId: repair.installation_id,
      timezoneVersion: repair.timezone_version,
      rangeStart: toIso(repair.range_start),
      rangeEnd: toIso(repair.range_end),
      expiresAt: toIso(repair.expires_at)
    };
  }

  async completeHealthKitRepair(
    actorUserId: string,
    repairId: string,
    input: CompleteHealthKitRepairInput
  ): Promise<HealthKitRepairCompleteResult> {
    const current = await this.context.requireActiveMember(actorUserId);
    const selfId = await this.requireLinkedSelfProfileId(actorUserId, current.family.id);
    const nowIso = toUtcIso(new Date());

    const result = await this.context.sql.begin(async (tx: any) => {
      const [repair] = await tx`select * from healthkit_repairs where repair_id = ${repairId}`;
      if (!repair || repair.person_id !== selfId) {
        throw new HttpError(400, "healthkit_repair_invalid", "Repair session is invalid.");
      }
      if (repair.completed_at) {
        return {
          repairId,
          metric: repair.metric as HealthKitMetric,
          completed: true as const,
          expectedChunkCount: repair.expected_chunk_count ?? input.expectedChunkCount,
          completedChunkCount: repair.expected_chunk_count ?? input.expectedChunkCount
        };
      }
      if (Date.parse(String(repair.expires_at)) <= Date.now()) {
        throw new HttpError(400, "healthkit_repair_invalid", "Repair session is expired.");
      }

      const authority = await this.loadWriteAuthority(tx, actorUserId, current.family.id, selfId);
      if (authority.activeInstallationId !== repair.installation_id) {
        throw new HttpError(403, "healthkit_installation_inactive", "Installation is not the active HealthKit installation.");
      }

      const chunks = await tx`
        select chunk_index from healthkit_repair_chunks
        where repair_id = ${repairId}
        order by chunk_index asc
      `;
      if (chunks.length !== input.expectedChunkCount) {
        throw new HttpError(409, "healthkit_repair_incomplete", "Not all repair chunks are complete.");
      }
      for (let i = 0; i < input.expectedChunkCount; i += 1) {
        if (!chunks.some((c: Row) => c.chunk_index === i)) {
          throw new HttpError(409, "healthkit_repair_incomplete", "Not all repair chunks are complete.");
        }
      }

      if (repair.metric === "sleep") {
        const rangeStartDay = toIso(repair.range_start).slice(0, 10);
        const rangeEndDay = toIso(repair.range_end).slice(0, 10);
        await tx`
          delete from health_sleep_days
          where person_id = ${selfId}
            and timezone_version < ${repair.timezone_version}
            and sleep_day >= ${rangeStartDay}::date
            and sleep_day <= ${rangeEndDay}::date
        `;
      }

      await tx`
        update healthkit_repairs
        set expected_chunk_count = ${input.expectedChunkCount}, completed_at = ${nowIso}
        where repair_id = ${repairId}
      `;

      await tx`
        update health_metric_sync_state
        set
          status = 'ready',
          last_successful_at = ${nowIso},
          last_attempt_at = ${nowIso},
          last_error_code = null,
          coverage_start_at = ${toIso(repair.range_start)},
          coverage_end_at = ${toIso(repair.range_end)},
          updated_at = ${nowIso}
        where person_id = ${selfId} and metric = ${repair.metric}
      `;

      return {
        repairId,
        metric: repair.metric as HealthKitMetric,
        completed: true as const,
        expectedChunkCount: input.expectedChunkCount,
        completedChunkCount: input.expectedChunkCount
      };
    });

    await this.context.audit({
      familyId: current.family.id,
      actorUserId,
      action: "healthkit.repair_completed",
      resourceType: "healthkit_repair",
      resourceId: repairId,
      metadata: {
        metric: result.metric,
        expected_chunk_count: result.expectedChunkCount,
        status: "completed"
      }
    });

    return result;
  }

  async getHealthMetricFreshness(
    actorUserId: string,
    personId: string,
    metric: HealthKitMetric
  ): Promise<HealthMetricFreshness> {
    const current = await this.context.requireActiveMember(actorUserId);
    await this.context.requireProfileInFamily(personId, current.family.id);
    const [settings] = await this.context.sql`
      select * from healthkit_sync_profile_settings where person_id = ${personId}
    `;
    const [state] = await this.context.sql`
      select * from health_metric_sync_state where person_id = ${personId} and metric = ${metric}
    `;
    return {
      metric,
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
    const current = await this.context.requireActiveMember(actorUserId);
    await this.context.requireProfileInFamily(personId, current.family.id);
    const rows = await this.context.sql`
      select person_id, hour_start_utc, count
      from health_step_hours
      where family_id = ${current.family.id}
        and person_id = ${personId}
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
    const current = await this.context.requireActiveMember(actorUserId);
    await this.context.requireProfileInFamily(personId, current.family.id);
    const [settings] = await this.context.sql`
      select health_timezone_version from healthkit_sync_profile_settings where person_id = ${personId}
    `;
    const currentVersion = settings?.health_timezone_version ?? 1;
    const rows = await this.context.sql`
      select distinct on (sleep_day)
        person_id, sleep_day, timezone_version, duration_minutes
      from health_sleep_days
      where family_id = ${current.family.id}
        and person_id = ${personId}
        and sleep_day >= ${rangeStartDay}::date
        and sleep_day <= ${rangeEndDay}::date
      order by sleep_day asc, timezone_version desc
    `;
    return rows.map((row: Row) => ({
      personId: row.person_id,
      sleepDay: String(row.sleep_day).slice(0, 10),
      timezoneVersion: row.timezone_version ?? currentVersion,
      durationMinutes: row.duration_minutes
    }));
  }

  async listHealthKitBloodPressure(
    actorUserId: string,
    personId: string,
    rangeStartUtc: string,
    rangeEndUtc: string,
    limit: number
  ): Promise<BloodPressureReading[]> {
    const current = await this.context.requireActiveMember(actorUserId);
    await this.context.requireProfileInFamily(personId, current.family.id);
    const rows = await this.context.sql`
      select *
      from blood_pressure_readings
      where family_id = ${current.family.id}
        and person_id = ${personId}
        and source = 'healthkit'
        and deleted_at is null
        and measured_at >= ${rangeStartUtc}::timestamptz
        and measured_at <= ${rangeEndUtc}::timestamptz
      order by measured_at asc
      limit ${limit}
    `;
    return rows.map(mapBloodPressure);
  }

  private async loadSettings(actorUserId: string, familyId: string, personId: string): Promise<HealthKitSettings> {
    const [settings] = await this.context.sql`
      select * from healthkit_sync_profile_settings where person_id = ${personId}
    `;
    const metricRows = await this.context.sql`
      select * from healthkit_sync_metrics where person_id = ${personId}
    `;
    const stateRows = await this.context.sql`
      select * from health_metric_sync_state where person_id = ${personId}
    `;
    const [active] = await this.context.sql`
      select installation_id from healthkit_sync_installations
      where person_id = ${personId} and revoked_at is null
      limit 1
    `;
    const enabledMetrics = metricRows.filter((r: Row) => r.enabled).map((r: Row) => r.metric as HealthKitMetric);
    const stateByMetric = new Map(stateRows.map((r: Row) => [r.metric as HealthKitMetric, r]));
    const metrics = HEALTHKIT_METRICS.map((metric) => {
      const state = stateByMetric.get(metric) as Row | undefined;
      const enabled = enabledMetrics.includes(metric);
      return {
        metric,
        enabled,
        lastSuccessfulAt: state?.last_successful_at ? toIso(state.last_successful_at) : undefined,
        lastAttemptAt: state?.last_attempt_at ? toIso(state.last_attempt_at) : undefined,
        lastErrorCode: state?.last_error_code ?? undefined,
        coverageStartAt: state?.coverage_start_at ? toIso(state.coverage_start_at) : undefined,
        coverageEndAt: state?.coverage_end_at ? toIso(state.coverage_end_at) : undefined,
        status: (state?.status as HealthMetricSyncStatusCode) ?? (enabled ? "never_synced" : "disabled")
      };
    });
    return {
      personId,
      consentVersion: settings?.consent_version ?? undefined,
      consentedAt: settings?.consented_at ? toIso(settings.consented_at) : undefined,
      healthTimezone: settings?.health_timezone ?? "UTC",
      healthTimezoneVersion: settings?.health_timezone_version ?? 1,
      enabledMetrics,
      activeInstallationId: active?.installation_id,
      metrics
    };
  }

  private async loadWriteAuthority(tx: any, actorUserId: string, familyId: string, personId: string) {
    const [settings] = await tx`
      select * from healthkit_sync_profile_settings
      where person_id = ${personId} and family_id = ${familyId} and user_id = ${actorUserId}
    `;
    const metricRows = await tx`
      select metric from healthkit_sync_metrics
      where person_id = ${personId} and enabled = true
    `;
    const [active] = await tx`
      select installation_id from healthkit_sync_installations
      where person_id = ${personId} and revoked_at is null
      limit 1
    `;
    return {
      settings,
      enabledMetrics: new Set(metricRows.map((r: Row) => r.metric as HealthKitMetric)),
      activeInstallationId: active?.installation_id as string | undefined
    };
  }

  private async applyOperations(
    tx: any,
    input: {
      familyId: string;
      personId: string;
      actorUserId: string;
      timezoneVersion: number;
      operations: HealthKitSyncOperation[];
      nowIso: string;
    }
  ) {
    for (const op of input.operations) {
      switch (op.kind) {
        case "steps_hour_upsert":
          await tx`
            insert into health_step_hours (family_id, person_id, hour_start_utc, count, updated_at)
            values (${input.familyId}, ${input.personId}, ${op.hourStartUtc}, ${op.count}, ${input.nowIso})
            on conflict (person_id, hour_start_utc) do update set
              count = excluded.count,
              updated_at = excluded.updated_at
          `;
          break;
        case "sleep_day_upsert":
          await tx`
            insert into health_sleep_days (
              family_id, person_id, sleep_day, timezone_version, duration_minutes, updated_at
            ) values (
              ${input.familyId}, ${input.personId}, ${op.sleepDay}::date, ${input.timezoneVersion},
              ${op.durationMinutes}, ${input.nowIso}
            )
            on conflict (person_id, sleep_day, timezone_version) do update set
              duration_minutes = excluded.duration_minutes,
              updated_at = excluded.updated_at
          `;
          break;
        case "blood_pressure_upsert":
          await tx`
            insert into blood_pressure_readings (
              family_id, person_id, recorded_by_user_id, systolic, diastolic, pulse,
              measured_at, source, source_sample_key, imported_by_user_id, imported_at
            ) values (
              ${input.familyId}, ${input.personId}, ${input.actorUserId},
              ${op.systolic}, ${op.diastolic}, ${op.pulse ?? null},
              ${op.measuredAtUtc}, 'healthkit', ${op.sourceSampleKey},
              ${input.actorUserId}, ${input.nowIso}
            )
            on conflict (person_id, source_sample_key) where source = 'healthkit' and source_sample_key is not null
            do update set
              systolic = excluded.systolic,
              diastolic = excluded.diastolic,
              pulse = excluded.pulse,
              measured_at = excluded.measured_at,
              deleted_at = null,
              updated_at = ${input.nowIso}
          `;
          break;
        case "blood_pressure_delete":
          await tx`
            delete from blood_pressure_readings
            where person_id = ${input.personId}
              and source = 'healthkit'
              and source_sample_key = ${op.sourceSampleKey}
          `;
          break;
        default: {
          const _exhaustive: never = op;
          throw new HttpError(400, "healthkit_operation_invalid", `Unknown operation ${(_exhaustive as any).kind}`);
        }
      }
    }
  }

  private async touchMetricState(
    tx: any,
    input: {
      familyId: string;
      personId: string;
      metric: HealthKitMetric;
      nowIso: string;
      success: boolean;
      repairing?: boolean;
      coverageStartAt?: string;
      coverageEndAt?: string;
    }
  ) {
    const [existing] = await tx`
      select * from health_metric_sync_state where person_id = ${input.personId} and metric = ${input.metric}
    `;
    let status: HealthMetricSyncStatusCode = existing?.status ?? "never_synced";
    if (input.repairing) {
      status = "repairing";
    } else if (input.success) {
      status = existing?.status === "ready" || existing?.coverage_start_at ? "ready" : status === "never_synced" ? "ready" : status;
      if (status === "error" || status === "repair_needed") status = "ready";
    }

    await tx`
      insert into health_metric_sync_state (
        person_id, family_id, metric, last_successful_at, last_attempt_at, last_error_code,
        coverage_start_at, coverage_end_at, status, updated_at
      ) values (
        ${input.personId},
        ${input.familyId},
        ${input.metric},
        ${input.success ? input.nowIso : existing?.last_successful_at ?? null},
        ${input.nowIso},
        ${input.success ? null : existing?.last_error_code ?? null},
        ${existing?.coverage_start_at ?? input.coverageStartAt ?? null},
        ${input.success && !input.repairing
          ? toUtcIso(new Date())
          : existing?.coverage_end_at ?? input.coverageEndAt ?? null},
        ${status},
        ${input.nowIso}
      )
      on conflict (person_id, metric) do update set
        last_successful_at = case when ${input.success} then ${input.nowIso}::timestamptz else health_metric_sync_state.last_successful_at end,
        last_attempt_at = ${input.nowIso}::timestamptz,
        last_error_code = case when ${input.success} then null else health_metric_sync_state.last_error_code end,
        coverage_end_at = case
          when ${input.success} and ${!input.repairing} then ${input.nowIso}::timestamptz
          else health_metric_sync_state.coverage_end_at
        end,
        coverage_start_at = coalesce(health_metric_sync_state.coverage_start_at, ${input.coverageStartAt ?? null}::timestamptz),
        status = ${status},
        updated_at = ${input.nowIso}::timestamptz
    `;
  }

  private async requireLinkedSelfProfileId(actorUserId: string, familyId: string): Promise<string> {
    const [profile] = await this.context.sql`
      select id
      from people
      where family_id = ${familyId}
        and linked_user_id = ${actorUserId}
        and relationship_label = 'Self'
        and status = 'active'
      limit 1
    `;
    if (!profile) {
      throw new HttpError(409, "healthkit_self_profile_required", "Create your self profile before using HealthKit sync.");
    }
    return profile.id;
  }
}
