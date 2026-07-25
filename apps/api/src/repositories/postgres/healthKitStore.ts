import type {
  BloodPressureReading,
  BloodGlucoseReading,
  CompleteHealthKitRepairInput,
  CreateHealthKitRepairInput,
  HealthKitMetric,
  HealthKitMetricKey,
  HealthKitRepair,
  HealthKitRepairCompleteResult,
  HealthKitSettings,
  HealthKitSyncInput,
  HealthKitSyncOperation,
  HealthKitSyncResult,
  HealthDailyMetricRecord,
  HealthMetricFreshness,
  HealthMetricSyncStatusCode,
  HealthSleepDayRecord,
  HealthStepHourRecord,
  HealthWorkoutRecord,
  PutHealthKitSettingsInput
} from "@family-os/shared";
import { HEALTHKIT_METRIC_REGISTRY } from "@family-os/shared";
import { HttpError } from "../../errors";
import { localDateString } from "../../mcp/timezone";
import {
  assertOperationInRepairRange,
  assertSelfProfileMatch,
  buildSyncResult,
  HEALTHKIT_METRICS,
  groupsAffected,
  profileLocalSleepDayRange,
  repairRangeStart,
  REPAIR_TTL_MS,
  toUtcIso,
  type HealthKitRepairRange
} from "../healthKitDomain";
import { PostgresRepositoryContext } from "./context";
import { toDateString, toIso } from "./dateUtils";
import { mapBloodGlucose, mapBloodPressure } from "./mappers";
import type { Row } from "./types";

