import { createHash } from "node:crypto";
import type { CurrentFamilyResponse, FamilyInvite, ReminderRecipient } from "@family-os/shared";
import { HttpError } from "../../errors";
import type { AuditInput } from "../families";
import { mapCurrentFamily, mapInvite, mapRecipient } from "./mappers";
import type { PgExecutor, PostgresRepositoryOptions } from "./types";

export class PostgresRepositoryContext {
  constructor(
    public readonly sql: PgExecutor,
    private readonly options: PostgresRepositoryOptions = {}
  ) {}

  async getCurrentFamily(userId: string): Promise<CurrentFamilyResponse> {
    const [row] = await this.sql`
      select
        f.id as family_id,
        f.name as family_name,
        f.created_by_user_id,
        f.created_at as family_created_at,
        f.updated_at as family_updated_at,
        fm.id as membership_id,
        fm.user_id,
        fm.role,
        fm.status,
        fm.created_at as membership_created_at,
        fm.updated_at as membership_updated_at
      from family_memberships fm
      join families f on f.id = fm.family_id
      where fm.user_id = ${userId}
        and fm.status = 'active'
      limit 1
    `;
    return row ? mapCurrentFamily(row) : null;
  }

  async requireActiveMember(userId: string): Promise<NonNullable<CurrentFamilyResponse>> {
    const current = await this.getCurrentFamily(userId);
    if (!current) {
      throw new HttpError(403, "active_member_required", "Active family membership is required.");
    }
    return current;
  }

  async requireManager(userId: string, message: string): Promise<NonNullable<CurrentFamilyResponse>> {
    const current = await this.requireActiveMember(userId);
    if (current.membership.role !== "manager") {
      throw new HttpError(403, "manager_required", message);
    }
    return current;
  }

  async requireProfileInFamily(profileId: string, familyId: string) {
    const [profile] = await this.sql`
      select 1
      from people
      where id = ${profileId}
        and family_id = ${familyId}
        and status = 'active'
    `;
    if (!profile) {
      throw new HttpError(404, "profile_not_found", "Health profile was not found.");
    }
  }

  async assertProfileInFamily(profileId: string | undefined, familyId: string) {
    if (!profileId) return;
    await this.requireProfileInFamily(profileId, familyId);
  }

  async findInvite(token: string): Promise<FamilyInvite> {
    const [invite] = await this.sql`
      select *
      from family_invites
      where token_hash = ${hashToken(token)}
    `;
    if (!invite) {
      throw new HttpError(404, "invite_not_found", "Invite was not found.");
    }
    return mapInvite(invite);
  }

  async replaceRecipients(tx: PgExecutor, familyId: string, reminderId: string, userIds: string[]): Promise<ReminderRecipient[]> {
    const uniqueIds = [...new Set(userIds)];
    if (uniqueIds.length === 0) {
      throw new HttpError(400, "recipients_required", "At least one reminder recipient is required.");
    }
    const activeRows = await tx`
      select user_id
      from family_memberships
      where family_id = ${familyId}
        and status = 'active'
        and user_id in ${tx(uniqueIds)}
    `;
    if (activeRows.length !== uniqueIds.length) {
      throw new HttpError(400, "invalid_recipient", "Reminder recipients must be active family members.");
    }

    await tx`delete from reminder_recipients where reminder_id = ${reminderId}`;
    const rows = await tx`
      insert into reminder_recipients ${tx(
        uniqueIds.map((userId) => ({ reminder_id: reminderId, user_id: userId })),
        "reminder_id",
        "user_id"
      )}
      returning *
    `;
    return rows.map(mapRecipient);
  }

  async listRecipients(reminderId: string, tx: PgExecutor = this.sql): Promise<ReminderRecipient[]> {
    const rows = await tx`
      select *
      from reminder_recipients
      where reminder_id = ${reminderId}
      order by created_at asc
    `;
    return rows.map(mapRecipient);
  }

  async audit(input: AuditInput, tx: PgExecutor = this.sql) {
    await tx`
      insert into audit_logs (family_id, actor_user_id, action, resource_type, resource_id, metadata)
      values (
        ${input.familyId},
        ${input.actorUserId ?? null},
        ${input.action},
        ${input.resourceType},
        ${input.resourceId},
        ${input.metadata ? tx.json(input.metadata) : null}
      )
    `;
  }

  async syncAuthUser(userId: string) {
    if (!this.options.syncLocalAuthUsers) return;
    await this.sql`insert into auth.users (id) values (${userId}) on conflict (id) do nothing`;
  }

  async syncAuthUsers(userIds: string[]) {
    if (!this.options.syncLocalAuthUsers) return;
    const uniqueIds = [...new Set(userIds)];
    if (uniqueIds.length === 0) return;
    await this.sql`insert into auth.users ${this.sql(uniqueIds.map((id) => ({ id })), "id")} on conflict (id) do nothing`;
  }
}

export function hashToken(token: string) {
  return createHash("sha256").update(token).digest("hex");
}

export function currentInviteStatus(invite: FamilyInvite): FamilyInvite["status"] {
  if (invite.status === "pending" && new Date(invite.expiresAt).getTime() <= Date.now()) {
    return "expired";
  }
  return invite.status;
}

