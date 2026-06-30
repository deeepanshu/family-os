import type {
  HealthKitImportResult,
  HealthKitMetricType,
  HealthKitSampleInput,
  HealthKitSyncStatus,
  HealthMetricDailySummary
} from "@family-os/shared";
import { HttpError } from "../../errors";
import { PostgresRepositoryContext } from "./context";
import { toDateString } from "./dateUtils";
import { mapHealthMetricDailySummary } from "./mappers";

const allMetricTypes: HealthKitMetricType[] = ["steps", "walking_distance", "sleep", "weight", "blood_pressure", "blood_glucose"];

export class PostgresHealthKitStore {
  constructor(private readonly context: PostgresRepositoryContext) {}

  async getHealthKitSyncStatus(actorUserId: string): Promise<HealthKitSyncStatus> {
    const current = await this.context.requireActiveMember(actorUserId);
    const [linkedProfile] = await this.context.sql`
      select id
      from people
      where family_id = ${current.family.id}
        and linked_user_id = ${actorUserId}
        and status = 'active'
      limit 1
    `;
    const settings = await this.context.sql`
      select metric_type
      from healthkit_sync_settings
      where user_id = ${actorUserId}
        and enabled = true
      order by metric_type asc
    `;
    const [lastSync] = await this.context.sql`
      select *
      from healthkit_sync_runs
      where user_id = ${actorUserId}
      order by started_at desc
      limit 1
    `;
    return {
      linkedProfileId: linkedProfile?.id,
      enabledMetrics: settings.map((row: any) => row.metric_type),
      lastSync: lastSync
        ? {
            id: lastSync.id,
            status: lastSync.status,
            startedAt: new Date(lastSync.started_at).toISOString(),
            finishedAt: new Date(lastSync.finished_at).toISOString(),
            importedCount: lastSync.imported_count,
            skippedCount: lastSync.skipped_count,
            failedCount: lastSync.failed_count
          }
        : undefined
    };
  }

  async linkHealthKitProfile(actorUserId: string, personId: string): Promise<HealthKitSyncStatus> {
    const current = await this.context.requireActiveMember(actorUserId);
    const [profile] = await this.context.sql`
      select *
      from people
      where id = ${personId}
        and family_id = ${current.family.id}
        and status = 'active'
    `;
    if (!profile) {
      throw new HttpError(404, "profile_not_found", "Health profile was not found.");
    }
    if (profile.linked_user_id && profile.linked_user_id !== actorUserId) {
      throw new HttpError(409, "profile_already_linked", "This health profile is already linked to another user.");
    }
    await this.context.sql`
      update people
      set linked_user_id = ${actorUserId}
      where id = ${personId}
    `;
    await this.context.audit({
      familyId: current.family.id,
      actorUserId,
      action: "healthkit.profile_linked",
      resourceType: "health_profile",
      resourceId: personId
    });
    return this.getHealthKitSyncStatus(actorUserId);
  }

  async updateHealthKitSyncSettings(actorUserId: string, enabledMetrics: HealthKitMetricType[]): Promise<HealthKitSyncStatus> {
    const current = await this.context.requireActiveMember(actorUserId);
    const linkedProfileId = await this.requireLinkedProfileId(actorUserId, current.family.id);
    const uniqueMetrics = [...new Set(enabledMetrics)].filter((metric) => allMetricTypes.includes(metric));
    await this.context.sql.begin(async (tx: any) => {
      await tx`delete from healthkit_sync_settings where user_id = ${actorUserId}`;
      if (uniqueMetrics.length > 0) {
        await tx`
          insert into healthkit_sync_settings ${tx(
            uniqueMetrics.map((metricType) => ({
              family_id: current.family.id,
              person_id: linkedProfileId,
              user_id: actorUserId,
              metric_type: metricType,
              enabled: true
            })),
            "family_id",
            "person_id",
            "user_id",
            "metric_type",
            "enabled"
          )}
        `;
      }
    });
    await this.context.audit({
      familyId: current.family.id,
      actorUserId,
      action: "healthkit.settings_updated",
      resourceType: "health_profile",
      resourceId: linkedProfileId,
      metadata: { enabledMetrics: uniqueMetrics }
    });
    return this.getHealthKitSyncStatus(actorUserId);
  }

