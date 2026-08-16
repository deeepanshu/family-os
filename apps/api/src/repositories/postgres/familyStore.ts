import type { AcceptInviteInput, BootstrapResponse, CreatedInvite, CurrentFamilyResponse, FamilyMember, FamilyMembership, HealthProfile, PublicInviteResponse } from "@family-os/shared";
import { HttpError } from "../../errors";
import type { CreateFamilyInput, CreateInviteInput, CreateProfileInput, UpdateProfileInput } from "../families";
import { currentInviteStatus, hashToken, PostgresRepositoryContext } from "./context";
import { toIso } from "./dateUtils";
import { mapFamily, mapInvite, mapMembership, mapProfile } from "./mappers";
import { requireRow } from "./types";

export class PostgresFamilyStore {
  constructor(private readonly context: PostgresRepositoryContext) {}

  async createFamily(input: CreateFamilyInput): Promise<CurrentFamilyResponse> {
    await this.context.syncAuthUser(input.userId);
    if (await this.context.getCurrentFamily(input.userId)) {
      throw new HttpError(409, "family_already_exists", "User already has an active family.");
    }

    return this.context.sql.begin(async (tx: any) => {
      await tx`
        update family_memberships fm
        set status = 'removed', updated_at = now()
        from families f
        where fm.family_id = f.id
          and f.kind = 'personal'
          and fm.user_id = ${input.userId}
          and fm.status = 'active'
      `;
      await tx`
        update people
        set family_id = null, updated_at = now()
        where linked_user_id = ${input.userId}
          and family_id in (select id from families where kind = 'personal')
      `;
      const [family] = await tx`
        insert into families (name, kind, created_by_user_id)
        values (${input.name}, 'family', ${input.userId})
        returning *
      `;
      const createdFamily = requireRow(family, "Failed to create family.");
      const [membership] = await tx`
        insert into family_memberships (family_id, user_id, role, status)
        values (${createdFamily.id}, ${input.userId}, 'manager', 'active')
        returning *
      `;
      const createdMembership = requireRow(membership, "Failed to create family membership.");

      // Attach solo Self person to this household when present.
      await tx`
        update people
        set family_id = ${createdFamily.id}, updated_at = now()
        where linked_user_id = ${input.userId}
          and relationship_label = 'Self'
          and status = 'active'
          and family_id is null
      `;

      await this.context.audit(
        {
          familyId: createdFamily.id,
          actorUserId: input.userId,
          action: "family.created",
          resourceType: "family",
          resourceId: createdFamily.id
        },
        tx
      );

      return this.withHouseholdExtras({
        family: mapFamily(createdFamily),
        membership: mapMembership(createdMembership)
      });
    });
  }

  async getCurrentFamily(userId: string): Promise<CurrentFamilyResponse> {
    const current = await this.context.getCurrentFamily(userId);
    if (!current) {
      return null;
    }
    return this.withHouseholdExtras(current);
  }

  async listMembers(actorUserId: string): Promise<FamilyMember[]> {
    const current = await this.context.requireActiveMember(actorUserId);
    const rows = await this.context.sql`
      select
        fm.*,
        u.email as user_email,
        p.display_name as self_display_name
      from family_memberships fm
      left join auth.users u on u.id = fm.user_id
      left join people p on p.family_id = fm.family_id
        and p.linked_user_id = fm.user_id
        and p.relationship_label = 'Self'
        and p.status = 'active'
      where fm.family_id = ${current.family.id}
        and fm.status = 'active'
      order by fm.created_at asc
    `;
    return rows.map((row: any) => ({
      membership: mapMembership(row),
      email: row.user_email ?? undefined,
      displayName: row.self_display_name ?? undefined
    }));
  }

  async leaveFamily(actorUserId: string): Promise<void> {
    const current = await this.context.requireActiveMember(actorUserId);
    if (current.family.createdByUserId === actorUserId) {
      throw new HttpError(403, "creator_cannot_leave", "The family creator cannot leave. Remove other members and delete the family.");
    }
    await this.context.sql.begin(async (tx: any) => {
      await this.deactivateMembership(tx, current.family.id, actorUserId);
      await this.detachSelf(tx, actorUserId);
    });
  }

