import { createHash } from "node:crypto";
import type {
  AuditLog,
  BeginHealthKitRunInput,
  BloodGlucoseReading,
  BloodPressureReading,
  BootstrapResponse,
  CompleteHealthKitRunInput,
  CreatedInvite,
  CurrentFamilyResponse,
  Family,
  FamilyInvite,
  FamilyKind,
  FamilyMember,
  FamilyMembership,
  FamilyRole,
  HealthDailyMetricRecord,
  HealthKitConsentGroup,
  HealthKitGroupImportStartResult,
  HealthKitGroupReadyResult,
  HealthKitGroupStatus,
  HealthKitMetricKey,
  HealthKitOpsBatchInput,
  HealthKitOpsBatchResult,
  HealthKitRunBeginResult,
  HealthKitRunCompleteResult,
  HealthKitSettings,
  HealthMetricFreshness,
  HealthProfile,
  HealthSleepDayRecord,
  HealthStepHourRecord,
  HealthWorkoutRecord,
  MarkHealthKitGroupReadyInput,
  McpCapability,
  McpConnectionGrant,
  NotificationDelivery,
  NotificationDevice,
  PersonStatus,
  PublicInviteResponse,
  PutHealthKitSettingsInput,
  Reminder,
  ReminderRecipient,
  ReminderScheduleKind,
  ReminderType,
  StartHealthKitImportInput
} from "@family-os/shared";
import { HttpError } from "../errors";
import type {
  AuditLogStore,
  CreateMcpConnectionInput,
  DeviceStore,
  FamilyStore,
  HealthKitStore,
  InviteStore,
  McpConnectionStore,
  NotificationDeliveryStore,
  ProfileStore,
  ReadingStore,
  RecordAuditInput,
  ReminderStore
} from "./contracts";
import { MemoryHealthKitEngine } from "./memoryHealthKit";

export type CreateFamilyInput = {
  name: string;
  userId: string;
  kind?: "personal" | "family";
};

export type CreateInviteInput = {
  actorUserId: string;
};

export type CreateProfileInput = {
  actorUserId: string;
  displayName: string;
  relationshipLabel?: string;
  dateOfBirth?: string;
};

export type UpdateProfileInput = Partial<{
  displayName: string;
  relationshipLabel: string;
  dateOfBirth: string;
  status: PersonStatus;
}>;

export type CreateReminderInput = {
  actorUserId: string;
  subjectPersonId?: string;
  type: ReminderType;
  title: string;
  message: string;
  scheduleKind: ReminderScheduleKind;
  timeOfDay?: string;
  timezone: string;
  daysOfWeek?: number[];
  startsOn?: string;
  endsOn?: string;
  recipientUserIds: string[];
};

export type UpdateReminderInput = Partial<Omit<CreateReminderInput, "actorUserId" | "recipientUserIds"> & {
  enabled: boolean;
  recipientUserIds: string[];
}>;

export type RegisterDeviceInput = {
  userId: string;
  deviceToken: string;
};

export type AuditInput = {
  familyId: string | null;
  actorUserId?: string;
  action: string;
  resourceType: string;
  resourceId: string;
  metadata?: Record<string, unknown>;
};

export interface FamilyRepository
  extends FamilyStore,
    InviteStore,
    ProfileStore,
    ReadingStore,
    HealthKitStore,
    ReminderStore,
    DeviceStore,
    NotificationDeliveryStore,
    AuditLogStore,
    McpConnectionStore {}

export class InMemoryFamilyRepository implements FamilyRepository {
  private readonly families = new Map<string, Family>();
  private readonly memberships = new Map<string, FamilyMembership>();
  private readonly invites = new Map<string, FamilyInvite & { tokenHash: string }>();
  private readonly profiles = new Map<string, HealthProfile>();
  private readonly bloodPressureReadings = new Map<
    string,
    BloodPressureReading & { deletedAt?: string; sourceSampleKey?: string }
  >();
  private readonly healthKit: MemoryHealthKitEngine;
  private readonly reminders = new Map<string, Reminder & { deletedAt?: string }>();
  private readonly devices = new Map<string, NotificationDevice>();
  private readonly deliveries = new Map<string, NotificationDelivery>();
  private readonly auditLogs: AuditLog[] = [];
  private readonly mcpConnectionGrants = new Map<string, McpConnectionGrant>();

  constructor() {
    this.healthKit = new MemoryHealthKitEngine({
      requireActiveMember: (userId) => this.requireActiveMember(userId),
      getSelfProfile: (userId) => this.getSelfProfile(userId),
      requireReadablePerson: (actorUserId, personId) => {
        const profile = this.requireReadablePerson(actorUserId, personId);
        return { id: profile.id, familyId: profile.familyId };
      },
      audit: (input) => this.audit(input),
      bloodPressureReadings: this.bloodPressureReadings
    });
  }