  async importHealthKitSamples(actorUserId: string, samples: HealthKitSampleInput[]): Promise<HealthKitImportResult> {
    const current = await this.context.requireActiveMember(actorUserId);
    const personId = await this.requireLinkedProfileId(actorUserId, current.family.id);
    const settings = await this.context.sql`
      select metric_type
      from healthkit_sync_settings
      where user_id = ${actorUserId}
        and person_id = ${personId}
        and enabled = true
    `;
    const enabled = new Set(settings.map((row: any) => row.metric_type as HealthKitMetricType));
    const startedAt = new Date().toISOString();
    let importedCount = 0;
    let skippedCount = 0;
    let failedCount = 0;
    let syncRunId = "";

    await this.context.sql.begin(async (tx: any) => {
      const [run] = await tx`
        insert into healthkit_sync_runs (family_id, person_id, user_id, status, started_at, finished_at)
        values (${current.family.id}, ${personId}, ${actorUserId}, 'completed', ${startedAt}, ${startedAt})
        returning *
      `;
      syncRunId = run.id;

      for (const sample of samples) {
        if (!enabled.has(sample.metricType)) {
          skippedCount += 1;
          continue;
        }
        if (!isValidSample(sample)) {
          failedCount += 1;
          continue;
        }
        const [existing] = await tx`
          select id
          from healthkit_samples
          where person_id = ${personId}
            and source_sample_key = ${sample.sourceSampleKey}
        `;
        if (existing) {
          skippedCount += 1;
          continue;
        }
        await tx`
          insert into healthkit_samples (
            family_id, person_id, user_id, sync_run_id, metric_type, source_sample_key,
            start_date, end_date, value, unit, systolic, diastolic, pulse, glucose_context
          )
          values (
            ${current.family.id},
            ${personId},
            ${actorUserId},
            ${syncRunId},
            ${sample.metricType},
            ${sample.sourceSampleKey},
            ${sample.startDate},
            ${sample.endDate ?? null},
            ${sample.value ?? null},
            ${sample.unit ?? defaultUnit(sample.metricType)},
            ${sample.systolic ?? null},
            ${sample.diastolic ?? null},
            ${sample.pulse ?? null},
            ${sample.glucoseContext ?? null}
          )
        `;
        if (sample.metricType === "blood_pressure") {
          await tx`
            insert into blood_pressure_readings (
              family_id, person_id, recorded_by_user_id, systolic, diastolic, pulse,
              measured_at, source, source_sample_key, imported_by_user_id, imported_at, sync_run_id
            )
            values (
              ${current.family.id}, ${personId}, ${actorUserId}, ${sample.systolic}, ${sample.diastolic},
              ${sample.pulse ?? null}, ${sample.startDate}, 'healthkit', ${sample.sourceSampleKey},
              ${actorUserId}, now(), ${syncRunId}
            )
            on conflict do nothing
          `;
        }
        if (sample.metricType === "blood_glucose") {
          await tx`
            insert into blood_glucose_readings (
              family_id, person_id, recorded_by_user_id, value, unit, context, measured_at,
              source, source_sample_key, imported_by_user_id, imported_at, sync_run_id
            )
            values (
              ${current.family.id}, ${personId}, ${actorUserId}, ${sample.value}, 'mg/dL',
              ${sample.glucoseContext ?? "random"}, ${sample.startDate}, 'healthkit',
              ${sample.sourceSampleKey}, ${actorUserId}, now(), ${syncRunId}
            )
            on conflict do nothing
          `;
        }
        importedCount += 1;
      }
      await tx`
        update healthkit_sync_runs
        set
          status = ${failedCount > 0 ? "failed" : "completed"},
          finished_at = now(),
          imported_count = ${importedCount},
          skipped_count = ${skippedCount},
          failed_count = ${failedCount}
        where id = ${syncRunId}
      `;
      await this.rebuildDailySummaries(tx, current.family.id, personId);
    });

    await this.context.audit({
      familyId: current.family.id,
      actorUserId,
      action: "healthkit.samples_imported",
      resourceType: "healthkit_sync_run",
      resourceId: syncRunId,
      metadata: { importedCount, skippedCount, failedCount }
    });
    return { syncRunId, importedCount, skippedCount, failedCount };
  }