  async removeMember(actorUserId: string, memberUserId: string): Promise<void> {
    const current = await this.context.requireCreator(actorUserId, "Only the family creator can remove a member.");
    if (memberUserId === actorUserId) {
      throw new HttpError(400, "cannot_remove_self", "The creator cannot remove themselves.");
    }
    await this.context.sql.begin(async (tx: any) => {
      const [target] = await tx`
        select id
        from family_memberships
        where family_id = ${current.family.id}
          and user_id = ${memberUserId}
          and status = 'active'
        for update
      `;
      if (!target) {
        throw new HttpError(404, "member_not_found", "Family member was not found.");
      }
      await this.deactivateMembership(tx, current.family.id, memberUserId);
      await this.detachSelf(tx, memberUserId);
      await this.revokePendingInvites(tx, current.family.id);
    });
  }

  async deleteFamily(actorUserId: string): Promise<void> {
    const current = await this.context.requireCreator(actorUserId, "Only the family creator can delete the family.");
    await this.context.sql.begin(async (tx: any) => {
      const [others] = await tx`
        select count(*)::int as count
        from family_memberships
        where family_id = ${current.family.id}
          and status = 'active'
          and user_id <> ${actorUserId}
      `;
      if (others && Number(others.count) > 0) {
        throw new HttpError(409, "family_not_empty", "Remove every other member before deleting the family.");
      }
      await this.deactivateMembership(tx, current.family.id, actorUserId);
      await this.detachSelf(tx, actorUserId);
      await this.revokePendingInvites(tx, current.family.id);
      await tx`delete from families where id = ${current.family.id}`;
    });
  }

  private async deactivateMembership(tx: any, familyId: string, userId: string) {
    await tx`
      update family_memberships
      set status = 'removed', updated_at = now()
      where family_id = ${familyId}
        and user_id = ${userId}
        and status = 'active'
    `;
  }

  private async detachSelf(tx: any, userId: string) {
    await tx`
      update people
      set family_id = null, updated_at = now()
      where linked_user_id = ${userId}
        and relationship_label = 'Self'
        and status = 'active'
    `;
  }

  private async revokePendingInvites(tx: any, familyId: string) {
    await tx`
      update family_invites
      set status = 'revoked', share_token = null, updated_at = now()
      where family_id = ${familyId}
        and status = 'pending'
    `;
  }

  async bootstrap(userId: string): Promise<BootstrapResponse> {
    await this.context.syncAuthUser(userId);
    // Solo-first: do not auto-create a family. Household is opt-in via createFamily later.
    const current = await this.getCurrentFamily(userId);
    const selfProfile = await this.getSelfProfile(userId);
    const profiles = selfProfile
      ? current
        ? await this.listProfiles(userId)
        : [selfProfile]
      : [];

    return {
      family: current?.family ?? null,
      membership: current?.membership ?? null,
      creatorDisplayName: current?.creatorDisplayName,
      liveInvite: current?.liveInvite,
      profiles,
      selfProfile,
      needsProfileSetup: selfProfile === null
    };
  }

  private async withHouseholdExtras(
    current: NonNullable<CurrentFamilyResponse>
  ): Promise<NonNullable<CurrentFamilyResponse>> {
    const [creator] = await this.context.sql`
      select display_name
      from people
      where linked_user_id = ${current.family.createdByUserId}
        and relationship_label = 'Self'
        and status = 'active'
      limit 1
    `;
    let liveInvite: NonNullable<CurrentFamilyResponse>["liveInvite"];
    if (current.family.createdByUserId === current.membership.userId) {
      const [invite] = await this.context.sql`
        select share_token, expires_at, status
        from family_invites
        where family_id = ${current.family.id}
          and status = 'pending'
        limit 1
      `;
      if (invite?.share_token && currentInviteStatus({
        id: "live",
        familyId: current.family.id,
        status: invite.status,
        expiresAt: toIso(invite.expires_at),
        createdAt: current.family.createdAt
      }) === "pending") {
        liveInvite = {
          expiresAt: toIso(invite.expires_at),
          status: "pending",
          token: invite.share_token
        };
      }
    }
    return {
      ...current,
      creatorDisplayName: creator?.display_name ?? current.creatorDisplayName,
      liveInvite
    };
  }