  async createFamily(input: CreateFamilyInput): Promise<CurrentFamilyResponse> {
    const existing = await this.getCurrentFamily(input.userId);
    if (existing) {
      throw new HttpError(409, "family_already_exists", "User already has an active family.");
    }

    const now = new Date().toISOString();
    const family: Family = {
      id: crypto.randomUUID(),
      name: input.name,
      kind: input.kind ?? "family",
      createdByUserId: input.userId,
      createdAt: now,
      updatedAt: now
    };
    const membership: FamilyMembership = {
      id: crypto.randomUUID(),
      familyId: family.id,
      userId: input.userId,
      role: "manager",
      status: "active",
      createdAt: now,
      updatedAt: now
    };

    this.families.set(family.id, family);
    this.memberships.set(membership.id, membership);

    // Attach solo Self person to the new household when present.
    for (const [id, profile] of this.profiles) {
      if (
        profile.linkedUserId === input.userId &&
        profile.relationshipLabel === "Self" &&
        profile.status === "active" &&
        profile.familyId == null
      ) {
        this.profiles.set(id, { ...profile, familyId: family.id, updatedAt: now });
      }
    }

    this.audit({
      familyId: family.id,
      actorUserId: input.userId,
      action: "family.created",
      resourceType: "family",
      resourceId: family.id
    });

    return this.currentFamilyPayload(family, membership);
  }

  async getCurrentFamily(userId: string): Promise<CurrentFamilyResponse> {
    const membership = [...this.memberships.values()].find(
      (candidate) => candidate.userId === userId && candidate.status === "active"
    );
    if (!membership) {
      return null;
    }

    const family = this.families.get(membership.familyId);
    if (!family) {
      return null;
    }

    return this.currentFamilyPayload(family, membership);
  }

  private currentFamilyPayload(family: Family, membership: FamilyMembership): NonNullable<CurrentFamilyResponse> {
    const creatorSelf = [...this.profiles.values()].find(
      (profile) =>
        profile.linkedUserId === family.createdByUserId &&
        profile.relationshipLabel === "Self" &&
        profile.status === "active"
    );
    const live =
      membership.userId === family.createdByUserId
        ? [...this.invites.values()].find(
            (invite) => invite.familyId === family.id && currentInviteStatus(invite) === "pending"
          )
        : undefined;
    return {
      family,
      membership,
      creatorDisplayName: creatorSelf?.displayName,
      liveInvite: live ? { expiresAt: live.expiresAt, status: "pending" } : undefined
    };
  }

  async listMembers(actorUserId: string): Promise<FamilyMember[]> {
    const current = this.requireActiveMember(actorUserId);
    return [...this.memberships.values()]
      .filter((membership) => membership.familyId === current.family.id && membership.status === "active")
      .map((membership) => {
        const selfProfile = [...this.profiles.values()].find(
          (profile) =>
            profile.familyId === current.family.id &&
            profile.linkedUserId === membership.userId &&
            profile.relationshipLabel === "Self" &&
            profile.status === "active"
        );
        return {
          membership,
          displayName: selfProfile?.displayName
        };
      });
  }

  async leaveFamily(actorUserId: string): Promise<void> {
    const current = this.requireActiveMember(actorUserId);
    if (current.family.createdByUserId === actorUserId) {
      throw new HttpError(403, "creator_cannot_leave", "The family creator cannot leave. Remove other members and delete the family.");
    }
    this.deactivateMembership(current.family.id, actorUserId);
    this.detachSelf(actorUserId);
  }

  async removeMember(actorUserId: string, memberUserId: string): Promise<void> {
    const current = this.requireActiveMember(actorUserId);
    if (current.family.createdByUserId !== actorUserId) {
      throw new HttpError(403, "creator_required", "Only the family creator can remove a member.");
    }
    if (memberUserId === actorUserId) {
      throw new HttpError(400, "cannot_remove_self", "The creator cannot remove themselves.");
    }
    const target = [...this.memberships.values()].find(
      (candidate) =>
        candidate.familyId === current.family.id &&
        candidate.userId === memberUserId &&
        candidate.status === "active"
    );
    if (!target) {
      throw new HttpError(404, "member_not_found", "Family member was not found.");
    }
    this.deactivateMembership(current.family.id, memberUserId);
    this.detachSelf(memberUserId);
    this.revokePendingInvites(current.family.id);
  }

  async deleteFamily(actorUserId: string): Promise<void> {
    const current = this.requireActiveMember(actorUserId);
    if (current.family.createdByUserId !== actorUserId) {
      throw new HttpError(403, "creator_required", "Only the family creator can delete the family.");
    }
    const others = [...this.memberships.values()].filter(
      (candidate) =>
        candidate.familyId === current.family.id &&
        candidate.status === "active" &&
        candidate.userId !== actorUserId
    );
    if (others.length > 0) {
      throw new HttpError(409, "family_not_empty", "Remove every other member before deleting the family.");
    }
    this.deactivateMembership(current.family.id, actorUserId);
    this.detachSelf(actorUserId);
    this.revokePendingInvites(current.family.id);
    this.families.delete(current.family.id);
  }

