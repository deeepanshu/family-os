import { createHash } from "node:crypto";
import type {
  AuditLog,
  CreateInviteResponse,
  BloodPressureReading,
  BloodGlucoseReading,
  BootstrapResponse,
  CompleteHealthKitRepairInput,
  CreateHealthKitRepairInput,
  FamilyMember,
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
  McpCapability,
  McpConnectionGrant,
  PutHealthKitSettingsInput,
  Reminder,
  NotificationDelivery,
  NotificationDevice,
  ReminderRecipient,
  ReminderScheduleKind,
  ReminderType,
  CurrentFamilyResponse,
  Family,
  FamilyInvite,
  FamilyKind,
  FamilyMembership,
  FamilyRole,
  HealthProfile,
  GlucoseContext,
  PersonStatus,
  PublicInviteResponse
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
import { localDateString } from "../mcp/timezone";
import {
  assertOperationInRepairRange,
  assertSelfProfileMatch,
  buildSyncResult,
  HEALTHKIT_METRICS,
  metricsAffected,
  profileLocalSleepDayRange,
  repairRangeStart,
  REPAIR_TTL_MS,
  toUtcIso,
  type HealthKitRepairRange
} from "./healthKitDomain";

export type CreateFamilyInput = {
  name: string;
  userId: string;
  kind?: "personal" | "family";
};

export type CreateInviteInput = {
  actorUserId: string;
  email?: string;
  role: FamilyRole;
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

export type CreateBloodPressureInput = {
  actorUserId: string;
  personId: string;
  systolic: number;
  diastolic: number;
  pulse?: number;
  measuredAt: string;
  context?: string;
  notes?: string;
};

export type UpdateBloodPressureInput = Partial<{
  systolic: number;
  diastolic: number;
  pulse: number;
  measuredAt: string;
  context: string;
  notes: string;
}>;

export type CreateBloodGlucoseInput = {
  actorUserId: string;
  personId: string;
  value: number;
  context: GlucoseContext;
  measuredAt: string;
  notes?: string;
};

export type UpdateBloodGlucoseInput = Partial<{
  value: number;
  context: GlucoseContext;
  measuredAt: string;
  notes: string;
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
  familyId: string;
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
  private readonly bloodGlucoseReadings = new Map<string, BloodGlucoseReading & { deletedAt?: string }>();
  private readonly healthKitProfileSettings = new Map<
    string,
    {
      personId: string;
      familyId: string;
      userId: string;
      consentVersion?: string;
      consentedAt?: string;
      healthTimezone: string;
      healthTimezoneVersion: number;
    }
  >();
  private readonly healthKitMetricEnabled = new Map<string, boolean>();
  private readonly healthMetricSyncState = new Map<
    string,
    {
      personId: string;
      familyId: string;
      metric: HealthKitMetric;
      lastSuccessfulAt?: string;
      lastAttemptAt?: string;
      lastErrorCode?: string;
      coverageStartAt?: string;
      coverageEndAt?: string;
      status: HealthMetricSyncStatusCode;
    }
  >();
  private readonly healthKitInstallations = new Map<
    string,
    { personId: string; familyId: string; installationId: string; activatedAt: string; revokedAt?: string }
  >();
  private readonly healthStepHours = new Map<string, HealthStepHourRecord & { familyId: string }>();
  private readonly healthSleepDays = new Map<string, HealthSleepDayRecord & { familyId: string }>();
  private readonly healthKitSyncReceipts = new Map<string, HealthKitSyncResult>();
  private readonly healthKitRepairs = new Map<
    string,
    HealthKitRepair & {
      familyId: string;
      expectedChunkCount?: number;
      completedAt?: string;
    }
  >();
  private readonly healthKitRepairChunks = new Map<string, { repairId: string; chunkIndex: number; syncId: string; response: HealthKitSyncResult }>();
  private readonly reminders = new Map<string, Reminder & { deletedAt?: string }>();
  private readonly devices = new Map<string, NotificationDevice>();
  private readonly deliveries = new Map<string, NotificationDelivery>();
  private readonly auditLogs: AuditLog[] = [];
  private readonly mcpConnectionGrants = new Map<string, McpConnectionGrant>();

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
    this.audit({
      familyId: family.id,
      actorUserId: input.userId,
      action: "family.created",
      resourceType: "family",
      resourceId: family.id
    });

    return { family, membership };
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

    return { family, membership };
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

  async bootstrap(userId: string): Promise<BootstrapResponse> {
    let current = await this.getCurrentFamily(userId);
    if (!current) {
      const created = await this.createFamily({ name: "My Health", userId, kind: "personal" });
      if (!created) {
        throw new HttpError(500, "bootstrap_failed", "Failed to create personal workspace.");
      }
      current = created;
    }

    const profiles = await this.listProfiles(userId);
    const selfProfile = profiles.find((profile) => profile.linkedUserId === userId && profile.relationshipLabel === "Self") ?? null;

    return {
      family: current.family,
      membership: current.membership,
      profiles,
      selfProfile,
      needsProfileSetup: selfProfile === null
    };
  }

  async createSelfProfile(actorUserId: string, displayName: string): Promise<HealthProfile> {
    const current = this.requireActiveMember(actorUserId);
    const existing = await this.getSelfProfile(actorUserId);
    if (existing) {
      return existing;
    }

    const now = new Date().toISOString();
    const profile: HealthProfile = {
      id: crypto.randomUUID(),
      familyId: current.family.id,
      linkedUserId: actorUserId,
      displayName,
      relationshipLabel: "Self",
      status: "active",
      createdAt: now,
      updatedAt: now
    };
    this.profiles.set(profile.id, profile);
    this.audit({
      familyId: current.family.id,
      actorUserId,
      action: "profile.created",
      resourceType: "profile",
      resourceId: profile.id
    });
    return profile;
  }

  async getSelfProfile(actorUserId: string): Promise<HealthProfile | null> {
    const current = await this.getCurrentFamily(actorUserId);
    if (!current) {
      return null;
    }
    return (
      [...this.profiles.values()].find(
        (profile) =>
          profile.familyId === current.family.id &&
          profile.linkedUserId === actorUserId &&
          profile.relationshipLabel === "Self" &&
          profile.status === "active"
      ) ?? null
    );
  }

  async createInvite(input: CreateInviteInput): Promise<CreateInviteResponse> {
    const current = this.getCurrentFamilySync(input.actorUserId);
    if (!current || current.membership.role !== "manager") {
      throw new HttpError(403, "manager_required", "Only family managers can create invites.");
    }

    if (current.family.kind === "personal") {
      this.families.set(current.family.id, { ...current.family, kind: "family", updatedAt: new Date().toISOString() });
    }

    const token = crypto.randomUUID().replaceAll("-", "");
    const now = new Date();
    const invite: FamilyInvite & { tokenHash: string } = {
      id: crypto.randomUUID(),
      familyId: current.family.id,
      email: input.email,
      role: input.role,
      status: "pending",
      expiresAt: new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000).toISOString(),
      createdAt: now.toISOString(),
      tokenHash: hashToken(token)
    };
    this.invites.set(invite.id, invite);
    this.audit({
      familyId: current.family.id,
      actorUserId: input.actorUserId,
      action: "invite.created",
      resourceType: "invite",
      resourceId: invite.id,
      metadata: { role: input.role }
    });

    return { invite: toPublicInviteRecord(invite), token };
  }

  async getInviteByToken(token: string): Promise<PublicInviteResponse> {
    const invite = this.findInvite(token);
    const family = this.families.get(invite.familyId);
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
    const invite = this.findInvite(token);
    const status = currentInviteStatus(invite);
    if (status !== "pending") {
      throw new HttpError(409, "invite_not_pending", "Invite is not pending.");
    }
    if (invite.email && invite.email.toLowerCase() !== userEmail?.toLowerCase()) {
      throw new HttpError(403, "invite_email_mismatch", "Invite is assigned to a different email.");
    }

    const existingCurrent = this.getCurrentFamilySync(userId);
    if (existingCurrent) {
      if (existingCurrent.family.kind === "family") {
        throw new HttpError(409, "family_already_exists", "User already has an active family.");
      }
      this.assertSafePersonalSwitch(existingCurrent.family.id, userId);
      const membership = [...this.memberships.values()].find(
        (candidate) => candidate.userId === userId && candidate.status === "active"
      );
      if (membership) {
        membership.status = "removed";
        membership.updatedAt = new Date().toISOString();
      }
    }

    invite.status = "accepted";
    const now = new Date().toISOString();
    const membership: FamilyMembership = {
      id: crypto.randomUUID(),
      familyId: invite.familyId,
      userId,
      role: invite.role,
      status: "active",
      createdAt: now,
      updatedAt: now
    };
    this.memberships.set(membership.id, membership);
    this.audit({
      familyId: invite.familyId,
      actorUserId: userId,
      action: "invite.accepted",
      resourceType: "invite",
      resourceId: invite.id,
      metadata: { membershipId: membership.id }
    });

    const family = this.families.get(invite.familyId);
    if (!family) {
      throw new HttpError(404, "invite_not_found", "Invite was not found.");
    }

    return { family, membership };
  }

  private assertSafePersonalSwitch(familyId: string, userId: string) {
    const activeMemberships = [...this.memberships.values()].filter(
      (candidate) => candidate.familyId === familyId && candidate.status === "active"
    );
    if (activeMemberships.length !== 1 || activeMemberships[0]?.userId !== userId) {
      throw new HttpError(409, "unsafe_workspace_switch", "Workspace has more than one active member.");
    }

    const hasReminders = [...this.reminders.values()].some(
      (reminder) => reminder.familyId === familyId && !reminder.deletedAt
    );
    if (hasReminders) {
      throw new HttpError(409, "unsafe_workspace_switch", "Workspace has reminders.");
    }

    const hasBloodPressure = [...this.bloodPressureReadings.values()].some(
      (reading) => reading.familyId === familyId && !reading.deletedAt
    );
    if (hasBloodPressure) {
      throw new HttpError(409, "unsafe_workspace_switch", "Workspace has blood pressure readings.");
    }
    const hasSteps = [...this.healthStepHours.values()].some((row) => row.familyId === familyId);
    if (hasSteps) {
      throw new HttpError(409, "unsafe_workspace_switch", "Workspace has HealthKit step data.");
    }
    const hasSleep = [...this.healthSleepDays.values()].some((row) => row.familyId === familyId);
    if (hasSleep) {
      throw new HttpError(409, "unsafe_workspace_switch", "Workspace has HealthKit sleep data.");
    }

    const hasBloodGlucose = [...this.bloodGlucoseReadings.values()].some(
      (reading) => reading.familyId === familyId && !reading.deletedAt && reading.source === "manual"
    );
    if (hasBloodGlucose) {
      throw new HttpError(409, "unsafe_workspace_switch", "Workspace has manual blood sugar readings.");
    }
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
    const current = this.requireActiveMember(actorUserId);
    return [...this.profiles.values()].filter(
      (profile) => profile.familyId === current.family.id && profile.status === "active"
    );
  }

  async getProfile(actorUserId: string, profileId: string): Promise<HealthProfile> {
    const current = this.requireActiveMember(actorUserId);
    const profile = this.profiles.get(profileId);
    if (!profile || profile.familyId !== current.family.id || profile.status !== "active") {
      throw new HttpError(404, "profile_not_found", "Health profile was not found.");
    }
    return profile;
  }

  async createProfile(input: CreateProfileInput): Promise<HealthProfile> {
    const current = this.requireManager(input.actorUserId);
    const now = new Date().toISOString();
    const profile: HealthProfile = {
      id: crypto.randomUUID(),
      familyId: current.family.id,
      displayName: input.displayName,
      relationshipLabel: input.relationshipLabel,
      dateOfBirth: input.dateOfBirth,
      status: "active",
      createdAt: now,
      updatedAt: now
    };
    this.profiles.set(profile.id, profile);
    this.audit({
      familyId: current.family.id,
      actorUserId: input.actorUserId,
      action: "profile.created",
      resourceType: "profile",
      resourceId: profile.id
    });
    return profile;
  }

  async updateProfile(actorUserId: string, profileId: string, input: UpdateProfileInput): Promise<HealthProfile> {
    const current = this.requireManager(actorUserId);
    const profile = this.profiles.get(profileId);
    if (!profile || profile.familyId !== current.family.id) {
      throw new HttpError(404, "profile_not_found", "Health profile was not found.");
    }

    const updated: HealthProfile = {
      ...profile,
      ...defined(input),
      updatedAt: new Date().toISOString()
    };
    this.profiles.set(profileId, updated);
    this.audit({
      familyId: current.family.id,
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
    const current = this.requireActiveMember(actorUserId);
    return [...this.bloodPressureReadings.values()]
      .filter((reading) => reading.familyId === current.family.id && !reading.deletedAt && reading.source === "healthkit")
      .filter((reading) => !personId || reading.personId === personId)
      .sort((a, b) => Date.parse(b.measuredAt) - Date.parse(a.measuredAt))
      .slice(0, limit)
      .map(stripDeleted);
  }

  async getBloodPressure(actorUserId: string, readingId: string): Promise<BloodPressureReading> {
    const current = this.requireActiveMember(actorUserId);
    const reading = this.bloodPressureReadings.get(readingId);
    if (!reading || reading.familyId !== current.family.id || reading.deletedAt || reading.source !== "healthkit") {
      throw new HttpError(404, "bp_reading_not_found", "Blood pressure reading was not found.");
    }
    return stripDeleted(reading);
  }

  async createBloodGlucose(input: CreateBloodGlucoseInput): Promise<BloodGlucoseReading> {
    const current = this.requireActiveMember(input.actorUserId);
    const profile = this.profiles.get(input.personId);
    if (!profile || profile.familyId !== current.family.id || profile.status !== "active") {
      throw new HttpError(404, "profile_not_found", "Health profile was not found.");
    }
    const now = new Date().toISOString();
    const reading: BloodGlucoseReading = {
      id: crypto.randomUUID(),
      familyId: current.family.id,
      personId: input.personId,
      recordedByUserId: input.actorUserId,
      value: input.value,
      unit: "mg/dL",
      context: input.context,
      measuredAt: input.measuredAt,
      notes: input.notes,
      source: "manual",
      createdAt: now,
      updatedAt: now
    };
    this.bloodGlucoseReadings.set(reading.id, reading);
    this.audit({
      familyId: current.family.id,
      actorUserId: input.actorUserId,
      action: "blood_glucose.created",
      resourceType: "blood_glucose_reading",
      resourceId: reading.id,
      metadata: { personId: input.personId }
    });
    return reading;
  }

  async listBloodGlucose(actorUserId: string, personId?: string, limit = 50): Promise<BloodGlucoseReading[]> {
    const current = this.requireActiveMember(actorUserId);
    return [...this.bloodGlucoseReadings.values()]
      .filter((reading) => reading.familyId === current.family.id && !reading.deletedAt)
      .filter((reading) => !personId || reading.personId === personId)
      .sort((a, b) => Date.parse(b.measuredAt) - Date.parse(a.measuredAt))
      .slice(0, limit)
      .map(stripDeleted);
  }

  async getBloodGlucose(actorUserId: string, readingId: string): Promise<BloodGlucoseReading> {
    const current = this.requireActiveMember(actorUserId);
    const reading = this.bloodGlucoseReadings.get(readingId);
    if (!reading || reading.familyId !== current.family.id || reading.deletedAt) {
      throw new HttpError(404, "glucose_reading_not_found", "Blood sugar reading was not found.");
    }
    return stripDeleted(reading);
  }

  async updateBloodGlucose(
    actorUserId: string,
    readingId: string,
    input: UpdateBloodGlucoseInput
  ): Promise<BloodGlucoseReading> {
    const current = this.requireActiveMember(actorUserId);
    const reading = this.bloodGlucoseReadings.get(readingId);
    if (!reading || reading.familyId !== current.family.id || reading.deletedAt) {
      throw new HttpError(404, "glucose_reading_not_found", "Blood sugar reading was not found.");
    }
    if (reading.recordedByUserId !== actorUserId && current.membership.role !== "manager") {
      throw new HttpError(403, "reading_owner_or_manager_required", "Only the recorder or a manager can change this reading.");
    }
    const updated = { ...reading, ...defined(input), updatedAt: new Date().toISOString() };
    this.bloodGlucoseReadings.set(readingId, updated);
    this.audit({
      familyId: current.family.id,
      actorUserId,
      action: "blood_glucose.updated",
      resourceType: "blood_glucose_reading",
      resourceId: readingId
    });
    return stripDeleted(updated);
  }

  async deleteBloodGlucose(actorUserId: string, readingId: string): Promise<void> {
    const current = this.requireActiveMember(actorUserId);
    const reading = this.bloodGlucoseReadings.get(readingId);
    if (!reading || reading.familyId !== current.family.id || reading.deletedAt) {
      throw new HttpError(404, "glucose_reading_not_found", "Blood sugar reading was not found.");
    }
    if (reading.recordedByUserId !== actorUserId && current.membership.role !== "manager") {
      throw new HttpError(403, "reading_owner_or_manager_required", "Only the recorder or a manager can delete this reading.");
    }
    this.bloodGlucoseReadings.set(readingId, { ...reading, deletedAt: new Date().toISOString() });
    this.audit({
      familyId: current.family.id,
      actorUserId,
      action: "blood_glucose.deleted",
      resourceType: "blood_glucose_reading",
      resourceId: readingId
    });
  }

  async getHealthKitSettings(actorUserId: string, personId?: string): Promise<HealthKitSettings> {
    const current = this.requireActiveMember(actorUserId);
    const selfProfile = await this.getSelfProfile(actorUserId);
    if (!selfProfile) {
      throw new HttpError(409, "healthkit_self_profile_required", "Create your self profile before using HealthKit sync.");
    }
    const targetPersonId = personId ?? selfProfile.id;
    assertSelfProfileMatch({ selfProfileId: selfProfile.id, requestedPersonId: targetPersonId });
    return this.buildHealthKitSettings(current.family.id, targetPersonId);
  }

  async putHealthKitSettings(actorUserId: string, input: PutHealthKitSettingsInput): Promise<HealthKitSettings> {
    const current = this.requireActiveMember(actorUserId);
    const selfProfile = await this.getSelfProfile(actorUserId);
    assertSelfProfileMatch({ selfProfileId: selfProfile?.id, requestedPersonId: input.personId });

    const uniqueMetrics = [...new Set(input.enabledMetrics)].filter((m): m is HealthKitMetric =>
      (HEALTHKIT_METRICS as readonly string[]).includes(m)
    );
    const nowIso = new Date().toISOString();
    const existing = this.healthKitProfileSettings.get(input.personId);
    let timezoneVersion = existing?.healthTimezoneVersion ?? 1;
    let timezoneChanged = false;
    if (existing && existing.healthTimezone !== input.healthTimezone) {
      timezoneVersion = existing.healthTimezoneVersion + 1;
      timezoneChanged = true;
    }
    const consentActive = uniqueMetrics.length > 0;
    if (consentActive && !input.consentVersion) {
      throw new HttpError(400, "healthkit_consent_required", "consentVersion is required when enabling metrics.");
    }

    this.healthKitProfileSettings.set(input.personId, {
      personId: input.personId,
      familyId: current.family.id,
      userId: actorUserId,
      consentVersion: consentActive ? input.consentVersion : existing?.consentVersion,
      consentedAt: consentActive ? existing?.consentedAt ?? nowIso : undefined,
      healthTimezone: input.healthTimezone,
      healthTimezoneVersion: timezoneVersion
    });

    const active = this.activeInstallation(input.personId);
    if (active && active.installationId !== input.installationId) {
      if (!input.replaceActiveInstallation) {
        throw new HttpError(
          409,
          "healthkit_installation_inactive",
          "Replacing the active installation requires replaceActiveInstallation=true."
        );
      }
      this.healthKitInstallations.set(`${input.personId}:${active.installationId}`, {
        ...active,
        revokedAt: nowIso
      });
    }
    this.healthKitInstallations.set(`${input.personId}:${input.installationId}`, {
      personId: input.personId,
      familyId: current.family.id,
      installationId: input.installationId,
      activatedAt: nowIso,
      revokedAt: undefined
    });

    for (const metric of HEALTHKIT_METRICS) {
      const enabled = uniqueMetrics.includes(metric);
      this.healthKitMetricEnabled.set(`${input.personId}:${metric}`, enabled);
      const stateKey = `${input.personId}:${metric}`;
      const prev = this.healthMetricSyncState.get(stateKey);
      let status: HealthMetricSyncStatusCode = enabled ? (prev?.status ?? "never_synced") : "disabled";
      if (!enabled) status = "disabled";
      else if (timezoneChanged) status = "repair_needed";
      else if (prev?.status === "disabled") status = "never_synced";
      this.healthMetricSyncState.set(stateKey, {
        personId: input.personId,
        familyId: current.family.id,
        metric,
        lastSuccessfulAt: prev?.lastSuccessfulAt,
        lastAttemptAt: prev?.lastAttemptAt,
        lastErrorCode: prev?.lastErrorCode,
        coverageStartAt: prev?.coverageStartAt,
        coverageEndAt: prev?.coverageEndAt,
        status
      });
    }

    this.audit({
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
    return this.buildHealthKitSettings(current.family.id, input.personId);
  }

  async syncHealthKit(actorUserId: string, input: HealthKitSyncInput): Promise<HealthKitSyncResult> {
    const current = this.requireActiveMember(actorUserId);
    const selfProfile = await this.getSelfProfile(actorUserId);
    assertSelfProfileMatch({ selfProfileId: selfProfile?.id, requestedPersonId: input.personId });

    const receiptKey = `${actorUserId}:${input.personId}:${input.syncId}`;
    const existingReceipt = this.healthKitSyncReceipts.get(receiptKey);
    if (existingReceipt) return existingReceipt;

    const nowIso = new Date().toISOString();
    const affected = metricsAffected(input.operations);

    try {
      const settings = this.healthKitProfileSettings.get(input.personId);
      if (!settings?.consentedAt) {
        throw new HttpError(403, "healthkit_consent_required", "HealthKit upload consent is required.");
      }
      const active = this.activeInstallation(input.personId);
      if (!active || active.installationId !== input.installationId) {
        throw new HttpError(403, "healthkit_installation_inactive", "Installation is not the active HealthKit installation.");
      }
      if (settings.healthTimezoneVersion !== input.timezoneVersion) {
        throw new HttpError(409, "healthkit_timezone_version_invalid", "Timezone version is stale.");
      }

      let repair: (HealthKitRepair & { familyId: string; expectedChunkCount?: number; completedAt?: string }) | undefined;
      if (input.repairId !== undefined) {
        if (input.chunkIndex === undefined) {
          throw new HttpError(400, "healthkit_repair_invalid", "chunkIndex is required with repairId.");
        }
        const chunkKey = `${input.repairId}:${input.chunkIndex}`;
        const existingChunk = this.healthKitRepairChunks.get(chunkKey);
        if (existingChunk) return existingChunk.response;

        repair = this.healthKitRepairs.get(input.repairId);
        if (!repair || repair.personId !== input.personId) {
          throw new HttpError(400, "healthkit_repair_invalid", "Repair session is invalid.");
        }
        if (repair.completedAt || Date.parse(repair.expiresAt) <= Date.now()) {
          throw new HttpError(400, "healthkit_repair_invalid", "Repair session is expired or already completed.");
        }
        if (repair.installationId !== input.installationId) {
          throw new HttpError(400, "healthkit_repair_invalid", "Repair does not belong to this installation.");
        }
        if (repair.timezoneVersion !== input.timezoneVersion) {
          throw new HttpError(409, "healthkit_timezone_version_invalid", "Timezone version is stale.");
        }
        if (affected.length !== 1 || affected[0] !== repair.metric) {
          throw new HttpError(400, "healthkit_repair_invalid", "Repair chunks may only include the repair metric.");
        }
        for (const op of input.operations) {
          assertOperationInRepairRange(op, repairRangeFromMemory(repair));
        }
      }

      for (const metric of affected) {
        if (!this.healthKitMetricEnabled.get(`${input.personId}:${metric}`)) {
          throw new HttpError(403, "healthkit_metric_disabled", `Metric ${metric} is not enabled.`);
        }
      }

      this.applyHealthKitOperations({
        familyId: current.family.id,
        personId: input.personId,
        actorUserId,
        timezoneVersion: input.timezoneVersion,
        operations: input.operations,
        nowIso,
        repairRange: repair !== undefined ? repairRangeFromMemory(repair) : undefined
      });

      for (const metric of affected) {
        this.touchInMemoryMetricState({
          familyId: current.family.id,
          personId: input.personId,
          metric,
          nowIso,
          success: true,
          repairing: Boolean(repair),
          coverageStartAt: repair?.rangeStart,
          coverageEndAt: repair?.rangeEnd
        });
      }

      const result = buildSyncResult({
        syncId: input.syncId,
        operationCount: input.operations.length,
        metricsAffected: affected,
        repairId: input.repairId,
        chunkIndex: input.chunkIndex
      });
      this.healthKitSyncReceipts.set(receiptKey, result);
      if (repair && input.chunkIndex !== undefined) {
        this.healthKitRepairChunks.set(`${repair.repairId}:${input.chunkIndex}`, {
          repairId: repair.repairId,
          chunkIndex: input.chunkIndex,
          syncId: input.syncId,
          response: result
        });
      }

      this.audit({
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
          this.touchInMemoryMetricState({
            familyId: current.family.id,
            personId: input.personId,
            metric,
            nowIso,
            success: false,
            errorCode: error.code
          });
        }
      }
      throw error;
    }
  }

  async createHealthKitRepair(actorUserId: string, input: CreateHealthKitRepairInput): Promise<HealthKitRepair> {
    const current = this.requireActiveMember(actorUserId);
    const selfProfile = await this.getSelfProfile(actorUserId);
    assertSelfProfileMatch({ selfProfileId: selfProfile?.id, requestedPersonId: input.personId });

    const settings = this.healthKitProfileSettings.get(input.personId);
    if (!settings?.consentedAt) {
      throw new HttpError(403, "healthkit_consent_required", "HealthKit upload consent is required.");
    }
    const active = this.activeInstallation(input.personId);
    if (!active || active.installationId !== input.installationId) {
      throw new HttpError(403, "healthkit_installation_inactive", "Installation is not the active HealthKit installation.");
    }
    if (settings.healthTimezoneVersion !== input.timezoneVersion) {
      throw new HttpError(409, "healthkit_timezone_version_invalid", "Timezone version is stale.");
    }
    if (!this.healthKitMetricEnabled.get(`${input.personId}:${input.metric}`)) {
      throw new HttpError(403, "healthkit_metric_disabled", `Metric ${input.metric} is not enabled.`);
    }

    const now = new Date();
    const nowIso = toUtcIso(now);
    for (const repair of this.healthKitRepairs.values()) {
      if (repair.personId === input.personId && repair.metric === input.metric && !repair.completedAt && Date.parse(repair.expiresAt) > now.getTime()) {
        this.healthKitRepairs.set(repair.repairId, { ...repair, expiresAt: nowIso });
      }
    }

    const localEndDay = localDateString(now, settings.healthTimezone);
    const { rangeStartDay, rangeEndDay } = profileLocalSleepDayRange(localEndDay, 90);
    const repair: HealthKitRepair & { familyId: string } = {
      repairId: crypto.randomUUID(),
      personId: input.personId,
      familyId: current.family.id,
      metric: input.metric,
      installationId: input.installationId,
      timezoneVersion: input.timezoneVersion,
      rangeStart: toUtcIso(repairRangeStart(input.metric, now)),
      rangeEnd: nowIso,
      rangeStartDay,
      rangeEndDay,
      expiresAt: toUtcIso(new Date(now.getTime() + REPAIR_TTL_MS))
    };
    this.healthKitRepairs.set(repair.repairId, repair);
    this.touchInMemoryMetricState({
      familyId: current.family.id,
      personId: input.personId,
      metric: input.metric,
      nowIso,
      success: false,
      repairing: true
    });
    this.audit({
      familyId: current.family.id,
      actorUserId,
      action: "healthkit.repair_created",
      resourceType: "healthkit_repair",
      resourceId: repair.repairId,
      metadata: { metric: input.metric, status: "created" }
    });
    return {
      repairId: repair.repairId,
      personId: repair.personId,
      metric: repair.metric,
      installationId: repair.installationId,
      timezoneVersion: repair.timezoneVersion,
      rangeStart: repair.rangeStart,
      rangeEnd: repair.rangeEnd,
      rangeStartDay: repair.rangeStartDay,
      rangeEndDay: repair.rangeEndDay,
      expiresAt: repair.expiresAt
    };
  }

  async completeHealthKitRepair(
    actorUserId: string,
    repairId: string,
    input: CompleteHealthKitRepairInput
  ): Promise<HealthKitRepairCompleteResult> {
    const current = this.requireActiveMember(actorUserId);
    const selfProfile = await this.getSelfProfile(actorUserId);
    if (!selfProfile) {
      throw new HttpError(409, "healthkit_self_profile_required", "Create your self profile before using HealthKit sync.");
    }
    const repair = this.healthKitRepairs.get(repairId);
    if (!repair || repair.personId !== selfProfile.id) {
      throw new HttpError(400, "healthkit_repair_invalid", "Repair session is invalid.");
    }
    if (repair.completedAt) {
      return {
        repairId,
        metric: repair.metric,
        completed: true,
        expectedChunkCount: repair.expectedChunkCount ?? input.expectedChunkCount,
        completedChunkCount: repair.expectedChunkCount ?? input.expectedChunkCount
      };
    }
    if (Date.parse(repair.expiresAt) <= Date.now()) {
      throw new HttpError(400, "healthkit_repair_invalid", "Repair session is expired.");
    }
    const settings = this.healthKitProfileSettings.get(selfProfile.id);
    if (!settings?.consentedAt) {
      throw new HttpError(403, "healthkit_consent_required", "HealthKit upload consent is required.");
    }
    if (settings.healthTimezoneVersion !== repair.timezoneVersion) {
      throw new HttpError(409, "healthkit_timezone_version_invalid", "Timezone version is stale.");
    }
    if (!this.healthKitMetricEnabled.get(`${selfProfile.id}:${repair.metric}`)) {
      throw new HttpError(403, "healthkit_metric_disabled", `Metric ${repair.metric} is not enabled.`);
    }
    const active = this.activeInstallation(selfProfile.id);
    if (!active || active.installationId !== repair.installationId) {
      throw new HttpError(403, "healthkit_installation_inactive", "Installation is not the active HealthKit installation.");
    }

    const chunks = [...this.healthKitRepairChunks.values()].filter((c) => c.repairId === repairId);
    if (chunks.length !== input.expectedChunkCount) {
      throw new HttpError(409, "healthkit_repair_incomplete", "Not all repair chunks are complete.");
    }
    for (let i = 0; i < input.expectedChunkCount; i += 1) {
      if (!chunks.some((c) => c.chunkIndex === i)) {
        throw new HttpError(409, "healthkit_repair_incomplete", "Not all repair chunks are complete.");
      }
    }

    const nowIso = new Date().toISOString();
    if (repair.metric === "sleep") {
      for (const [key, row] of this.healthSleepDays) {
        if (
          row.personId === selfProfile.id &&
          row.timezoneVersion < repair.timezoneVersion &&
          row.sleepDay >= repair.rangeStartDay &&
          row.sleepDay <= repair.rangeEndDay
        ) {
          this.healthSleepDays.delete(key);
        }
      }
    }

    this.healthKitRepairs.set(repairId, {
      ...repair,
      expectedChunkCount: input.expectedChunkCount,
      completedAt: nowIso
    });
    this.healthMetricSyncState.set(`${selfProfile.id}:${repair.metric}`, {
      personId: selfProfile.id,
      familyId: current.family.id,
      metric: repair.metric,
      lastSuccessfulAt: nowIso,
      lastAttemptAt: nowIso,
      lastErrorCode: undefined,
      coverageStartAt: repair.rangeStart,
      coverageEndAt: repair.rangeEnd,
      status: "ready"
    });

    this.audit({
      familyId: current.family.id,
      actorUserId,
      action: "healthkit.repair_completed",
      resourceType: "healthkit_repair",
      resourceId: repairId,
      metadata: {
        metric: repair.metric,
        expected_chunk_count: input.expectedChunkCount,
        status: "completed"
      }
    });

    return {
      repairId,
      metric: repair.metric,
      completed: true,
      expectedChunkCount: input.expectedChunkCount,
      completedChunkCount: input.expectedChunkCount
    };
  }

  async getHealthMetricFreshness(
    actorUserId: string,
    personId: string,
    metric: HealthKitMetric
  ): Promise<HealthMetricFreshness> {
    const current = this.requireActiveMember(actorUserId);
    this.assertProfileInFamily(personId, current.family.id);
    const settings = this.healthKitProfileSettings.get(personId);
    const state = this.healthMetricSyncState.get(`${personId}:${metric}`);
    return {
      metric,
      healthTimezone: settings?.healthTimezone ?? "UTC",
      healthTimezoneVersion: settings?.healthTimezoneVersion ?? 1,
      lastSuccessfulAt: state?.lastSuccessfulAt,
      status: state?.status ?? "never_synced",
      coverageStartAt: state?.coverageStartAt,
      coverageEndAt: state?.coverageEndAt
    };
  }

  async listStepHours(
    actorUserId: string,
    personId: string,
    rangeStartUtc: string,
    rangeEndUtc: string
  ): Promise<HealthStepHourRecord[]> {
    const current = this.requireActiveMember(actorUserId);
    this.assertProfileInFamily(personId, current.family.id);
    const start = Date.parse(rangeStartUtc);
    const end = Date.parse(rangeEndUtc);
    return [...this.healthStepHours.values()]
      .filter((row) => row.familyId === current.family.id && row.personId === personId)
      .filter((row) => {
        const t = Date.parse(row.hourStartUtc);
        return t >= start && t < end;
      })
      .sort((a, b) => a.hourStartUtc.localeCompare(b.hourStartUtc))
      .map(({ personId: p, hourStartUtc, count }) => ({ personId: p, hourStartUtc, count }));
  }

  async listSleepDays(
    actorUserId: string,
    personId: string,
    rangeStartDay: string,
    rangeEndDay: string
  ): Promise<HealthSleepDayRecord[]> {
    const current = this.requireActiveMember(actorUserId);
    this.assertProfileInFamily(personId, current.family.id);
    const byDay = new Map<string, HealthSleepDayRecord>();
    for (const row of this.healthSleepDays.values()) {
      if (row.familyId !== current.family.id || row.personId !== personId) continue;
      if (row.sleepDay < rangeStartDay || row.sleepDay > rangeEndDay) continue;
      const existing = byDay.get(row.sleepDay);
      if (!existing || row.timezoneVersion > existing.timezoneVersion) {
        byDay.set(row.sleepDay, {
          personId: row.personId,
          sleepDay: row.sleepDay,
          timezoneVersion: row.timezoneVersion,
          durationMinutes: row.durationMinutes
        });
      }
    }
    return [...byDay.values()].sort((a, b) => a.sleepDay.localeCompare(b.sleepDay));
  }

  async listHealthKitBloodPressure(
    actorUserId: string,
    personId: string,
    rangeStartUtc: string,
    rangeEndUtc: string,
    limit: number
  ): Promise<BloodPressureReading[]> {
    const current = this.requireActiveMember(actorUserId);
    this.assertProfileInFamily(personId, current.family.id);
    const start = Date.parse(rangeStartUtc);
    const end = Date.parse(rangeEndUtc);
    return [...this.bloodPressureReadings.values()]
      .filter((reading) => !reading.deletedAt)
      .filter(
        (reading) =>
          reading.familyId === current.family.id &&
          reading.personId === personId &&
          reading.source === "healthkit"
      )
      .filter((reading) => {
        const t = Date.parse(reading.measuredAt);
        return t >= start && t <= end;
      })
      .sort((a, b) => Date.parse(a.measuredAt) - Date.parse(b.measuredAt))
      .slice(0, limit)
      .map(stripDeleted);
  }

  private buildHealthKitSettings(familyId: string, personId: string): HealthKitSettings {
    const settings = this.healthKitProfileSettings.get(personId);
    const enabledMetrics = HEALTHKIT_METRICS.filter((metric) => this.healthKitMetricEnabled.get(`${personId}:${metric}`));
    const metrics = HEALTHKIT_METRICS.map((metric) => {
      const state = this.healthMetricSyncState.get(`${personId}:${metric}`);
      const enabled = enabledMetrics.includes(metric);
      return {
        metric,
        enabled,
        lastSuccessfulAt: state?.lastSuccessfulAt,
        lastAttemptAt: state?.lastAttemptAt,
        lastErrorCode: state?.lastErrorCode,
        coverageStartAt: state?.coverageStartAt,
        coverageEndAt: state?.coverageEndAt,
        status: state?.status ?? (enabled ? "never_synced" : "disabled")
      };
    });
    return {
      personId,
      consentVersion: settings?.consentVersion,
      consentedAt: settings?.consentedAt,
      healthTimezone: settings?.healthTimezone ?? "UTC",
      healthTimezoneVersion: settings?.healthTimezoneVersion ?? 1,
      enabledMetrics,
      activeInstallationId: this.activeInstallation(personId)?.installationId,
      metrics
    };
  }

  private activeInstallation(personId: string) {
    return [...this.healthKitInstallations.values()].find((row) => row.personId === personId && !row.revokedAt);
  }

  private applyHealthKitOperations(input: {
    familyId: string;
    personId: string;
    actorUserId: string;
    timezoneVersion: number;
    operations: HealthKitSyncOperation[];
    nowIso: string;
    repairRange?: HealthKitRepairRange;
  }) {
    for (const op of input.operations) {
      switch (op.kind) {
        case "steps_hour_upsert":
          this.healthStepHours.set(`${input.personId}:${op.hourStartUtc}`, {
            familyId: input.familyId,
            personId: input.personId,
            hourStartUtc: op.hourStartUtc,
            count: op.count
          });
          break;
        case "sleep_day_upsert":
          this.healthSleepDays.set(`${input.personId}:${op.sleepDay}:${input.timezoneVersion}`, {
            familyId: input.familyId,
            personId: input.personId,
            sleepDay: op.sleepDay,
            timezoneVersion: input.timezoneVersion,
            durationMinutes: op.durationMinutes
          });
          break;
        case "blood_pressure_upsert": {
          const existing = [...this.bloodPressureReadings.values()].find(
            (reading) =>
              reading.personId === input.personId &&
              reading.source === "healthkit" &&
              reading.sourceSampleKey === op.sourceSampleKey
          );
          const storeKey =
            [...this.bloodPressureReadings.entries()].find(([, reading]) => {
              return (
                reading.personId === input.personId &&
                reading.source === "healthkit" &&
                reading.sourceSampleKey === op.sourceSampleKey
              );
            })?.[0] ?? crypto.randomUUID();
          const reading: BloodPressureReading & { sourceSampleKey?: string; deletedAt?: string } = {
            id: existing?.id ?? storeKey,
            familyId: input.familyId,
            personId: input.personId,
            recordedByUserId: input.actorUserId,
            systolic: op.systolic,
            diastolic: op.diastolic,
            pulse: op.pulse,
            measuredAt: op.measuredAtUtc,
            source: "healthkit",
            sourceSampleKey: op.sourceSampleKey,
            createdAt: existing?.createdAt ?? input.nowIso,
            updatedAt: input.nowIso,
            deletedAt: undefined
          };
          this.bloodPressureReadings.set(storeKey, reading);
          break;
        }
        case "blood_pressure_delete": {
          for (const [key, reading] of this.bloodPressureReadings) {
            if (
              reading.personId === input.personId &&
              reading.source === "healthkit" &&
              reading.sourceSampleKey === op.sourceSampleKey
            ) {
              if (input.repairRange) {
                const t = Date.parse(reading.measuredAt);
                const start = Date.parse(input.repairRange.rangeStartIso);
                const end = Date.parse(input.repairRange.rangeEndIso);
                if (t < start || t > end) {
                  throw new HttpError(
                    400,
                    "healthkit_operation_invalid",
                    "blood pressure deletion is outside the repair range."
                  );
                }
              }
              this.bloodPressureReadings.delete(key);
            }
          }
          break;
        }
      }
    }
  }

  private touchInMemoryMetricState(input: {
    familyId: string;
    personId: string;
    metric: HealthKitMetric;
    nowIso: string;
    success: boolean;
    repairing?: boolean;
    errorCode?: string;
    coverageStartAt?: string;
    coverageEndAt?: string;
  }) {
    const key = `${input.personId}:${input.metric}`;
    const prev = this.healthMetricSyncState.get(key);
    let status: HealthMetricSyncStatusCode = prev?.status ?? "never_synced";
    if (input.repairing) status = "repairing";
    else if (input.success) {
      if (status === "error" || status === "repair_needed" || status === "never_synced") status = "ready";
    } else if (status !== "repairing" && status !== "disabled") {
      status = "error";
    }
    this.healthMetricSyncState.set(key, {
      personId: input.personId,
      familyId: input.familyId,
      metric: input.metric,
      lastSuccessfulAt: input.success ? input.nowIso : prev?.lastSuccessfulAt,
      lastAttemptAt: input.nowIso,
      lastErrorCode: input.success ? undefined : input.errorCode ?? prev?.lastErrorCode,
      coverageStartAt: prev?.coverageStartAt ?? input.coverageStartAt,
      coverageEndAt: input.success && !input.repairing ? input.nowIso : prev?.coverageEndAt ?? input.coverageEndAt,
      status
    });
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

function repairRangeFromMemory(repair: HealthKitRepair): HealthKitRepairRange {
  return {
    rangeStartIso: repair.rangeStart,
    rangeEndIso: repair.rangeEnd,
    rangeStartDay: repair.rangeStartDay,
    rangeEndDay: repair.rangeEndDay
  };
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
    email: invite.email,
    role: invite.role,
    status: invite.status,
    expiresAt: invite.expiresAt,
    createdAt: invite.createdAt
  };
}
