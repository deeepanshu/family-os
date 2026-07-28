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
import { HttpError } from "../../errors";
import { localDateString } from "../../mcp/timezone";
import {
  assertEventCoherent,
  assertEventInBackfillRange,
  assertSelfProfileMatch,
  backfillRangeStart,
  HEALTHKIT_METRICS,
  profileLocalDayRange,
  toUtcIso,
  type HealthKitBackfillRange
} from "../healthKitDomain";
import { PostgresRepositoryContext } from "./context";
import { toDateString, toIso } from "./dateUtils";
import { mapBloodGlucose, mapBloodPressure } from "./mappers";
import type { Row } from "./types";

function nodeSha256(data: Uint8Array): Uint8Array {
  return createHash("sha256").update(data).digest();
}

function sessionRangeFromRow(row: Row): HealthKitBackfillRange {
  return {
    rangeStartIso: toIso(row.range_start),
    rangeEndIso: toIso(row.range_end),
    rangeStartDay: toDateString(row.range_start_day) ?? String(row.range_start_day).slice(0, 10),
    rangeEndDay: toDateString(row.range_end_day) ?? String(row.range_end_day).slice(0, 10)
  };
}

function mapSession(row: Row, pendingCount?: number): HealthKitBackfillSession {
  const required = Array.isArray(row.required_scope_keys)
    ? (row.required_scope_keys as string[])
    : String(row.required_scope_keys ?? "")
        .replace(/^{|}$/g, "")
        .split(",")
        .filter(Boolean);
  const range = sessionRangeFromRow(row);
  return {
    sessionId: row.session_id,
    personId: row.person_id,
    group: row.group_key as HealthKitMetric,
    installationId: row.installation_id,
    timezoneVersion: Number(row.timezone_version),
    rangeStart: range.rangeStartIso,
    rangeEnd: range.rangeEndIso,
    rangeStartDay: range.rangeStartDay,
    rangeEndDay: range.rangeEndDay,
    requiredScopeKeys: required,
    status: row.status,
    expiresAt: toIso(row.expires_at),
    pendingCount
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
        throw new HttpError(400, "consent_withdrawn", "consentVersion is required when enabling metrics.");
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
            "installation_inactive",
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
        else if (timezoneChanged) status = "never_synced";
        else if (state?.status === "disabled") status = "never_synced";

        await tx`
          insert into healthkit_sync_state (
            person_id, family_id, group_key, status, last_successful_at, last_attempt_at,
            last_error_code, coverage_start_at, coverage_end_at, updated_at
          ) values (
            ${input.personId}, ${current.family.id}, ${metric}, ${status},
            ${timezoneChanged ? null : state?.last_successful_at ?? null},
            ${state?.last_attempt_at ?? null},
            ${timezoneChanged ? null : state?.last_error_code ?? null},
            ${timezoneChanged ? null : state?.coverage_start_at ?? null},
            ${timezoneChanged ? null : state?.coverage_end_at ?? null},
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

  async applyHealthKitEvents(actorUserId: string, input: HealthKitEventsBatchInput): Promise<HealthKitEventsBatchResult> {
    if (input.events.length === 0) {
      throw new HttpError(400, "payload_invalid", "events batch must not be empty.");
    }

    const current = await this.context.requireActiveMember(actorUserId);
    const selfId = await this.requireLinkedSelfProfileId(actorUserId, current.family.id);
    assertSelfProfileMatch({ selfProfileId: selfId, requestedPersonId: input.personId });

    const nowIso = toUtcIso(new Date());
    const results: HealthKitEventApplyResult[] = [];

    await this.context.sql.begin(async (tx: any) => {
      const authority = await this.loadWriteAuthority(tx, actorUserId, current.family.id, input.personId);
      if (!authority.settings?.consented_at) {
        throw new HttpError(403, "consent_withdrawn", "HealthKit upload consent is required.");
      }
      if (authority.activeInstallationId !== input.installationId) {
        throw new HttpError(403, "installation_inactive", "Installation is not the active HealthKit installation.");
      }
      if (authority.settings.health_timezone_version !== input.timezoneVersion) {
        throw new HttpError(409, "timezone_stale", "Timezone version is stale.");
      }

      const sessionCache = new Map<string, Row>();

      for (const event of input.events) {
        // One savepoint per event so a single DB failure does not roll back prior applied rows.
        const savepoint = `ev_${event.eventId.replace(/-/g, "").slice(0, 24)}`;
        try {
          await tx.unsafe(`savepoint ${savepoint}`);
          assertEventCoherent(event);

          if (!authority.enabledGroups.has(event.group)) {
            throw new HttpError(403, "group_disabled", `Group ${event.group} is not enabled.`);
          }

          if (event.sessionId) {
            let sessionRow = sessionCache.get(event.sessionId) as Row | undefined;
            if (!sessionRow) {
              const [row] = await tx`
                select * from healthkit_backfill_sessions where session_id = ${event.sessionId}
              `;
              if (!row) {
                throw new HttpError(400, "session_expired", "Backfill session is invalid.");
              }
              sessionCache.set(event.sessionId, row);
              sessionRow = row as Row;
            }
            const openSession = sessionRow as Row;
            this.assertOpenSession(openSession, input, event.group);
            assertEventInBackfillRange(event, sessionRangeFromRow(openSession));
            if (openSession.group_key !== event.group) {
              throw new HttpError(400, "payload_invalid", "Event group does not match session group.");
            }
          }

          const fingerprint = fingerprintHealthEvent(event, nodeSha256);
          const result = await this.applyOneEvent(tx, {
            familyId: current.family.id,
            personId: input.personId,
            installationId: input.installationId,
            timezoneVersion: input.timezoneVersion,
            event,
            fingerprint,
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
          if (error instanceof HttpError && (error.code === "payload_invalid" || error.code === "event_conflict")) {
            results.push({
              eventId: event.eventId,
              result: error.code,
              errorCode: error.code,
              errorMessage: error.message
            });
            continue;
          }
          // Batch-level fencing errors must fail the whole request.
          if (
            error instanceof HttpError &&
            (error.code === "consent_withdrawn" ||
              error.code === "installation_inactive" ||
              error.code === "timezone_stale" ||
              error.code === "group_disabled" ||
              error.code === "session_expired")
          ) {
            throw error;
          }
          // Unexpected DB/runtime failures stay isolated to this event as payload_invalid
          // only when they are validation-shaped; otherwise rethrow to fail the batch.
          throw error;
        }
      }
    });

    await this.context.audit({
      familyId: current.family.id,
      actorUserId,
      action: "healthkit.events_batch",
      resourceType: "healthkit_sync",
      resourceId: input.personId,
      metadata: {
        event_count: input.events.length,
        applied: results.filter((r) => r.result === "applied").length,
        superseded: results.filter((r) => r.result === "superseded").length,
        duplicate: results.filter((r) => r.result === "duplicate").length
      }
    });

    return { results };
  }

  async createBackfillSession(
    actorUserId: string,
    input: CreateHealthKitBackfillSessionInput
  ): Promise<HealthKitBackfillSession> {
    const group = input.group;
    const current = await this.context.requireActiveMember(actorUserId);
    const selfId = await this.requireLinkedSelfProfileId(actorUserId, current.family.id);
    assertSelfProfileMatch({ selfProfileId: selfId, requestedPersonId: input.personId });

    const now = new Date();
    const nowIso = toUtcIso(now);
    const rangeEnd = now;
    const rangeStart = backfillRangeStart(group, now);
    const expiresAt = new Date(now.getTime() + BACKFILL_SESSION_TTL_MS);
    const requiredScopeKeys = requiredScopeKeysForGroup(group);

    const session = await this.context.sql.begin(async (tx: any) => {
      const authority = await this.loadWriteAuthority(tx, actorUserId, current.family.id, input.personId);
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

      const healthTimezone = String(authority.settings.health_timezone ?? "UTC");
      const localEndDay = localDateString(now, healthTimezone);
      const { rangeStartDay, rangeEndDay } = profileLocalDayRange(localEndDay, 90);

      await tx`
        update healthkit_backfill_sessions
        set status = 'expired', expires_at = ${nowIso}
        where person_id = ${input.personId}
          and group_key = ${group}
          and status = 'open'
          and expires_at > ${nowIso}
      `;

      const [row] = await tx`
        insert into healthkit_backfill_sessions (
          person_id, family_id, group_key, installation_id, timezone_version,
          range_start, range_end, range_start_day, range_end_day,
          required_scope_keys, status, expires_at
        ) values (
          ${input.personId}, ${current.family.id}, ${group}, ${input.installationId},
          ${input.timezoneVersion}, ${toUtcIso(rangeStart)}, ${toUtcIso(rangeEnd)},
          ${rangeStartDay}::date, ${rangeEndDay}::date,
          ${requiredScopeKeys}, 'open', ${toUtcIso(expiresAt)}
        )
        returning *
      `;

      await this.touchGroupState(tx, {
        familyId: current.family.id,
        personId: input.personId,
        group,
        nowIso,
        status: "backfilling"
      });

      return row;
    });

    await this.context.audit({
      familyId: current.family.id,
      actorUserId,
      action: "healthkit.session_created",
      resourceType: "healthkit_backfill_session",
      resourceId: session.session_id,
      metadata: { group, status: "open" }
    });

    return mapSession(session, 0);
  }

  async putScopeManifest(
    actorUserId: string,
    sessionId: string,
    scopeKey: string,
    input: PutHealthKitScopeManifestInput
  ): Promise<HealthKitScopeManifestResult> {
    const current = await this.context.requireActiveMember(actorUserId);
    const selfId = await this.requireLinkedSelfProfileId(actorUserId, current.family.id);
    assertSelfProfileMatch({ selfProfileId: selfId, requestedPersonId: input.personId });

    return this.context.sql.begin(async (tx: any) => {
      const [session] = await tx`select * from healthkit_backfill_sessions where session_id = ${sessionId}`;
      if (!session || session.person_id !== input.personId) {
        throw new HttpError(400, "session_expired", "Backfill session is invalid.");
      }
      this.assertOpenSession(session, input, session.group_key as HealthKitMetric);

      const required: string[] = session.required_scope_keys ?? [];
      if (!required.includes(scopeKey)) {
        throw new HttpError(400, "payload_invalid", "scopeKey is not required for this session.");
      }

      const [existing] = await tx`
        select * from healthkit_backfill_scope_manifests
        where session_id = ${sessionId} and scope_key = ${scopeKey}
      `;
      if (existing) {
        if (existing.manifest_hash === input.manifestHash && Number(existing.event_count) === input.eventCount) {
          return {
            sessionId,
            scopeKey,
            status: "duplicate" as const,
            eventCount: Number(existing.event_count)
          };
        }
        throw new HttpError(409, "event_conflict", "Scope manifest conflicts with a previous upload.");
      }

      const eventRows = await tx`
        select event_id from healthkit_sync_events
        where session_id = ${sessionId} and scope_key = ${scopeKey}
        order by event_id asc
      `;
      const eventIds = eventRows.map((r: Row) => String(r.event_id).toLowerCase());
      if (eventIds.length !== input.eventCount) {
        throw new HttpError(
          409,
          "session_incomplete",
          `Manifest eventCount ${input.eventCount} does not match received ${eventIds.length}.`
        );
      }

      const expectedHash = fingerprintScopeManifest(
        { sessionId, scopeKey, eventIds },
        nodeSha256
      );
      if (expectedHash !== input.manifestHash.toLowerCase()) {
        throw new HttpError(409, "manifest_incomplete", "Scope manifest hash does not match received events.");
      }

      await tx`
        insert into healthkit_backfill_scope_manifests (
          session_id, scope_key, event_count, manifest_hash, status
        ) values (
          ${sessionId}, ${scopeKey}, ${input.eventCount}, ${expectedHash}, 'accepted'
        )
      `;

      return {
        sessionId,
        scopeKey,
        status: "accepted" as const,
        eventCount: input.eventCount
      };
    });
  }

  async completeBackfillSession(
    actorUserId: string,
    sessionId: string,
    input: CompleteHealthKitBackfillSessionInput
  ): Promise<HealthKitBackfillSessionCompleteResult> {
    const current = await this.context.requireActiveMember(actorUserId);
    const selfId = await this.requireLinkedSelfProfileId(actorUserId, current.family.id);
    assertSelfProfileMatch({ selfProfileId: selfId, requestedPersonId: input.personId });
    const nowIso = toUtcIso(new Date());

    const result = await this.context.sql.begin(async (tx: any) => {
      const [session] = await tx`select * from healthkit_backfill_sessions where session_id = ${sessionId}`;
      if (!session || session.person_id !== input.personId) {
        throw new HttpError(400, "session_expired", "Backfill session is invalid.");
      }
      if (session.status === "completed") {
        return {
          sessionId,
          group: session.group_key as HealthKitMetric,
          completed: true as const
        };
      }
      this.assertOpenSession(session, input, session.group_key as HealthKitMetric);

      const required: string[] = session.required_scope_keys ?? [];
      const manifests = await tx`
        select scope_key from healthkit_backfill_scope_manifests where session_id = ${sessionId}
      `;
      const accepted = new Set(manifests.map((m: Row) => m.scope_key as string));
      for (const scope of required) {
        if (!accepted.has(scope)) {
          throw new HttpError(409, "session_incomplete", `Missing scope manifest for ${scope}.`);
        }
      }

      // Stale timezone-version rows for sleep/daily after successful backfill.
      if (session.group_key === "sleep") {
        const range = sessionRangeFromRow(session);
        await tx`
          delete from health_sleep_days
          where person_id = ${selfId}
            and timezone_version < ${session.timezone_version}
            and sleep_day >= ${range.rangeStartDay}::date
            and sleep_day <= ${range.rangeEndDay}::date
        `;
      }

      await tx`
        update healthkit_backfill_sessions
        set status = 'completed', completed_at = ${nowIso}
        where session_id = ${sessionId}
      `;

      await this.touchGroupState(tx, {
        familyId: current.family.id,
        personId: input.personId,
        group: session.group_key as HealthKitMetric,
        nowIso,
        status: "ready",
        success: true,
        coverageStartAt: toIso(session.range_start),
        coverageEndAt: toIso(session.range_end)
      });

      return {
        sessionId,
        group: session.group_key as HealthKitMetric,
        completed: true as const
      };
    });

    await this.context.audit({
      familyId: current.family.id,
      actorUserId,
      action: "healthkit.session_completed",
      resourceType: "healthkit_backfill_session",
      resourceId: sessionId,
      metadata: { group: result.group, status: "completed" }
    });

    return result;
  }

  async abortBackfillSession(
    actorUserId: string,
    sessionId: string,
    input: AbortHealthKitBackfillSessionInput
  ): Promise<HealthKitBackfillSessionAbortResult> {
    const current = await this.context.requireActiveMember(actorUserId);
    const selfId = await this.requireLinkedSelfProfileId(actorUserId, current.family.id);
    assertSelfProfileMatch({ selfProfileId: selfId, requestedPersonId: input.personId });
    const nowIso = toUtcIso(new Date());

    const result = await this.context.sql.begin(async (tx: any) => {
      const [session] = await tx`select * from healthkit_backfill_sessions where session_id = ${sessionId}`;
      if (!session || session.person_id !== input.personId) {
        throw new HttpError(400, "session_expired", "Backfill session is invalid.");
      }
      if (session.status === "aborted" || session.status === "completed") {
        return {
          sessionId,
          group: session.group_key as HealthKitMetric,
          aborted: true as const
        };
      }

      const authority = await this.loadWriteAuthority(tx, actorUserId, current.family.id, input.personId);
      if (authority.activeInstallationId !== input.installationId) {
        throw new HttpError(403, "installation_inactive", "Installation is not the active HealthKit installation.");
      }

      await tx`
        update healthkit_backfill_sessions
        set status = 'aborted', aborted_at = ${nowIso}, abort_reason = ${input.reason ?? null}
        where session_id = ${sessionId}
      `;

      await this.touchGroupState(tx, {
        familyId: current.family.id,
        personId: input.personId,
        group: session.group_key as HealthKitMetric,
        nowIso,
        status: "error",
        lastErrorCode: input.reason ?? "session_aborted"
      });

      return {
        sessionId,
        group: session.group_key as HealthKitMetric,
        aborted: true as const
      };
    });

    return result;
  }

  async getBackfillSession(actorUserId: string, sessionId: string): Promise<HealthKitBackfillSession> {
    const current = await this.context.requireActiveMember(actorUserId);
    const selfId = await this.requireLinkedSelfProfileId(actorUserId, current.family.id);
    const [session] = await this.context.sql`
      select * from healthkit_backfill_sessions where session_id = ${sessionId}
    `;
    if (!session || session.person_id !== selfId) {
      throw new HttpError(404, "session_expired", "Backfill session not found.");
    }
    const [{ count }] = await this.context.sql`
      select count(*)::int as count from healthkit_sync_events where session_id = ${sessionId}
    `;
    return mapSession(session, Number(count));
  }

  async listBackfillPending(
    actorUserId: string,
    sessionId: string,
    cursor?: string,
    limit = 100
  ): Promise<{ eventIds: string[]; nextCursor?: string }> {
    const current = await this.context.requireActiveMember(actorUserId);
    const selfId = await this.requireLinkedSelfProfileId(actorUserId, current.family.id);
    const [session] = await this.context.sql`
      select person_id from healthkit_backfill_sessions where session_id = ${sessionId}
    `;
    if (!session || session.person_id !== selfId) {
      throw new HttpError(404, "session_expired", "Backfill session not found.");
    }
    const safeLimit = Math.min(Math.max(limit, 1), 100);
    const rows = cursor
      ? await this.context.sql`
          select event_id from healthkit_sync_events
          where session_id = ${sessionId} and event_id > ${cursor}::uuid
          order by event_id asc
          limit ${safeLimit}
        `
      : await this.context.sql`
          select event_id from healthkit_sync_events
          where session_id = ${sessionId}
          order by event_id asc
          limit ${safeLimit}
        `;
    const eventIds = rows.map((r: Row) => String(r.event_id));
    return {
      eventIds,
      nextCursor: eventIds.length === safeLimit ? eventIds[eventIds.length - 1] : undefined
    };
  }

  async getGroupManifest(
    actorUserId: string,
    group: HealthKitMetric,
    personId?: string
  ): Promise<HealthKitGroupManifest> {
    const current = await this.context.requireActiveMember(actorUserId);
    const selfId = await this.requireLinkedSelfProfileId(actorUserId, current.family.id);
    const target = personId ?? selfId;
    assertSelfProfileMatch({ selfProfileId: selfId, requestedPersonId: target });

    const [active] = await this.context.sql`
      select installation_id from healthkit_sync_installations
      where person_id = ${target} and revoked_at is null
      limit 1
    `;
    if (!active) {
      return { personId: target, group, entityCount: 0, entities: [] };
    }

    const scopes = requiredScopeKeysForGroup(group);
    // Filter by group scopes in SQL before the limit so large installations do not
    // silently omit a group's entity rows that fall past a global 10k cap.
    const likePatterns = scopes.flatMap((scope) => {
      switch (scope) {
        case "steps":
          return ["steps_hour:%"];
        case "sleep":
          return ["sleep_day:%"];
        case "blood_pressure":
          return ["blood_pressure:%"];
        case "blood_glucose":
          return ["blood_glucose:%"];
        case "workout":
          return ["workout:%"];
        default:
          return [`daily_metric:${scope}:%`];
      }
    });

    let rows: Row[] = [];
    if (likePatterns.length > 0) {
      // Build OR of LIKE patterns for this group's entity key prefixes.
      const conditions = likePatterns.map((_, i) => `entity_key like $${i + 3}`).join(" or ");
      rows = await this.context.sql.unsafe(
        `select entity_key, entity_version, fingerprint, op
         from healthkit_sync_entities
         where person_id = $1
           and installation_id = $2
           and (${conditions})
         order by entity_key asc
         limit 10000`,
        [target, active.installation_id, ...likePatterns]
      );
    }

    const entities = rows.map((row: Row) => ({
      entityKey: row.entity_key as string,
      entityVersion: Number(row.entity_version),
      fingerprint: row.fingerprint as string,
      op: row.op as "upsert" | "delete"
    }));

    return {
      personId: target,
      group,
      installationId: active.installation_id,
      entityCount: entities.length,
      entities
    };
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
      throw new HttpError(400, "payload_invalid", "The requested metric is not stored as a daily aggregate.");
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

  private assertOpenSession(
    session: Row,
    input: { installationId: string; timezoneVersion: number },
    group: HealthKitMetric
  ) {
    if (session.status !== "open") {
      throw new HttpError(400, "session_expired", "Backfill session is not open.");
    }
    if (Date.parse(String(session.expires_at)) <= Date.now()) {
      throw new HttpError(400, "session_expired", "Backfill session is expired.");
    }
    if (session.installation_id !== input.installationId) {
      throw new HttpError(403, "installation_inactive", "Session does not belong to this installation.");
    }
    if (Number(session.timezone_version) !== input.timezoneVersion) {
      throw new HttpError(409, "timezone_stale", "Timezone version is stale.");
    }
    if (session.group_key !== group && group) {
      // group check optional when session already carries group
    }
  }

  private async applyOneEvent(
    tx: any,
    input: {
      familyId: string;
      personId: string;
      installationId: string;
      timezoneVersion: number;
      event: HealthKitSyncEvent;
      fingerprint: string;
      nowIso: string;
    }
  ): Promise<HealthKitEventApplyResult> {
    const { event, fingerprint } = input;

    // Claim the immutable event before writing canonical data. A retried request waits
    // for this transaction, then observes the matching claim as a duplicate.
    const receipt = await this.claimEventReceipt(tx, input);
    if (receipt === "duplicate") {
      return { eventId: event.eventId, result: "duplicate" };
    }

    const [entity] = await tx`
      select entity_version, fingerprint from healthkit_sync_entities
      where person_id = ${input.personId}
        and installation_id = ${input.installationId}
        and entity_key = ${event.entityKey}
    `;

    if (entity) {
      const latestVersion = Number(entity.entity_version);
      if (event.entityVersion < latestVersion) {
        await this.setEventReceiptResult(tx, event.eventId, "superseded");
        return { eventId: event.eventId, result: "superseded" };
      }
      if (event.entityVersion === latestVersion) {
        if (entity.fingerprint !== fingerprint) {
          throw new HttpError(409, "event_conflict", "Entity version reused with a different fingerprint.");
        }
        await this.setEventReceiptResult(tx, event.eventId, "duplicate");
        return { eventId: event.eventId, result: "duplicate" };
      }
    }

    // Higher version (or first version): apply canonical write + entity row.
    await this.applyCanonical(tx, {
      familyId: input.familyId,
      personId: input.personId,
      timezoneVersion: input.timezoneVersion,
      event,
      nowIso: input.nowIso
    });

    await tx`
      insert into healthkit_sync_entities (
        person_id, family_id, installation_id, entity_key, entity_version,
        fingerprint, op, last_event_id, updated_at
      ) values (
        ${input.personId}, ${input.familyId}, ${input.installationId}, ${event.entityKey},
        ${event.entityVersion}, ${fingerprint}, ${event.op}, ${event.eventId}, ${input.nowIso}
      )
      on conflict (person_id, installation_id, entity_key) do update set
        entity_version = excluded.entity_version,
        fingerprint = excluded.fingerprint,
        op = excluded.op,
        last_event_id = excluded.last_event_id,
        updated_at = excluded.updated_at
    `;

    // Incremental success does not flip never_synced/backfilling to ready.
    if (!event.sessionId) {
      await this.touchGroupState(tx, {
        familyId: input.familyId,
        personId: input.personId,
        group: event.group,
        nowIso: input.nowIso,
        success: true,
        touchOnly: true
      });
    }

    return { eventId: event.eventId, result: "applied" };
  }

  private async claimEventReceipt(
    tx: any,
    input: {
      familyId: string;
      personId: string;
      installationId: string;
      timezoneVersion: number;
      event: HealthKitSyncEvent;
      fingerprint: string;
      nowIso: string;
    }
  ): Promise<"inserted" | "duplicate"> {
    const { event, fingerprint } = input;
    const inserted = await tx`
      insert into healthkit_sync_events (
        event_id, person_id, family_id, installation_id, entity_key, entity_version,
        group_key, scope_key, op, session_id, fingerprint, apply_result, received_at
      ) values (
        ${event.eventId}, ${input.personId}, ${input.familyId}, ${input.installationId},
        ${event.entityKey}, ${event.entityVersion}, ${event.group}, ${event.scopeKey},
        ${event.op}, ${event.sessionId ?? null}, ${fingerprint}, 'applied', ${input.nowIso}
      )
      on conflict (event_id) do nothing
      returning event_id
    `;
    if (inserted.length > 0) return "inserted";

    const [existing] = await tx`
      select fingerprint from healthkit_sync_events where event_id = ${event.eventId}
    `;
    if (!existing || existing.fingerprint !== fingerprint) {
      throw new HttpError(409, "event_conflict", "Event id was reused with a different fingerprint.");
    }
    return "duplicate";
  }

  private async setEventReceiptResult(
    tx: any,
    eventId: string,
    applyResult: "duplicate" | "superseded"
  ) {
    await tx`
      update healthkit_sync_events
      set apply_result = ${applyResult}
      where event_id = ${eventId}
    `;
  }

  private async applyCanonical(
    tx: any,
    input: {
      familyId: string;
      personId: string;
      timezoneVersion: number;
      event: HealthKitSyncEvent;
      nowIso: string;
    }
  ) {
    const { event } = input;
    if (event.op === "delete") {
      await this.applyDelete(tx, input.personId, event.entityKey, input.timezoneVersion);
      return;
    }

    const payload = event.payload!;
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
            maximum_heart_rate_bpm, updated_at
          ) values (
            ${input.familyId}, ${input.personId}, ${payload.sourceSampleKey}, ${payload.workoutType},
            ${payload.startedAtUtc}, ${payload.endedAtUtc}, ${payload.durationSeconds},
            ${payload.activeEnergyKcal ?? null}, ${payload.distanceMeters ?? null},
            ${payload.averageHeartRateBpm ?? null}, ${payload.maximumHeartRateBpm ?? null}, ${input.nowIso}
          )
          on conflict (person_id, source_sample_key) do update set
            workout_type = excluded.workout_type, started_at = excluded.started_at, ended_at = excluded.ended_at,
            duration_seconds = excluded.duration_seconds, active_energy_kcal = excluded.active_energy_kcal,
            distance_meters = excluded.distance_meters, average_heart_rate_bpm = excluded.average_heart_rate_bpm,
            maximum_heart_rate_bpm = excluded.maximum_heart_rate_bpm, updated_at = excluded.updated_at
        `;
        return;
    }
  }

  private async applyDelete(tx: any, personId: string, entityKey: string, timezoneVersion: number) {
    if (entityKey.startsWith("steps_hour:")) {
      const hour = entityKey.slice("steps_hour:".length);
      await tx`delete from health_step_hours where person_id = ${personId} and hour_start_utc = ${hour}::timestamptz`;
      return;
    }
    if (entityKey.startsWith("sleep_day:")) {
      const day = entityKey.slice("sleep_day:".length);
      await tx`delete from health_sleep_days where person_id = ${personId} and sleep_day = ${day}::date and timezone_version = ${timezoneVersion}`;
      return;
    }
    if (entityKey.startsWith("daily_metric:")) {
      const rest = entityKey.slice("daily_metric:".length);
      const idx = rest.lastIndexOf(":");
      const metric = rest.slice(0, idx);
      const day = rest.slice(idx + 1);
      await tx`delete from health_daily_metrics where person_id = ${personId} and metric_key = ${metric} and local_day = ${day}::date and timezone_version = ${timezoneVersion}`;
      return;
    }
    if (entityKey.startsWith("blood_pressure:")) {
      const key = entityKey.slice("blood_pressure:".length);
      await tx`delete from health_blood_pressure_readings where person_id = ${personId} and source_sample_key = ${key}::uuid`;
      return;
    }
    if (entityKey.startsWith("blood_glucose:")) {
      const key = entityKey.slice("blood_glucose:".length);
      await tx`delete from health_blood_glucose_readings where person_id = ${personId} and source_sample_key = ${key}::uuid`;
      return;
    }
    if (entityKey.startsWith("workout:")) {
      const key = entityKey.slice("workout:".length);
      await tx`delete from health_workouts where person_id = ${personId} and source_sample_key = ${key}::uuid`;
      return;
    }
    throw new HttpError(400, "payload_invalid", "Unknown entity key for delete.");
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

  private async touchGroupState(
    tx: any,
    input: {
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
    }
  ) {
    const [existing] = await tx`
      select * from healthkit_sync_state where person_id = ${input.personId} and group_key = ${input.group}
    `;
    let status: HealthMetricSyncStatusCode =
      input.status ?? (existing?.status as HealthMetricSyncStatusCode) ?? "never_synced";

    if (input.touchOnly) {
      // Keep backfilling / never_synced until session completes.
      if (status === "error" && input.success) {
        // leave error until explicit recovery; still record attempt
      }
    }

    const success = Boolean(input.success);
    const lastSuccessfulAt = success ? input.nowIso : (existing?.last_successful_at ?? null);
    const lastErrorCode =
      input.lastErrorCode ?? (success ? null : (existing?.last_error_code ?? null));
    const coverageStartAt = input.coverageStartAt ?? existing?.coverage_start_at ?? null;
    const coverageEndAt = input.coverageEndAt ?? existing?.coverage_end_at ?? null;
    const explicitError = input.lastErrorCode ?? null;

    await tx`
      insert into healthkit_sync_state (
        person_id, family_id, group_key, last_successful_at, last_attempt_at, last_error_code,
        coverage_start_at, coverage_end_at, status, updated_at
      ) values (
        ${input.personId},
        ${input.familyId},
        ${input.group},
        ${lastSuccessfulAt},
        ${input.nowIso},
        ${lastErrorCode},
        ${coverageStartAt},
        ${coverageEndAt},
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