  private deactivateMembership(familyId: string, userId: string) {
    const now = new Date().toISOString();
    for (const [id, membership] of this.memberships) {
      if (membership.familyId === familyId && membership.userId === userId && membership.status === "active") {
        this.memberships.set(id, { ...membership, status: "removed", updatedAt: now });
      }
    }
  }

  private detachSelf(userId: string) {
    const now = new Date().toISOString();
    for (const [id, profile] of this.profiles) {
      if (profile.linkedUserId === userId && profile.relationshipLabel === "Self" && profile.status === "active") {
        this.profiles.set(id, { ...profile, familyId: null, updatedAt: now });
      }
    }
  }

  private revokePendingInvites(familyId: string) {
    for (const [id, invite] of this.invites) {
      if (invite.familyId === familyId && invite.status === "pending") {
        this.invites.set(id, { ...invite, status: "revoked" });
      }
    }
  }

  async bootstrap(userId: string): Promise<BootstrapResponse> {
    // Solo-first: no auto-created personal family.
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
      profiles,
      selfProfile,
      needsProfileSetup: selfProfile === null
    };
  }

  async createSelfProfile(actorUserId: string, displayName: string): Promise<HealthProfile> {
    const existing = await this.getSelfProfile(actorUserId);
    if (existing) {
      return existing;
    }

    const current = this.getCurrentFamilySync(actorUserId);
    const now = new Date().toISOString();
    const profile: HealthProfile = {
      id: crypto.randomUUID(),
      familyId: current?.family.id ?? null,
      linkedUserId: actorUserId,
      displayName,
      relationshipLabel: "Self",
      status: "active",
      createdAt: now,
      updatedAt: now
    };
    this.profiles.set(profile.id, profile);
    this.audit({
      familyId: null,
      actorUserId,
      action: "profile.created",
      resourceType: "profile",
      resourceId: profile.id
    });
    return profile;
  }

  async getSelfProfile(actorUserId: string): Promise<HealthProfile | null> {
    return (
      [...this.profiles.values()].find(
        (profile) =>
          profile.linkedUserId === actorUserId &&
          profile.relationshipLabel === "Self" &&
          profile.status === "active"
      ) ?? null
    );
  }

  async createInvite(input: CreateInviteInput): Promise<CreatedInvite> {
    const current = this.getCurrentFamilySync(input.actorUserId);
    if (!current || current.family.createdByUserId !== input.actorUserId) {
      throw new HttpError(403, "creator_required", "Only the family creator can create invites.");
    }

    const now = new Date();
    for (const [id, existing] of this.invites) {
      if (existing.familyId === current.family.id && existing.status === "pending") {
        this.invites.set(id, { ...existing, status: "revoked" });
      }
    }

    const token = crypto.randomUUID().replaceAll("-", "");
    const invite: FamilyInvite & { tokenHash: string } = {
      id: crypto.randomUUID(),
      familyId: current.family.id,
      status: "pending",
      expiresAt: new Date(now.getTime() + 60 * 60 * 1000).toISOString(),
      createdAt: now.toISOString(),
      tokenHash: hashToken(token)
    };
    this.invites.set(invite.id, invite);
    this.audit({
      familyId: current.family.id,
      actorUserId: input.actorUserId,
      action: "invite.created",
      resourceType: "invite",
      resourceId: invite.id
    });

    return { invite: toPublicInviteRecord(invite), token };
  }

  async getInviteByToken(token: string): Promise<PublicInviteResponse> {
    const invite = this.findInvite(token);
    const family = this.families.get(invite.familyId);
    if (!family) {
      throw new HttpError(404, "invite_not_found", "Invite was not found.");
    }
    const creatorSelf = [...this.profiles.values()].find(
      (profile) =>
        profile.linkedUserId === family.createdByUserId &&
        profile.relationshipLabel === "Self" &&
        profile.status === "active"
    );
    return {
      familyName: family.name,
      creatorDisplayName: creatorSelf?.displayName ?? "Family member",
      status: currentInviteStatus(invite),
      expiresAt: invite.expiresAt
    };
  }

  async acceptInvite(
    token: string,
    userId: string,
    input: { relationshipLabel: import("@family-os/shared").CreatorRelationshipLabel }
  ): Promise<CurrentFamilyResponse> {
    const invite = this.findInvite(token);
    const status = currentInviteStatus(invite);
    if (status === "expired") {
      throw new HttpError(409, "invite_expired", "Invite has expired.");
    }
    if (status === "accepted") {
      throw new HttpError(409, "invite_already_used", "Invite has already been used.");
    }
    if (status !== "pending") {
      throw new HttpError(409, "invite_not_pending", "Invite is not pending.");
    }

    const family = this.families.get(invite.familyId);
    if (!family) {
      throw new HttpError(404, "invite_not_found", "Invite was not found.");
    }
    if (family.createdByUserId === userId) {
      throw new HttpError(409, "invite_own_family", "You cannot join your own family invite.");
    }

    const existingCurrent = this.getCurrentFamilySync(userId);
    if (existingCurrent) {
      throw new HttpError(409, "family_already_exists", "User already has an active family.");
    }

    invite.status = "accepted";
    const now = new Date().toISOString();
    const membership: FamilyMembership = {
      id: crypto.randomUUID(),
      familyId: invite.familyId,
      userId,
      role: "member",
      status: "active",
      creatorRelationshipLabel: input.relationshipLabel,
      createdAt: now,
      updatedAt: now
    };
    this.memberships.set(membership.id, membership);

    for (const [id, profile] of this.profiles) {
      if (
        profile.linkedUserId === userId &&
        profile.relationshipLabel === "Self" &&
        profile.status === "active" &&
        profile.familyId == null
      ) {
        this.profiles.set(id, { ...profile, familyId: invite.familyId, updatedAt: now });
      }
    }
    this.audit({
      familyId: invite.familyId,
      actorUserId: userId,
      action: "invite.accepted",
      resourceType: "invite",
      resourceId: invite.id,
      metadata: { membershipId: membership.id, relationshipLabel: input.relationshipLabel }
    });

    return { family, membership };
  }

  private findInvite(token: string) {
    const tokenHash = hashToken(token);
    const invite = [...this.invites.values()].find((candidate) => candidate.tokenHash === tokenHash);
    if (!invite) {
      throw new HttpError(404, "invite_not_found", "Invite was not found.");
    }
    return invite;
  }

  async listProfiles(actorUserId: string): Promise<HealthProfile[]> {
    const current = await this.getCurrentFamily(actorUserId);
    if (current) {
      const memberIds = new Set(
        [...this.memberships.values()]
          .filter((membership) => membership.familyId === current.family.id && membership.status === "active")
          .map((membership) => membership.userId)
      );
      return [...this.profiles.values()].filter(
        (profile) =>
          profile.status === "active" &&
          profile.relationshipLabel === "Self" &&
          profile.linkedUserId !== undefined &&
          memberIds.has(profile.linkedUserId)
      );
    }
    const self = await this.getSelfProfile(actorUserId);
    return self ? [self] : [];
  }

  async getProfile(actorUserId: string, profileId: string): Promise<HealthProfile> {
    return this.requireReadablePerson(actorUserId, profileId);
  }

  async createProfile(_input: CreateProfileInput): Promise<HealthProfile> {
    throw new HttpError(403, "ghost_profiles_unsupported", "Family members must join with their own app.");
  }

  async updateProfile(actorUserId: string, profileId: string, input: UpdateProfileInput): Promise<HealthProfile> {
    const profile = this.profiles.get(profileId);
    if (!profile || profile.status !== "active") {
      throw new HttpError(404, "profile_not_found", "Health profile was not found.");
    }
    if (profile.linkedUserId !== actorUserId || profile.relationshipLabel !== "Self") {
      throw new HttpError(403, "profile_forbidden", "You can only change your own Self profile.");
    }

    const updated: HealthProfile = {
      ...profile,
      ...defined(input),
      relationshipLabel: "Self",
      linkedUserId: actorUserId,
      updatedAt: new Date().toISOString()
    };
    this.profiles.set(profileId, updated);
    this.audit({
      familyId: profile.familyId,
      actorUserId,
      action: input.status === "inactive" ? "profile.deleted" : "profile.updated",
      resourceType: "profile",
      resourceId: profileId
    });
    return updated;
  }

  async deleteProfile(actorUserId: string, profileId: string): Promise<void> {
    await this.updateProfile(actorUserId, profileId, { status: "inactive" });
  }

  private requireActiveMember(userId: string): NonNullable<CurrentFamilyResponse> {
    const current = this.getCurrentFamilySync(userId);
    if (!current) {
      throw new HttpError(403, "active_member_required", "Active family membership is required.");
    }
    return current;
  }

  private requireManager(userId: string): NonNullable<CurrentFamilyResponse> {
    const current = this.requireActiveMember(userId);
    if (current.membership.role !== "manager") {
      throw new HttpError(403, "manager_required", "Only family managers can manage health profiles.");
    }
    return current;
  }

  async listBloodPressure(actorUserId: string, personId?: string, limit = 50): Promise<BloodPressureReading[]> {
    const self = await this.getSelfProfile(actorUserId);
    const target = personId ?? self?.id;
    if (!target) {
      throw new HttpError(400, "self_profile_required", "Create your profile before continuing.");
    }
    await this.requireReadablePerson(actorUserId, target);
    return [...this.bloodPressureReadings.values()]
      .filter((reading) => !reading.deletedAt && reading.source === "healthkit")
      .filter((reading) => reading.personId === target)
      .sort((a, b) => Date.parse(b.measuredAt) - Date.parse(a.measuredAt))
      .slice(0, limit)
      .map(stripDeleted);
  }

  async getBloodPressure(actorUserId: string, readingId: string): Promise<BloodPressureReading> {
    const reading = this.bloodPressureReadings.get(readingId);
    if (!reading || reading.deletedAt || reading.source !== "healthkit") {
      throw new HttpError(404, "bp_reading_not_found", "Blood pressure reading was not found.");
    }
    await this.requireReadablePerson(actorUserId, reading.personId);
    return stripDeleted(reading);
  }

  private requireReadablePerson(actorUserId: string, personId: string): HealthProfile {
    const profile = this.profiles.get(personId);
    if (!profile || profile.status !== "active") {
      throw new HttpError(404, "profile_not_found", "Health profile was not found.");
    }
    if (profile.linkedUserId === actorUserId) {
      return profile;
    }
    if (!profile.linkedUserId) {
      throw new HttpError(403, "profile_forbidden", "You do not have access to this health profile.");
    }
    const actorFamily = this.getCurrentFamilySync(actorUserId);
    const targetFamily = this.getCurrentFamilySync(profile.linkedUserId);
    if (actorFamily && targetFamily && actorFamily.family.id === targetFamily.family.id) {
      return profile;
    }
    throw new HttpError(403, "profile_forbidden", "You do not have access to this health profile.");
  }

  async getHealthKitSettings(actorUserId: string, personId?: string): Promise<HealthKitSettings> {
    return this.healthKit.getHealthKitSettings(actorUserId, personId);
  }

  async putHealthKitSettings(actorUserId: string, input: PutHealthKitSettingsInput): Promise<HealthKitSettings> {
    return this.healthKit.putHealthKitSettings(actorUserId, input);
  }

  async applyHealthKitOps(actorUserId: string, input: HealthKitOpsBatchInput): Promise<HealthKitOpsBatchResult> {
    return this.healthKit.applyHealthKitOps(actorUserId, input);
  }

  async beginHealthKitRun(
    actorUserId: string,
    group: HealthKitConsentGroup,
    input: BeginHealthKitRunInput
  ): Promise<HealthKitRunBeginResult> {
    return this.healthKit.beginHealthKitRun(actorUserId, group, input);
  }

  async completeHealthKitRun(
    actorUserId: string,
    group: HealthKitConsentGroup,
    input: CompleteHealthKitRunInput
  ): Promise<HealthKitRunCompleteResult> {
    return this.healthKit.completeHealthKitRun(actorUserId, group, input);
  }

  async startHealthKitImport(
    actorUserId: string,
    group: HealthKitConsentGroup,
    input: StartHealthKitImportInput
  ): Promise<HealthKitGroupImportStartResult> {
    return this.healthKit.startHealthKitImport(actorUserId, group, input);
  }

  async markHealthKitGroupReady(
    actorUserId: string,
    group: HealthKitConsentGroup,
    input: MarkHealthKitGroupReadyInput
  ): Promise<HealthKitGroupReadyResult> {
    return this.healthKit.markHealthKitGroupReady(actorUserId, group, input);
  }

  async getHealthKitGroupStatus(
    actorUserId: string,
    group: HealthKitConsentGroup,
    personId?: string
  ): Promise<HealthKitGroupStatus> {
    return this.healthKit.getHealthKitGroupStatus(actorUserId, group, personId);
  }

  async getHealthMetricFreshness(
    actorUserId: string,
    personId: string,
    healthMetric: HealthKitMetricKey
  ): Promise<HealthMetricFreshness> {
    return this.healthKit.getHealthMetricFreshness(actorUserId, personId, healthMetric);
  }

  async listStepHours(
    actorUserId: string,
    personId: string,
    rangeStartUtc: string,
    rangeEndUtc: string
  ): Promise<HealthStepHourRecord[]> {
    return this.healthKit.listStepHours(actorUserId, personId, rangeStartUtc, rangeEndUtc);
  }

  async listSleepDays(
    actorUserId: string,
    personId: string,
    rangeStartDay: string,
    rangeEndDay: string
  ): Promise<HealthSleepDayRecord[]> {
    return this.healthKit.listSleepDays(actorUserId, personId, rangeStartDay, rangeEndDay);
  }

  async listHealthKitBloodPressure(
    actorUserId: string,
    personId: string,
    rangeStartUtc: string,
    rangeEndUtc: string,
    limit: number
  ): Promise<BloodPressureReading[]> {
    return this.healthKit.listHealthKitBloodPressure(actorUserId, personId, rangeStartUtc, rangeEndUtc, limit);
  }

  async listDailyMetrics(
    actorUserId: string,
    personId: string,
    healthMetric: HealthKitMetricKey,
    rangeStartDay: string,
    rangeEndDay: string
  ): Promise<HealthDailyMetricRecord[]> {
    return this.healthKit.listDailyMetrics(actorUserId, personId, healthMetric, rangeStartDay, rangeEndDay);
  }

  async listHealthKitBloodGlucose(
    actorUserId: string,
    personId: string,
    rangeStartUtc: string,
    rangeEndUtc: string,
    limit: number
  ): Promise<BloodGlucoseReading[]> {
    return this.healthKit.listHealthKitBloodGlucose(actorUserId, personId, rangeStartUtc, rangeEndUtc, limit);
  }

  async listHealthKitWorkouts(
    actorUserId: string,
    personId: string,
    rangeStartUtc: string,
    rangeEndUtc: string,
    limit: number
  ): Promise<HealthWorkoutRecord[]> {
    return this.healthKit.listHealthKitWorkouts(actorUserId, personId, rangeStartUtc, rangeEndUtc, limit);
  }

  async createConnection(input: CreateMcpConnectionInput): Promise<McpConnectionGrant> {
    const capabilities = normalizeMcpCapabilities(input.capabilities);
    const now = new Date().toISOString();
    for (const [id, grant] of this.mcpConnectionGrants) {
      if (grant.userId === input.userId && grant.oauthClientId === input.oauthClientId && !grant.revokedAt) {
        this.mcpConnectionGrants.set(id, { ...grant, revokedAt: now });
      }
    }
    const connection: McpConnectionGrant = {
      id: crypto.randomUUID(),
      userId: input.userId,
      oauthClientId: input.oauthClientId,
      capabilities,
      consentVersion: input.consentVersion,
      createdAt: now,
      expiresAt: input.expiresAt,
      revokedAt: undefined
    };
    this.mcpConnectionGrants.set(connection.id, connection);
    return connection;
  }

  async getActiveConnection(userId: string, oauthClientId: string): Promise<McpConnectionGrant | null> {
    const now = Date.now();
    const active = [...this.mcpConnectionGrants.values()]
      .filter((grant) => grant.userId === userId && grant.oauthClientId === oauthClientId)
      .filter((grant) => !grant.revokedAt)
      .filter((grant) => !grant.expiresAt || Date.parse(grant.expiresAt) > now)
      .sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt))[0];
    return active ?? null;
  }

  async revokeConnection(userId: string, connectionId: string): Promise<McpConnectionGrant> {
    const grant = this.mcpConnectionGrants.get(connectionId);
    if (!grant || grant.userId !== userId) {
      throw new HttpError(404, "mcp_connection_not_found", "MCP connection grant was not found.");
    }
    if (grant.revokedAt) {
      return grant;
    }
    const revoked = { ...grant, revokedAt: new Date().toISOString() };
    this.mcpConnectionGrants.set(connectionId, revoked);
    return revoked;
  }

  async listConnections(userId: string): Promise<McpConnectionGrant[]> {
    return [...this.mcpConnectionGrants.values()]
      .filter((grant) => grant.userId === userId)
      .sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt));
  }

  async recordAudit(input: RecordAuditInput): Promise<void> {
    this.audit(input);
  }

  async createReminder(input: CreateReminderInput): Promise<Reminder> {
    const current = this.requireActiveMember(input.actorUserId);
    this.assertProfileInFamily(input.subjectPersonId, current.family.id);
    const recipients = this.buildRecipients(input.recipientUserIds, current.family.id, crypto.randomUUID());
    const now = new Date().toISOString();
    const reminder: Reminder = {
      id: recipients[0]?.reminderId ?? crypto.randomUUID(),
      familyId: current.family.id,
      subjectPersonId: input.subjectPersonId,
      createdByUserId: input.actorUserId,
      type: input.type,
      title: input.title,
      message: input.message,
      scheduleKind: input.scheduleKind,
      timeOfDay: input.timeOfDay,
      timezone: input.timezone,
      daysOfWeek: input.daysOfWeek,
      startsOn: input.startsOn,
      endsOn: input.endsOn,
      enabled: true,
      recipients,
      createdAt: now,
      updatedAt: now
    };
    this.reminders.set(reminder.id, reminder);
    this.audit({
      familyId: current.family.id,
      actorUserId: input.actorUserId,
      action: "reminder.created",
      resourceType: "reminder",
      resourceId: reminder.id,
      metadata: { type: input.type }
    });
    return reminder;
  }

  async listReminders(actorUserId: string): Promise<Reminder[]> {
    const current = this.requireActiveMember(actorUserId);
    return [...this.reminders.values()]
      .filter((reminder) => reminder.familyId === current.family.id && !reminder.deletedAt)
      .map(stripDeleted);
  }

  async getReminder(actorUserId: string, reminderId: string): Promise<Reminder> {
    const current = this.requireActiveMember(actorUserId);
    const reminder = this.reminders.get(reminderId);
    if (!reminder || reminder.familyId !== current.family.id || reminder.deletedAt) {
      throw new HttpError(404, "reminder_not_found", "Reminder was not found.");
    }
    return stripDeleted(reminder);
  }

  async updateReminder(actorUserId: string, reminderId: string, input: UpdateReminderInput): Promise<Reminder> {
    const current = this.requireActiveMember(actorUserId);
    const reminder = this.reminders.get(reminderId);
    if (!reminder || reminder.familyId !== current.family.id || reminder.deletedAt) {
      throw new HttpError(404, "reminder_not_found", "Reminder was not found.");
    }
    if (reminder.createdByUserId !== actorUserId && current.membership.role !== "manager") {
      throw new HttpError(403, "reminder_owner_or_manager_required", "Only the creator or a manager can change this reminder.");
    }
    this.assertProfileInFamily(input.subjectPersonId, current.family.id);
    const updated: Reminder & { deletedAt?: string } = {
      ...reminder,
      ...defined(input),
      recipients: input.recipientUserIds
        ? this.buildRecipients(input.recipientUserIds, current.family.id, reminder.id)
        : reminder.recipients,
      updatedAt: new Date().toISOString()
    };
    this.reminders.set(reminderId, updated);
    this.audit({
      familyId: current.family.id,
      actorUserId,
      action: "reminder.updated",
      resourceType: "reminder",
      resourceId: reminderId
    });
    return stripDeleted(updated);
  }

  async deleteReminder(actorUserId: string, reminderId: string): Promise<void> {
    const current = this.requireActiveMember(actorUserId);
    const reminder = this.reminders.get(reminderId);
    if (!reminder || reminder.familyId !== current.family.id || reminder.deletedAt) {
      throw new HttpError(404, "reminder_not_found", "Reminder was not found.");
    }
    if (reminder.createdByUserId !== actorUserId && current.membership.role !== "manager") {
      throw new HttpError(403, "reminder_owner_or_manager_required", "Only the creator or a manager can delete this reminder.");
    }
    this.reminders.set(reminderId, { ...reminder, deletedAt: new Date().toISOString() });
    this.audit({
      familyId: current.family.id,
      actorUserId,
      action: "reminder.deleted",
      resourceType: "reminder",
      resourceId: reminderId
    });
  }

  async disableReminderForSelf(actorUserId: string, reminderId: string): Promise<ReminderRecipient> {
    const reminder = await this.getReminder(actorUserId, reminderId);
    const recipient = reminder.recipients.find((candidate) => candidate.userId === actorUserId);
    if (!recipient) {
      throw new HttpError(404, "reminder_recipient_not_found", "Reminder recipient was not found.");
    }
    const updated = { ...recipient, enabled: false, disabledAt: new Date().toISOString() };
    const stored = this.reminders.get(reminderId);
    if (stored) {
      stored.recipients = stored.recipients.map((candidate) => (candidate.id === updated.id ? updated : candidate));
    }
    this.audit({
      familyId: reminder.familyId,
      actorUserId,
      action: "reminder_recipient.disabled",
      resourceType: "reminder",
      resourceId: reminderId
    });
    return updated;
  }

  async registerDevice(input: RegisterDeviceInput): Promise<NotificationDevice> {
    const current = this.getCurrentFamilySync(input.userId);
    const now = new Date().toISOString();
    const existing = [...this.devices.values()].find(
      (device) => device.userId === input.userId && device.deviceToken === input.deviceToken
    );
    if (existing) {
      const updated = { ...existing, lastSeenAt: now };
      this.devices.set(existing.id, updated);
      if (current) {
        this.audit({
          familyId: current.family.id,
          actorUserId: input.userId,
          action: "device.updated",
          resourceType: "notification_device",
          resourceId: updated.id
        });
      }
      return updated;
    }
    const device: NotificationDevice = {
      id: crypto.randomUUID(),
      userId: input.userId,
      deviceToken: input.deviceToken,
      platform: "ios",
      createdAt: now,
      lastSeenAt: now
    };
    this.devices.set(device.id, device);
    if (current) {
      this.audit({
        familyId: current.family.id,
        actorUserId: input.userId,
        action: "device.registered",
        resourceType: "notification_device",
        resourceId: device.id
      });
    }
    return device;
  }

  async deleteDevice(actorUserId: string, deviceId: string): Promise<void> {
    const current = this.getCurrentFamilySync(actorUserId);
    const device = this.devices.get(deviceId);
    if (!device || device.userId !== actorUserId) {
      throw new HttpError(404, "device_not_found", "Device was not found.");
    }
    this.devices.delete(deviceId);
    if (current) {
      this.audit({
        familyId: current.family.id,
        actorUserId,
        action: "device.deleted",
        resourceType: "notification_device",
        resourceId: deviceId
      });
    }
  }

  async listDueReminderDeliveries(now: Date) {
    const scheduledFor = now.toISOString();
    const due: Array<{ reminder: Reminder; recipient: ReminderRecipient; devices: NotificationDevice[]; delivery: NotificationDelivery }> = [];
    for (const reminder of this.reminders.values()) {
      if (reminder.deletedAt || !reminder.enabled || !isReminderDue(reminder, now)) continue;
      for (const recipient of reminder.recipients.filter((candidate) => candidate.enabled)) {
        const devices = [...this.devices.values()].filter((device) => device.userId === recipient.userId);
        const delivery: NotificationDelivery = {
          id: crypto.randomUUID(),
          reminderId: reminder.id,
          recipientUserId: recipient.userId,
          status: "pending",
          scheduledFor,
          createdAt: scheduledFor
        };
        this.deliveries.set(delivery.id, delivery);
        due.push({ reminder: stripDeleted(reminder), recipient, devices, delivery });
      }
    }
    return due;
  }

  async markDeliverySent(deliveryId: string): Promise<void> {
    const delivery = this.deliveries.get(deliveryId);
    if (delivery) {
      this.deliveries.set(deliveryId, { ...delivery, status: "sent", sentAt: new Date().toISOString() });
      this.auditDelivery(delivery, "notification_delivery.sent");
    }
  }

  async markDeliveryFailed(deliveryId: string, error: string): Promise<void> {
    const delivery = this.deliveries.get(deliveryId);
    if (delivery) {
      this.deliveries.set(deliveryId, { ...delivery, status: "failed", error });
      this.auditDelivery(delivery, "notification_delivery.failed", { error });
    }
  }

  async listAuditLogs(actorUserId: string, limit = 100): Promise<AuditLog[]> {
    const current = this.requireManager(actorUserId);
    return this.auditLogs
      .filter((entry) => entry.familyId === current.family.id)
      .sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt))
      .slice(0, limit);
  }

  private buildRecipients(userIds: string[], familyId: string, reminderId: string): ReminderRecipient[] {
    const uniqueIds = [...new Set(userIds)];
    if (uniqueIds.length === 0) {
      throw new HttpError(400, "recipients_required", "At least one reminder recipient is required.");
    }
    const now = new Date().toISOString();
    return uniqueIds.map((userId) => {
      const membership = [...this.memberships.values()].find(
        (candidate) => candidate.familyId === familyId && candidate.userId === userId && candidate.status === "active"
      );
      if (!membership) {
        throw new HttpError(400, "invalid_recipient", "Reminder recipients must be active family members.");
      }
      return {
        id: crypto.randomUUID(),
        reminderId,
        userId,
        enabled: true,
        createdAt: now
      };
    });
  }

  private assertProfileInFamily(profileId: string | undefined, familyId: string) {
    if (!profileId) return;
    const profile = this.profiles.get(profileId);
    if (!profile || profile.familyId !== familyId || profile.status !== "active") {
      throw new HttpError(404, "profile_not_found", "Health profile was not found.");
    }
  }

  private getCurrentFamilySync(userId: string): CurrentFamilyResponse {
    const membership = [...this.memberships.values()].find(
      (candidate) => candidate.userId === userId && candidate.status === "active"
    );
    if (!membership) {
      return null;
    }

    const family = this.families.get(membership.familyId);
    if (!family) {
      return null;
    }

    return { family, membership };
  }

  private audit(input: AuditInput) {
    this.auditLogs.push({
      id: crypto.randomUUID(),
      familyId: input.familyId,
      actorUserId: input.actorUserId,
      action: input.action,
      resourceType: input.resourceType,
      resourceId: input.resourceId,
      metadata: input.metadata,
      createdAt: new Date().toISOString()
    });
  }

  private auditDelivery(delivery: NotificationDelivery, action: string, metadata?: Record<string, unknown>) {
    const reminder = this.reminders.get(delivery.reminderId);
    if (!reminder) return;
    this.audit({
      familyId: reminder.familyId,
      action,
      resourceType: "notification_delivery",
      resourceId: delivery.id,
      metadata: { recipientUserId: delivery.recipientUserId, ...metadata }
    });
  }

}

