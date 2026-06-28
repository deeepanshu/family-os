import type { CreateInviteResponse, CurrentFamilyResponse, HealthProfile, PublicInviteResponse } from "@family-os/shared";
import { HttpError } from "../../errors";
import type { CreateFamilyInput, CreateInviteInput, CreateProfileInput, UpdateProfileInput } from "../families";
import { currentInviteStatus, hashToken, PostgresRepositoryContext } from "./context";
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
      const [family] = await tx`
        insert into families (name, created_by_user_id)
        values (${input.name}, ${input.userId})
        returning *
      `;
      const createdFamily = requireRow(family, "Failed to create family.");
      const [membership] = await tx`
        insert into family_memberships (family_id, user_id, role, status)
        values (${createdFamily.id}, ${input.userId}, 'manager', 'active')
        returning *
      `;
      const createdMembership = requireRow(membership, "Failed to create family membership.");
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

      return { family: mapFamily(createdFamily), membership: mapMembership(createdMembership) };
    });
  }

  getCurrentFamily(userId: string): Promise<CurrentFamilyResponse> {
    return this.context.getCurrentFamily(userId);
  }

  async createInvite(input: CreateInviteInput): Promise<CreateInviteResponse> {
    const current = await this.context.requireManager(input.actorUserId, "Only family managers can create invites.");
    const token = crypto.randomUUID().replaceAll("-", "");
    const [invite] = await this.context.sql`
      insert into family_invites (family_id, invited_by_user_id, email, token_hash, role, status, expires_at)
      values (
        ${current.family.id},
        ${input.actorUserId},
        ${input.email ?? null},
        ${hashToken(token)},
        ${input.role},
        'pending',
        now() + interval '7 days'
      )
      returning *
    `;
    const createdInvite = requireRow(invite, "Failed to create invite.");
    await this.context.audit({
      familyId: current.family.id,
      actorUserId: input.actorUserId,
      action: "invite.created",
      resourceType: "invite",
      resourceId: createdInvite.id,
      metadata: { role: input.role }
    });
    return { invite: mapInvite(createdInvite), token };
  }

  async getInviteByToken(token: string): Promise<PublicInviteResponse> {
    const invite = await this.context.findInvite(token);
    const [family] = await this.context.sql`select name from families where id = ${invite.familyId}`;
    if (!family) {
      throw new HttpError(404, "invite_not_found", "Invite was not found.");
    }
    return {
      familyName: family.name,
      role: invite.role,
      status: currentInviteStatus(invite),
      expiresAt: invite.expiresAt
    };
  }

  async acceptInvite(token: string, userId: string, userEmail?: string): Promise<CurrentFamilyResponse> {
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
      if (currentInviteStatus(invite) !== "pending") {
        throw new HttpError(409, "invite_not_pending", "Invite is not pending.");
      }
      if (invite.email && invite.email.toLowerCase() !== userEmail?.toLowerCase()) {
        throw new HttpError(403, "invite_email_mismatch", "Invite is assigned to a different email.");
      }

      const [existing] = await tx`
        select 1
        from family_memberships
        where user_id = ${userId}
          and status = 'active'
        limit 1
      `;
      if (existing) {
        throw new HttpError(409, "family_already_exists", "User already has an active family.");
      }

      await tx`
        update family_invites
        set status = 'accepted', accepted_by_user_id = ${userId}, accepted_at = now()
        where id = ${invite.id}
      `;
      const [membership] = await tx`
        insert into family_memberships (family_id, user_id, role, status)
        values (${invite.familyId}, ${userId}, ${invite.role}, 'active')
        returning *
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

      return { family: mapFamily(acceptedFamily), membership: mapMembership(createdMembership) };
    });
  }

  async listProfiles(actorUserId: string): Promise<HealthProfile[]> {
    const current = await this.context.requireActiveMember(actorUserId);
    const rows = await this.context.sql`
      select *
      from people
      where family_id = ${current.family.id}
        and status = 'active'
      order by created_at asc
    `;
    return rows.map(mapProfile);
  }

  async getProfile(actorUserId: string, profileId: string): Promise<HealthProfile> {
    const current = await this.context.requireActiveMember(actorUserId);
    const [profile] = await this.context.sql`
      select *
      from people
      where id = ${profileId}
        and family_id = ${current.family.id}
        and status = 'active'
    `;
    if (!profile) {
      throw new HttpError(404, "profile_not_found", "Health profile was not found.");
    }
    return mapProfile(profile);
  }

  async createProfile(input: CreateProfileInput): Promise<HealthProfile> {
    const current = await this.context.requireManager(input.actorUserId, "Only family managers can manage health profiles.");
    const [profile] = await this.context.sql`
      insert into people (family_id, created_by_user_id, display_name, relationship_label, date_of_birth, status)
      values (${current.family.id}, ${input.actorUserId}, ${input.displayName}, ${input.relationshipLabel ?? null}, ${input.dateOfBirth ?? null}, 'active')
      returning *
    `;
    const createdProfile = requireRow(profile, "Failed to create profile.");
    await this.context.audit({
      familyId: current.family.id,
      actorUserId: input.actorUserId,
      action: "profile.created",
      resourceType: "profile",
      resourceId: createdProfile.id
    });
    return mapProfile(createdProfile);
  }

  async updateProfile(actorUserId: string, profileId: string, input: UpdateProfileInput): Promise<HealthProfile> {
    const current = await this.context.requireManager(actorUserId, "Only family managers can manage health profiles.");
    const [profile] = await this.context.sql`
      update people
      set
        display_name = coalesce(${input.displayName ?? null}, display_name),
        relationship_label = coalesce(${input.relationshipLabel ?? null}, relationship_label),
        date_of_birth = coalesce(${input.dateOfBirth ?? null}, date_of_birth),
        status = coalesce(${input.status ?? null}, status)
      where id = ${profileId}
        and family_id = ${current.family.id}
      returning *
    `;
    if (!profile) {
      throw new HttpError(404, "profile_not_found", "Health profile was not found.");
    }
    await this.context.audit({
      familyId: current.family.id,
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