  async createSelfProfile(actorUserId: string, displayName: string): Promise<HealthProfile> {
    await this.context.syncAuthUser(actorUserId);
    const existing = await this.getSelfProfile(actorUserId);
    if (existing) {
      return existing;
    }

    const current = await this.context.getCurrentFamily(actorUserId);
    const [profile] = await this.context.sql`
      insert into people (family_id, linked_user_id, created_by_user_id, display_name, relationship_label, status)
      values (${current?.family.id ?? null}, ${actorUserId}, ${actorUserId}, ${displayName}, 'Self', 'active')
      returning *
    `;
    const createdProfile = requireRow(profile, "Failed to create self profile.");
    await this.context.audit({
      familyId: null,
      actorUserId,
      action: "profile.created",
      resourceType: "profile",
      resourceId: createdProfile.id
    });
    return mapProfile(createdProfile);
  }

  async getSelfProfile(actorUserId: string): Promise<HealthProfile | null> {
    const [profile] = await this.context.sql`
      select *
      from people
      where linked_user_id = ${actorUserId}
        and relationship_label = 'Self'
        and status = 'active'
      limit 1
    `;
    return profile ? mapProfile(profile) : null;
  }

  async createInvite(input: CreateInviteInput): Promise<CreatedInvite> {
    const current = await this.context.requireCreator(input.actorUserId, "Only the family creator can create invites.");

    return this.context.sql.begin(async (tx: any) => {
      await tx`
        update family_invites
        set status = 'revoked', share_token = null, updated_at = now()
        where family_id = ${current.family.id}
          and status = 'pending'
      `;

      const token = crypto.randomUUID().replaceAll("-", "");
      const [invite] = await tx`
        insert into family_invites (family_id, invited_by_user_id, email, token_hash, role, status, expires_at, share_token)
        values (
          ${current.family.id},
          ${input.actorUserId},
          ${null},
          ${hashToken(token)},
          'member',
          'pending',
          now() + interval '1 hour',
          ${token}
        )
        returning *
      `;
      const createdInvite = requireRow(invite, "Failed to create invite.");
      await this.context.audit(
        {
          familyId: current.family.id,
          actorUserId: input.actorUserId,
          action: "invite.created",
          resourceType: "invite",
          resourceId: createdInvite.id
        },
        tx
      );
      return { invite: mapInvite(createdInvite), token };
    });
  }

  async getInviteByToken(token: string): Promise<PublicInviteResponse> {
    const invite = await this.context.findInvite(token);
    const [family] = await this.context.sql`select name from families where id = ${invite.familyId}`;
    if (!family) {
      throw new HttpError(404, "invite_not_found", "Invite was not found.");
    }
    const [creator] = await this.context.sql`
      select display_name
      from people
      where linked_user_id = (
        select created_by_user_id from families where id = ${invite.familyId}
      )
        and relationship_label = 'Self'
        and status = 'active'
      limit 1
    `;
    return {
      familyName: family.name,
      creatorDisplayName: creator?.display_name ?? "Family member",
      status: currentInviteStatus(invite),
      expiresAt: invite.expiresAt
    };
  }