function defined<T extends object>(input: T): Partial<T> {
  return Object.fromEntries(Object.entries(input).filter(([, value]) => value !== undefined)) as Partial<T>;
}

function stripDeleted<T extends { deletedAt?: string }>(input: T): Omit<T, "deletedAt"> {
  const { deletedAt: _deletedAt, ...rest } = input;
  return rest;
}

function isReminderDue(reminder: Reminder, now: Date): boolean {
  if (!reminder.timeOfDay) return false;
  const hhmm = now.toISOString().slice(11, 16);
  if (hhmm !== reminder.timeOfDay) return false;
  const day = now.getUTCDay();
  if (reminder.scheduleKind === "daily") return true;
  if (reminder.scheduleKind === "weekly" || reminder.scheduleKind === "custom_days") {
    return reminder.daysOfWeek?.includes(day) ?? false;
  }
  if (reminder.scheduleKind === "once") {
    return reminder.startsOn === now.toISOString().slice(0, 10);
  }
  return false;
}

function hashToken(token: string) {
  return createHash("sha256").update(token).digest("hex");
}

function currentInviteStatus(invite: FamilyInvite): FamilyInvite["status"] {
  if (invite.status === "pending" && new Date(invite.expiresAt).getTime() <= Date.now()) {
    return "expired";
  }
  return invite.status;
}


function normalizeMcpCapabilities(capabilities: McpCapability[]): McpCapability[] {
  const allowed = new Set<McpCapability>(["health_read"]);
  const unique = [...new Set(capabilities)].filter((cap): cap is McpCapability => allowed.has(cap));
  if (unique.length === 0) {
    throw new HttpError(400, "mcp_capabilities_required", "At least one MCP capability is required.");
  }
  return unique;
}

function toPublicInviteRecord(invite: FamilyInvite): FamilyInvite {
  return {
    id: invite.id,
    familyId: invite.familyId,
    status: invite.status,
    expiresAt: invite.expiresAt,
    createdAt: invite.createdAt
  };
}