  async listHealthMetricDailySummaries(
    actorUserId: string,
    personId?: string,
    metricType?: HealthKitMetricType,
    limit = 90
  ): Promise<HealthMetricDailySummary[]> {
    const current = await this.context.requireActiveMember(actorUserId);
    const rows = await this.context.sql`
      select *
      from health_metric_daily_summaries
      where family_id = ${current.family.id}
        and (${personId ?? null}::uuid is null or person_id = ${personId ?? null})
        and (${metricType ?? null}::text is null or metric_type = ${metricType ?? null})
      order by date desc
      limit ${limit}
    `;
    return rows.map(mapHealthMetricDailySummary);
  }

  private async requireLinkedProfileId(actorUserId: string, familyId: string): Promise<string> {
    const [profile] = await this.context.sql`
      select id
      from people
      where family_id = ${familyId}
        and linked_user_id = ${actorUserId}
        and status = 'active'
      limit 1
    `;
    if (!profile) {
      throw new HttpError(409, "healthkit_profile_required", "Link your profile before using HealthKit sync.");
    }
    return profile.id;
  }

  private async rebuildDailySummaries(sql: any, familyId: string, personId: string) {
    const rows = await sql`
      select *
      from healthkit_samples
      where family_id = ${familyId}
        and person_id = ${personId}
        and deleted_at is null
        and metric_type not in ('blood_pressure', 'blood_glucose')
    `;
    const groups = new Map<string, any[]>();
    for (const row of rows) {
      const key = `${row.metric_type}:${toDateString(row.start_date)}`;
      groups.set(key, [...(groups.get(key) ?? []), row]);
    }
    await sql`delete from health_metric_daily_summaries where family_id = ${familyId} and person_id = ${personId}`;
    for (const [key, group] of groups) {
      const [metricType, date] = key.split(":") as [HealthKitMetricType, string];
      const sorted = group.sort((a, b) => new Date(b.start_date).getTime() - new Date(a.start_date).getTime());
      const latest = sorted[0];
      const value = metricType === "weight"
        ? Number(latest.value)
        : group.reduce((sum, row) => sum + Number(row.value ?? 0), 0);
      await sql`
        insert into health_metric_daily_summaries (family_id, person_id, metric_type, date, value, unit, source, sample_count)
        values (${familyId}, ${personId}, ${metricType}, ${date}, ${value}, ${latest.unit ?? defaultUnit(metricType)}, 'healthkit', ${group.length})
      `;
    }
  }
}

function isValidSample(sample: HealthKitSampleInput) {
  if (sample.metricType === "blood_pressure") {
    return sample.systolic !== undefined && sample.diastolic !== undefined;
  }
  if (sample.metricType === "blood_glucose") {
    return sample.value !== undefined && (sample.unit === undefined || sample.unit === "mg/dL");
  }
  return sample.value !== undefined;
}

function defaultUnit(metricType: HealthKitMetricType) {
  switch (metricType) {
    case "steps":
      return "count";
    case "walking_distance":
      return "m";
    case "sleep":
      return "min";
    case "weight":
      return "kg";
    case "blood_pressure":
      return "mmHg";
    case "blood_glucose":
      return "mg/dL";
  }
}