  async acceptInvite(token: string, userId: string, input: AcceptInviteInput): Promise<CurrentFamilyResponse> {
    await this.context.syncAuthUser(userId);
    return this.context.sql.begin(async (tx: any) => {
      const [inviteRow] = await tx`
        select *
        from family_invites
        where token_hash = ${hashToken(token)}
        for update
      `;
      if (!inviteRow) {
        throw new HttpError(404, "invite_not_found", "Invite was not found.");
      }
      const invite = mapInvite(inviteRow);
      const inviteStatus = currentInviteStatus(invite);
      if (inviteStatus === "expired") {
        throw new HttpError(409, "invite_expired", "Invite has expired.");
      }
      if (inviteStatus === "accepted") {
        throw new HttpError(409, "invite_already_used", "Invite has already been used.");
      }
      if (inviteStatus !== "pending") {
        throw new HttpError(409, "invite_not_pending", "Invite is not pending.");
      }

      const [familyRow] = await tx`select * from families where id = ${invite.familyId}`;
      if (!familyRow) {
        throw new HttpError(404, "invite_not_found", "Invite was not found.");
      }
      if (familyRow.created_by_user_id === userId) {
        throw new HttpError(409, "invite_own_family", "You cannot join your own family invite.");
      }

      const [existingMembership] = await tx`
        select fm.*
        from family_memberships fm
        join families f on f.id = fm.family_id
        where fm.user_id = ${userId}
          and fm.status = 'active'
          and f.kind = 'family'
        for update
      `;
      if (existingMembership) {
        throw new HttpError(409, "family_already_exists", "User already has an active family.");
      }

      await tx`
        update family_invites
        set status = 'accepted', share_token = null, accepted_by_user_id = ${userId}, accepted_at = now()
        where id = ${invite.id}
      `;
      const [membership] = await tx`
        insert into family_memberships (family_id, user_id, role, status, creator_relationship_label)
        values (${invite.familyId}, ${userId}, 'member', 'active', ${input.relationshipLabel})
        returning *
      `;
      await tx`
        update people
        set family_id = ${invite.familyId}, updated_at = now()
        where linked_user_id = ${userId}
          and relationship_label = 'Self'
          and status = 'active'
          and family_id is null
      `;
      const [family] = await tx`select * from families where id = ${invite.familyId}`;
      const createdMembership = requireRow(membership, "Failed to create family membership.");
      const acceptedFamily = requireRow(family, "Invite family was not found.");
      await this.context.audit(
        {
          familyId: invite.familyId,
          actorUserId: userId,
          action: "invite.accepted",
          resourceType: "invite",
          resourceId: invite.id,
          metadata: { membershipId: createdMembership.id }
        },
        tx
      );

      return this.withHouseholdExtras({
        family: mapFamily(acceptedFamily),
        membership: mapMembership(createdMembership)
      });
    });
  }

  async listProfiles(actorUserId: string): Promise<HealthProfile[]> {
    const current = await this.context.getCurrentFamily(actorUserId);
    if (current) {
      const rows = await this.context.sql`
        select p.*
        from people p
        join family_memberships fm
          on fm.user_id = p.linked_user_id
          and fm.family_id = ${current.family.id}
          and fm.status = 'active'
        where p.status = 'active'
          and p.relationship_label = 'Self'
          and p.linked_user_id is not null
        order by p.created_at asc
      `;
      return rows.map(mapProfile);
    }
    const self = await this.getSelfProfile(actorUserId);
    return self ? [self] : [];
  }

  async getProfile(actorUserId: string, profileId: string): Promise<HealthProfile> {
    // Solo-first: Self owner or same-family active member (via requirePersonAccess).
    await this.context.requirePersonAccess(actorUserId, profileId);
    const [profile] = await this.context.sql`
      select *
      from people
      where id = ${profileId}
        and status = 'active'
    `;
    if (!profile) {
      throw new HttpError(404, "profile_not_found", "Health profile was not found.");
    }
    return mapProfile(profile);
  }

  async createProfile(_input: CreateProfileInput): Promise<HealthProfile> {
    throw new HttpError(403, "ghost_profiles_unsupported", "Family members must join with their own app.");
  }

  async updateProfile(actorUserId: string, profileId: string, input: UpdateProfileInput): Promise<HealthProfile> {
    const [existing] = await this.context.sql`
      select *
      from people
      where id = ${profileId}
        and status = 'active'
    `;
    if (!existing) {
      throw new HttpError(404, "profile_not_found", "Health profile was not found.");
    }
    if (existing.linked_user_id !== actorUserId || existing.relationship_label !== "Self") {
      throw new HttpError(403, "profile_forbidden", "You can only change your own Self profile.");
    }
    const [profile] = await this.context.sql`
      update people
      set
        display_name = coalesce(${input.displayName ?? null}, display_name),
        date_of_birth = coalesce(${input.dateOfBirth ?? null}, date_of_birth),
        status = coalesce(${input.status ?? null}, status),
        relationship_label = 'Self',
        updated_at = now()
      where id = ${profileId}
        and linked_user_id = ${actorUserId}
        and relationship_label = 'Self'
      returning *
    `;
    if (!profile) {
      throw new HttpError(404, "profile_not_found", "Health profile was not found.");
    }
    await this.context.audit({
      familyId: profile.family_id ?? null,
      actorUserId,
      action: input.status === "inactive" ? "profile.deleted" : "profile.updated",
      resourceType: "profile",
      resourceId: profileId
    });
    return mapProfile(profile);
  }

  async deleteProfile(actorUserId: string, profileId: string): Promise<void> {
    await this.updateProfile(actorUserId, profileId, { status: "inactive" });
  }
}