function repairRangeFromRow(row: Row): HealthKitRepairRange {
  return {
    rangeStartIso: toIso(row.range_start),
    rangeEndIso: toIso(row.range_end),
    rangeStartDay: toDateString(row.range_start_day) ?? String(row.range_start_day).slice(0, 10),
    rangeEndDay: toDateString(row.range_end_day) ?? String(row.range_end_day).slice(0, 10)
  };
}

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

    const uniqueGroups = [...new Set(input.enabledGroups)].filter((m): m is HealthKitMetric =>
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

      const consentActive = uniqueGroups.length > 0;
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
        const enabled = uniqueGroups.includes(metric);
        await tx`
          insert into healthkit_sync_groups (person_id, family_id, group_key, enabled, updated_at)
          values (${input.personId}, ${current.family.id}, ${metric}, ${enabled}, ${nowIso})
          on conflict (person_id, group_key) do update set enabled = excluded.enabled, updated_at = excluded.updated_at
        `;

        const [state] = await tx`
          select * from healthkit_sync_state where person_id = ${input.personId} and group_key = ${metric}
        `;
        let status: HealthMetricSyncStatusCode = enabled ? (state?.status ?? "never_synced") : "disabled";
        if (!enabled) status = "disabled";
        else if (timezoneChanged) status = "repair_needed";
        else if (state?.status === "disabled") status = "never_synced";

        await tx`
          insert into healthkit_sync_state (
            person_id, family_id, group_key, status, last_successful_at, last_attempt_at,
            last_error_code, coverage_start_at, coverage_end_at, updated_at
          ) values (
            ${input.personId}, ${current.family.id}, ${metric}, ${status},
            ${state?.last_successful_at ?? null}, ${state?.last_attempt_at ?? null},
            ${state?.last_error_code ?? null}, ${state?.coverage_start_at ?? null},
            ${state?.coverage_end_at ?? null}, ${nowIso}
          )
          on conflict (person_id, group_key) do update set
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
        enabledGroups: uniqueGroups,
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
    const affected = groupsAffected(input.operations);

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
          if (affected.length !== 1 || affected[0] !== row.group) {
            throw new HttpError(400, "healthkit_repair_invalid", "Repair chunks may only include the repair metric.");
          }
          for (const op of input.operations) {
            assertOperationInRepairRange(op, repairRangeFromRow(row));
          }
          repair = row;
        }

        for (const metric of affected) {
          if (!authority.enabledGroups.has(metric)) {
            throw new HttpError(403, "healthkit_metric_disabled", `Metric ${metric} is not enabled.`);
          }
        }

        await this.applyOperations(tx, {
          familyId: current.family.id,
          personId: input.personId,
          actorUserId,
          timezoneVersion: input.timezoneVersion,
          operations: input.operations,
          nowIso,
          repairRange: repair ? repairRangeFromRow(repair) : undefined
        });

        for (const metric of affected) {
          await this.touchMetricState(tx, {
            familyId: current.family.id,
            personId: input.personId,
            group: metric,
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
          groupsAffected: affected,
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
            insert into healthkit_sync_state (
              person_id, family_id, group_key, last_attempt_at, last_error_code, status, updated_at
            ) values (
              ${input.personId}, ${current.family.id}, ${metric}, ${nowIso}, ${error.code}, 'error', ${nowIso}
            )
            on conflict (person_id, group_key) do update set
              last_attempt_at = excluded.last_attempt_at,
              last_error_code = excluded.last_error_code,
              status = case
                when healthkit_sync_state.status = 'repairing' then 'repairing'
                when healthkit_sync_state.status = 'disabled' then 'disabled'
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
    const group = input.group;
    const current = await this.context.requireActiveMember(actorUserId);
    const selfId = await this.requireLinkedSelfProfileId(actorUserId, current.family.id);
    assertSelfProfileMatch({ selfProfileId: selfId, requestedPersonId: input.personId });

    const now = new Date();
    const nowIso = toUtcIso(now);
    const rangeEnd = now;
    const rangeStart = repairRangeStart(group, now);
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
      if (!authority.enabledGroups.has(group)) {
        throw new HttpError(403, "healthkit_metric_disabled", `Metric ${group} is not enabled.`);
      }

      const healthTimezone = String(authority.settings.health_timezone ?? "UTC");
      const localEndDay = localDateString(now, healthTimezone);
      const { rangeStartDay, rangeEndDay } = profileLocalSleepDayRange(localEndDay, 90);

      await tx`
        update healthkit_repairs
        set expires_at = ${nowIso}
        where person_id = ${input.personId}
          and group_key = ${group}
          and completed_at is null
          and expires_at > ${nowIso}
      `;

      const [row] = await tx`
        insert into healthkit_repairs (
          person_id, family_id, group_key, installation_id, timezone_version,
          range_start, range_end, range_start_day, range_end_day, expires_at
        ) values (
          ${input.personId}, ${current.family.id}, ${group}, ${input.installationId},
          ${input.timezoneVersion}, ${toUtcIso(rangeStart)}, ${toUtcIso(rangeEnd)},
          ${rangeStartDay}::date, ${rangeEndDay}::date, ${toUtcIso(expiresAt)}
        )
        returning *
      `;

      await this.touchMetricState(tx, {
        familyId: current.family.id,
        personId: input.personId,
        group,
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
      metadata: { group, status: "created" }
    });

    const range = repairRangeFromRow(repair);
    return {
      repairId: repair.repair_id,
      personId: repair.person_id,
      group,
      installationId: repair.installation_id,
      timezoneVersion: repair.timezone_version,
      rangeStart: range.rangeStartIso,
      rangeEnd: range.rangeEndIso,
      rangeStartDay: range.rangeStartDay,
      rangeEndDay: range.rangeEndDay,
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
          group: repair.group_key as HealthKitMetric,
          completed: true as const,
          expectedChunkCount: repair.expected_chunk_count ?? input.expectedChunkCount,
          completedChunkCount: repair.expected_chunk_count ?? input.expectedChunkCount
        };
      }
      if (Date.parse(String(repair.expires_at)) <= Date.now()) {
        throw new HttpError(400, "healthkit_repair_invalid", "Repair session is expired.");
      }

      const authority = await this.loadWriteAuthority(tx, actorUserId, current.family.id, selfId);
      if (!authority.settings?.consented_at) {
        throw new HttpError(403, "healthkit_consent_required", "HealthKit upload consent is required.");
      }
      if (authority.activeInstallationId !== repair.installation_id) {
        throw new HttpError(403, "healthkit_installation_inactive", "Installation is not the active HealthKit installation.");
      }
      if (authority.settings.health_timezone_version !== repair.timezone_version) {
        throw new HttpError(409, "healthkit_timezone_version_invalid", "Timezone version is stale.");
      }
      if (!authority.enabledGroups.has(repair.group_key as HealthKitMetric)) {
        throw new HttpError(403, "healthkit_metric_disabled", `Metric ${repair.group_key} is not enabled.`);
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

      if (repair.group_key === "sleep") {
        const range = repairRangeFromRow(repair);
        await tx`
          delete from health_sleep_days
          where person_id = ${selfId}
            and timezone_version < ${repair.timezone_version}
            and sleep_day >= ${range.rangeStartDay}::date
            and sleep_day <= ${range.rangeEndDay}::date
        `;
      }

      await tx`
        update healthkit_repairs
        set expected_chunk_count = ${input.expectedChunkCount}, completed_at = ${nowIso}
        where repair_id = ${repairId}
      `;

      await tx`
        update healthkit_sync_state
        set
          status = 'ready',
          last_successful_at = ${nowIso},
          last_attempt_at = ${nowIso},
          last_error_code = null,
          coverage_start_at = ${toIso(repair.range_start)},
          coverage_end_at = ${toIso(repair.range_end)},
          updated_at = ${nowIso}
        where person_id = ${selfId} and group_key = ${repair.group_key}
      `;

      return {
        repairId,
        group: repair.group_key as HealthKitMetric,
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
        group: result.group,
        expected_chunk_count: result.expectedChunkCount,
        status: "completed"
      }
    });

    return result;
  }

  async getHealthMetricFreshness(
    actorUserId: string,
    personId: string,
    healthMetric: HealthKitMetricKey
  ): Promise<HealthMetricFreshness> {
    const current = await this.context.requireActiveMember(actorUserId);
    const group = HEALTHKIT_METRIC_REGISTRY[healthMetric].group;
    await this.context.requireProfileInFamily(personId, current.family.id);
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
        person_id, sleep_day, timezone_version, total_minutes, core_minutes,
        deep_minutes, rem_minutes, unspecified_asleep_minutes, awake_minutes,
        in_bed_minutes, wrist_temperature_celsius, breathing_disturbance_count
      from health_sleep_days
      where family_id = ${current.family.id}
        and person_id = ${personId}
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
    const current = await this.context.requireActiveMember(actorUserId);
    await this.context.requireProfileInFamily(personId, current.family.id);
    const rows = await this.context.sql`
      select r.*, s.user_id as recorded_by_user_id, 'healthkit'::text as source
      from health_blood_pressure_readings r
      join healthkit_sync_profile_settings s on s.person_id = r.person_id
      where r.family_id = ${current.family.id}
        and r.person_id = ${personId}
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
      throw new HttpError(400, "healthkit_metric_not_daily", "The requested metric is not stored as a daily aggregate.");
    }
    const current = await this.context.requireActiveMember(actorUserId);
    await this.context.requireProfileInFamily(personId, current.family.id);
    const [settings] = await this.context.sql`
      select health_timezone_version
      from healthkit_sync_profile_settings
      where person_id = ${personId}
        and family_id = ${current.family.id}
    `;
    const timezoneVersion = Number(settings?.health_timezone_version ?? 1);
    const rows = await this.context.sql`
      select *
      from health_daily_metrics
      where family_id = ${current.family.id}
        and person_id = ${personId}
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
    const current = await this.context.requireActiveMember(actorUserId);
    await this.context.requireProfileInFamily(personId, current.family.id);
    const rows = await this.context.sql`
      select r.*, s.user_id as recorded_by_user_id, 'healthkit'::text as source
      from health_blood_glucose_readings r
      join healthkit_sync_profile_settings s on s.person_id = r.person_id
      where r.family_id = ${current.family.id}
        and r.person_id = ${personId}
        and r.measured_at >= ${rangeStartUtc}::timestamptz
        and r.measured_at <= ${rangeEndUtc}::timestamptz
      order by r.measured_at asc
      limit ${limit}
    `;
    return rows.map(mapBloodGlucose);
  }

  async listHealthKitWorkouts(
    actorUserId: string,
    personId: string,
    rangeStartUtc: string,
    rangeEndUtc: string,
    limit: number
  ): Promise<HealthWorkoutRecord[]> {
    const current = await this.context.requireActiveMember(actorUserId);
    await this.context.requireProfileInFamily(personId, current.family.id);
    const rows = await this.context.sql`
      select *
      from health_workouts
      where family_id = ${current.family.id}
        and person_id = ${personId}
        and started_at >= ${rangeStartUtc}::timestamptz
        and started_at <= ${rangeEndUtc}::timestamptz
      order by started_at asc
      limit ${limit}
    `;
    return rows.map((row: Row) => ({
      id: row.id,
      personId: row.person_id,
      workoutType: row.workout_type,
      startedAtUtc: toIso(row.started_at),
      endedAtUtc: toIso(row.ended_at),
      durationSeconds: Number(row.duration_seconds),
      activeEnergyKcal: row.active_energy_kcal === null ? undefined : Number(row.active_energy_kcal),
      distanceMeters: row.distance_meters === null ? undefined : Number(row.distance_meters),
      averageHeartRateBpm: row.average_heart_rate_bpm === null ? undefined : Number(row.average_heart_rate_bpm),
      maximumHeartRateBpm: row.maximum_heart_rate_bpm === null ? undefined : Number(row.maximum_heart_rate_bpm)
    }));
  }

  private async loadSettings(actorUserId: string, familyId: string, personId: string): Promise<HealthKitSettings> {
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
        status: (state?.status as HealthMetricSyncStatusCode) ?? (enabled ? "never_synced" : "disabled")
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

  private async loadWriteAuthority(tx: any, actorUserId: string, familyId: string, personId: string) {
    const [settings] = await tx`
      select * from healthkit_sync_profile_settings
      where person_id = ${personId} and family_id = ${familyId} and user_id = ${actorUserId}
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

  private async applyOperations(
    tx: any,
    input: {
      familyId: string;
      personId: string;
      actorUserId: string;
      timezoneVersion: number;
      operations: HealthKitSyncOperation[];
      nowIso: string;
      repairRange?: HealthKitRepairRange;
    }
  ) {
    const steps = input.operations.filter((op): op is Extract<HealthKitSyncOperation, { kind: "steps_hour_upsert" }> => op.kind === "steps_hour_upsert");
    if (steps.length) {
      await tx`
        insert into health_step_hours ${tx(
          steps.map((op) => ({
            family_id: input.familyId,
            person_id: input.personId,
            hour_start_utc: op.hourStartUtc,
            count: op.count,
            updated_at: input.nowIso
          })),
          "family_id",
          "person_id",
          "hour_start_utc",
          "count",
          "updated_at"
        )}
        on conflict (person_id, hour_start_utc) do update set
          count = excluded.count,
          updated_at = excluded.updated_at
      `;
    }

    const sleepDays = input.operations.filter((op): op is Extract<HealthKitSyncOperation, { kind: "sleep_day_upsert" }> => op.kind === "sleep_day_upsert");
    if (sleepDays.length) await tx`
      insert into health_sleep_days ${tx(sleepDays.map((op) => ({
        family_id: input.familyId, person_id: input.personId, sleep_day: op.sleepDay, timezone_version: input.timezoneVersion,
        total_minutes: op.totalMinutes, core_minutes: op.coreMinutes, deep_minutes: op.deepMinutes, rem_minutes: op.remMinutes,
        unspecified_asleep_minutes: op.unspecifiedAsleepMinutes, awake_minutes: op.awakeMinutes, in_bed_minutes: op.inBedMinutes,
        wrist_temperature_celsius: op.wristTemperatureCelsius ?? null, breathing_disturbance_count: op.breathingDisturbanceCount ?? null, updated_at: input.nowIso
      })), "family_id", "person_id", "sleep_day", "timezone_version", "total_minutes", "core_minutes", "deep_minutes", "rem_minutes", "unspecified_asleep_minutes", "awake_minutes", "in_bed_minutes", "wrist_temperature_celsius", "breathing_disturbance_count", "updated_at")}
      on conflict (person_id, sleep_day, timezone_version) do update set
        total_minutes = excluded.total_minutes, core_minutes = excluded.core_minutes, deep_minutes = excluded.deep_minutes,
        rem_minutes = excluded.rem_minutes, unspecified_asleep_minutes = excluded.unspecified_asleep_minutes,
        awake_minutes = excluded.awake_minutes, in_bed_minutes = excluded.in_bed_minutes,
        wrist_temperature_celsius = excluded.wrist_temperature_celsius, breathing_disturbance_count = excluded.breathing_disturbance_count,
        updated_at = excluded.updated_at
    `;

    const daily = input.operations.filter((op): op is Extract<HealthKitSyncOperation, { kind: "daily_metric_upsert" }> => op.kind === "daily_metric_upsert");
    if (daily.length) await tx`
      insert into health_daily_metrics ${tx(daily.map((op) => ({
        family_id: input.familyId, person_id: input.personId, metric_key: op.healthMetric, local_day: op.localDay, timezone_version: input.timezoneVersion,
        unit: HEALTHKIT_METRIC_REGISTRY[op.healthMetric].unit, sum_value: op.sumValue ?? null, average_value: op.averageValue ?? null,
        minimum_value: op.minimumValue ?? null, maximum_value: op.maximumValue ?? null, latest_value: op.latestValue ?? null,
        sample_count: op.sampleCount, updated_at: input.nowIso
      })), "family_id", "person_id", "metric_key", "local_day", "timezone_version", "unit", "sum_value", "average_value", "minimum_value", "maximum_value", "latest_value", "sample_count", "updated_at")}
      on conflict (person_id, metric_key, local_day, timezone_version) do update set
        unit = excluded.unit, sum_value = excluded.sum_value, average_value = excluded.average_value,
        minimum_value = excluded.minimum_value, maximum_value = excluded.maximum_value, latest_value = excluded.latest_value,
        sample_count = excluded.sample_count, updated_at = excluded.updated_at
    `;

    const bp = input.operations.filter((op): op is Extract<HealthKitSyncOperation, { kind: "blood_pressure_upsert" }> => op.kind === "blood_pressure_upsert");
    if (bp.length) await tx`
      insert into health_blood_pressure_readings ${tx(bp.map((op) => ({ family_id: input.familyId, person_id: input.personId, source_sample_key: op.sourceSampleKey, measured_at: op.measuredAtUtc, systolic: op.systolic, diastolic: op.diastolic, pulse: op.pulse ?? null, updated_at: input.nowIso })), "family_id", "person_id", "source_sample_key", "measured_at", "systolic", "diastolic", "pulse", "updated_at")}
      on conflict (person_id, source_sample_key) do update set systolic = excluded.systolic, diastolic = excluded.diastolic, pulse = excluded.pulse, measured_at = excluded.measured_at, updated_at = excluded.updated_at
    `;

    const glucose = input.operations.filter((op): op is Extract<HealthKitSyncOperation, { kind: "blood_glucose_upsert" }> => op.kind === "blood_glucose_upsert");
    if (glucose.length) await tx`
      insert into health_blood_glucose_readings ${tx(glucose.map((op) => ({ family_id: input.familyId, person_id: input.personId, source_sample_key: op.sourceSampleKey, measured_at: op.measuredAtUtc, value_mg_dl: op.valueMgDl, updated_at: input.nowIso })), "family_id", "person_id", "source_sample_key", "measured_at", "value_mg_dl", "updated_at")}
      on conflict (person_id, source_sample_key) do update set measured_at = excluded.measured_at, value_mg_dl = excluded.value_mg_dl, updated_at = excluded.updated_at
    `;

    const workouts = input.operations.filter((op): op is Extract<HealthKitSyncOperation, { kind: "workout_upsert" }> => op.kind === "workout_upsert");
    if (workouts.length) await tx`
      insert into health_workouts ${tx(workouts.map((op) => ({ family_id: input.familyId, person_id: input.personId, source_sample_key: op.sourceSampleKey, workout_type: op.workoutType, started_at: op.startedAtUtc, ended_at: op.endedAtUtc, duration_seconds: op.durationSeconds, active_energy_kcal: op.activeEnergyKcal ?? null, distance_meters: op.distanceMeters ?? null, average_heart_rate_bpm: op.averageHeartRateBpm ?? null, maximum_heart_rate_bpm: op.maximumHeartRateBpm ?? null, updated_at: input.nowIso })), "family_id", "person_id", "source_sample_key", "workout_type", "started_at", "ended_at", "duration_seconds", "active_energy_kcal", "distance_meters", "average_heart_rate_bpm", "maximum_heart_rate_bpm", "updated_at")}
      on conflict (person_id, source_sample_key) do update set workout_type = excluded.workout_type, started_at = excluded.started_at, ended_at = excluded.ended_at, duration_seconds = excluded.duration_seconds, active_energy_kcal = excluded.active_energy_kcal, distance_meters = excluded.distance_meters, average_heart_rate_bpm = excluded.average_heart_rate_bpm, maximum_heart_rate_bpm = excluded.maximum_heart_rate_bpm, updated_at = excluded.updated_at
    `;

    for (const op of input.operations) {
      if (op.kind === "steps_hour_delete") await tx`delete from health_step_hours where person_id = ${input.personId} and hour_start_utc = ${op.hourStartUtc}::timestamptz`;
      if (op.kind === "sleep_day_delete") await tx`delete from health_sleep_days where person_id = ${input.personId} and sleep_day = ${op.sleepDay}::date and timezone_version = ${input.timezoneVersion}`;
      if (op.kind === "daily_metric_delete") await tx`delete from health_daily_metrics where person_id = ${input.personId} and metric_key = ${op.healthMetric} and local_day = ${op.localDay}::date and timezone_version = ${input.timezoneVersion}`;
      if (op.kind === "blood_pressure_delete") await this.deleteClinicalRow(tx, "health_blood_pressure_readings", input, op.sourceSampleKey);
      if (op.kind === "blood_glucose_delete") await this.deleteClinicalRow(tx, "health_blood_glucose_readings", input, op.sourceSampleKey);
      if (op.kind === "workout_delete") await this.deleteClinicalRow(tx, "health_workouts", input, op.sourceSampleKey, "started_at");
    }
  }

  private async deleteClinicalRow(tx: any, table: "health_blood_pressure_readings" | "health_blood_glucose_readings" | "health_workouts", input: { personId: string; repairRange?: HealthKitRepairRange }, sourceSampleKey: string, instantColumn = "measured_at") {
    const rows = await tx.unsafe(`select ${instantColumn} from ${table} where person_id = $1 and source_sample_key = $2`, [input.personId, sourceSampleKey]);
    const existing = rows[0];
    if (existing && input.repairRange) {
      const instant = Date.parse(String(existing[instantColumn]));
      if (instant < Date.parse(input.repairRange.rangeStartIso) || instant > Date.parse(input.repairRange.rangeEndIso)) {
        throw new HttpError(400, "healthkit_operation_invalid", "clinical deletion is outside the repair range.");
      }
    }
    await tx.unsafe(`delete from ${table} where person_id = $1 and source_sample_key = $2`, [input.personId, sourceSampleKey]);
  }

  private async touchMetricState(
    tx: any,
    input: {
      familyId: string;
      personId: string;
      group: HealthKitMetric;
      nowIso: string;
      success: boolean;
      repairing?: boolean;
      coverageStartAt?: string;
      coverageEndAt?: string;
    }
  ) {
    const [existing] = await tx`
      select * from healthkit_sync_state where person_id = ${input.personId} and group_key = ${input.group}
    `;
    let status: HealthMetricSyncStatusCode = existing?.status ?? "never_synced";
    if (input.repairing) {
      status = "repairing";
    } else if (input.success) {
      status = existing?.status === "ready" || existing?.coverage_start_at ? "ready" : status === "never_synced" ? "ready" : status;
      if (status === "error" || status === "repair_needed") status = "ready";
    }

    await tx`
      insert into healthkit_sync_state (
        person_id, family_id, group_key, last_successful_at, last_attempt_at, last_error_code,
        coverage_start_at, coverage_end_at, status, updated_at
      ) values (
        ${input.personId},
        ${input.familyId},
        ${input.group},
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
      on conflict (person_id, group_key) do update set
        last_successful_at = case when ${input.success} then ${input.nowIso}::timestamptz else healthkit_sync_state.last_successful_at end,
        last_attempt_at = ${input.nowIso}::timestamptz,
        last_error_code = case when ${input.success} then null else healthkit_sync_state.last_error_code end,
        coverage_end_at = case
          when ${input.success} and ${!input.repairing} then ${input.nowIso}::timestamptz
          else healthkit_sync_state.coverage_end_at
        end,
        coverage_start_at = coalesce(healthkit_sync_state.coverage_start_at, ${input.coverageStartAt ?? null}::timestamptz),
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
