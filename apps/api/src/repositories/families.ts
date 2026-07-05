import { createHash } from "node:crypto";
import type {
  AuditLog,
  CreateInviteResponse,
  BloodPressureReading,
  BloodGlucoseReading,
  BootstrapResponse,
  FamilyMember,
  HealthKitImportResult,
  HealthKitMetricType,
  HealthKitSampleInput,
  HealthKitSyncStatus,
  HealthMetricDailySummary,
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
  DeviceStore,
  FamilyStore,
  HealthKitStore,
  InviteStore,
  NotificationDeliveryStore,
  ProfileStore,
  ReadingStore,
  ReminderStore
} from "./contracts";

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
    AuditLogStore {}

export class InMemoryFamilyRepository implements FamilyRepository {
  private readonly families = new Map<string, Family>();
  private readonly memberships = new Map<string, FamilyMembership>();
  private readonly invites = new Map<string, FamilyInvite & { tokenHash: string }>();
  private readonly profiles = new Map<string, HealthProfile>();
  private readonly bloodPressureReadings = new Map<string, BloodPressureReading & { deletedAt?: string }>();
  private readonly bloodGlucoseReadings = new Map<string, BloodGlucoseReading & { deletedAt?: string }>();
  private readonly healthKitSettings = new Map<string, { userId: string; personId: string; enabledMetrics: HealthKitMetricType[] }>();
  private readonly healthKitSyncRuns = new Map<string, HealthKitSyncStatus["lastSync"] & { userId: string; personId: string }>();
  private readonly healthKitSamples = new Map<string, HealthKitSampleInput & { id: string; familyId: string; personId: string; userId: string; syncRunId: string }>();
  private readonly healthMetricDailySummaries = new Map<string, HealthMetricDailySummary>();
  private readonly reminders = new Map<string, Reminder & { deletedAt?: string }>();
  private readonly devices = new Map<string, NotificationDevice>();
  private readonly deliveries = new Map<string, NotificationDelivery>();
  private readonly auditLogs: AuditLog[] = [];

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
      (reading) => reading.familyId === familyId && !reading.deletedAt && reading.source === "manual"
    );
    if (hasBloodPressure) {
      throw new HttpError(409, "unsafe_workspace_switch", "Workspace has manual blood pressure readings.");
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

  async createBloodPressure(input: CreateBloodPressureInput): Promise<BloodPressureReading> {
    const current = this.requireActiveMember(input.actorUserId);
    const profile = this.profiles.get(input.personId);
    if (!profile || profile.familyId !== current.family.id || profile.status !== "active") {
      throw new HttpError(404, "profile_not_found", "Health profile was not found.");
    }
    const now = new Date().toISOString();
    const reading: BloodPressureReading = {
      id: crypto.randomUUID(),
      familyId: current.family.id,
      personId: input.personId,
      recordedByUserId: input.actorUserId,
      systolic: input.systolic,
      diastolic: input.diastolic,
      pulse: input.pulse,
      measuredAt: input.measuredAt,
      context: input.context,
      notes: input.notes,
      source: "manual",
      createdAt: now,
      updatedAt: now
    };
    this.bloodPressureReadings.set(reading.id, reading);
    this.audit({
      familyId: current.family.id,
      actorUserId: input.actorUserId,
      action: "blood_pressure.created",
      resourceType: "blood_pressure_reading",
      resourceId: reading.id,
      metadata: { personId: input.personId }
    });
    return reading;
  }

  async listBloodPressure(actorUserId: string, personId?: string, limit = 50): Promise<BloodPressureReading[]> {
    const current = this.requireActiveMember(actorUserId);
    return [...this.bloodPressureReadings.values()]
      .filter((reading) => reading.familyId === current.family.id && !reading.deletedAt)
      .filter((reading) => !personId || reading.personId === personId)
      .sort((a, b) => Date.parse(b.measuredAt) - Date.parse(a.measuredAt))
      .slice(0, limit)
      .map(stripDeleted);
  }

  async getBloodPressure(actorUserId: string, readingId: string): Promise<BloodPressureReading> {
    const current = this.requireActiveMember(actorUserId);
    const reading = this.bloodPressureReadings.get(readingId);
    if (!reading || reading.familyId !== current.family.id || reading.deletedAt) {
      throw new HttpError(404, "bp_reading_not_found", "Blood pressure reading was not found.");
    }
    return stripDeleted(reading);
  }

  async updateBloodPressure(
    actorUserId: string,
    readingId: string,
    input: UpdateBloodPressureInput
  ): Promise<BloodPressureReading> {
    const current = this.requireActiveMember(actorUserId);
    const reading = this.bloodPressureReadings.get(readingId);
    if (!reading || reading.familyId !== current.family.id || reading.deletedAt) {
      throw new HttpError(404, "bp_reading_not_found", "Blood pressure reading was not found.");
    }
    if (reading.recordedByUserId !== actorUserId && current.membership.role !== "manager") {
      throw new HttpError(403, "reading_owner_or_manager_required", "Only the recorder or a manager can change this reading.");
    }
    const updated = { ...reading, ...defined(input), updatedAt: new Date().toISOString() };
    this.bloodPressureReadings.set(readingId, updated);
    this.audit({
      familyId: current.family.id,
      actorUserId,
      action: "blood_pressure.updated",
      resourceType: "blood_pressure_reading",
      resourceId: readingId
    });
    return stripDeleted(updated);
  }

  async deleteBloodPressure(actorUserId: string, readingId: string): Promise<void> {
    const current = this.requireActiveMember(actorUserId);
    const reading = this.bloodPressureReadings.get(readingId);
    if (!reading || reading.familyId !== current.family.id || reading.deletedAt) {
      throw new HttpError(404, "bp_reading_not_found", "Blood pressure reading was not found.");
    }
    if (reading.recordedByUserId !== actorUserId && current.membership.role !== "manager") {
      throw new HttpError(403, "reading_owner_or_manager_required", "Only the recorder or a manager can delete this reading.");
    }
    this.bloodPressureReadings.set(readingId, { ...reading, deletedAt: new Date().toISOString() });
    this.audit({
      familyId: current.family.id,
      actorUserId,
      action: "blood_pressure.deleted",
      resourceType: "blood_pressure_reading",
      resourceId: readingId
    });
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

  async getHealthKitSyncStatus(actorUserId: string): Promise<HealthKitSyncStatus> {
    this.requireActiveMember(actorUserId);
    const selfProfile = await this.getSelfProfile(actorUserId);
    const setting = this.healthKitSettings.get(actorUserId);
    const lastSync = [...this.healthKitSyncRuns.values()]
      .filter((run) => run.userId === actorUserId)
      .sort((a, b) => Date.parse(b.startedAt) - Date.parse(a.startedAt))[0];
    return {
      linkedProfileId: selfProfile?.id,
      enabledMetrics: setting?.enabledMetrics ?? [],
      lastSync: lastSync
        ? {
            id: lastSync.id,
            status: lastSync.status,
            startedAt: lastSync.startedAt,
            finishedAt: lastSync.finishedAt,
            importedCount: lastSync.importedCount,
            skippedCount: lastSync.skippedCount,
            failedCount: lastSync.failedCount
          }
        : undefined
    };
  }

  async linkHealthKitProfile(actorUserId: string, personId: string): Promise<HealthKitSyncStatus> {
    const current = this.requireActiveMember(actorUserId);
    const selfProfile = await this.getSelfProfile(actorUserId);
    if (!selfProfile) {
      throw new HttpError(409, "healthkit_profile_required", "Create your self profile before using HealthKit sync.");
    }
    if (selfProfile.id !== personId) {
      throw new HttpError(409, "healthkit_profile_must_be_self", "HealthKit sync can only target your own self profile.");
    }
    this.profiles.set(personId, { ...selfProfile, linkedUserId: actorUserId, relationshipLabel: "Self", updatedAt: new Date().toISOString() });
    this.healthKitSettings.set(actorUserId, {
      userId: actorUserId,
      personId,
      enabledMetrics: this.healthKitSettings.get(actorUserId)?.enabledMetrics ?? []
    });
    this.audit({
      familyId: current.family.id,
      actorUserId,
      action: "healthkit.profile_linked",
      resourceType: "health_profile",
      resourceId: personId
    });
    return this.getHealthKitSyncStatus(actorUserId);
  }

  async updateHealthKitSyncSettings(actorUserId: string, enabledMetrics: HealthKitMetricType[]): Promise<HealthKitSyncStatus> {
    const current = this.requireActiveMember(actorUserId);
    const selfProfile = await this.getSelfProfile(actorUserId);
    if (!selfProfile) {
      throw new HttpError(409, "healthkit_profile_required", "Create your self profile before enabling HealthKit sync.");
    }
    const uniqueMetrics = [...new Set(enabledMetrics)].filter(isHealthKitMetricType);
    this.healthKitSettings.set(actorUserId, {
      userId: actorUserId,
      personId: selfProfile.id,
      enabledMetrics: uniqueMetrics
    });
    this.audit({
      familyId: current.family.id,
      actorUserId,
      action: "healthkit.settings_updated",
      resourceType: "health_profile",
      resourceId: selfProfile.id,
      metadata: { enabledMetrics: uniqueMetrics }
    });
    return this.getHealthKitSyncStatus(actorUserId);
  }

  async importHealthKitSamples(actorUserId: string, samples: HealthKitSampleInput[]): Promise<HealthKitImportResult> {
    const current = this.requireActiveMember(actorUserId);
    const selfProfile = await this.getSelfProfile(actorUserId);
    if (!selfProfile) {
      throw new HttpError(409, "healthkit_profile_required", "Create your self profile before importing HealthKit data.");
    }
    const setting = this.healthKitSettings.get(actorUserId);
    const enabled = new Set(setting?.enabledMetrics ?? []);
    const syncRunId = crypto.randomUUID();
    const now = new Date().toISOString();
    let importedCount = 0;
    let skippedCount = 0;
    let failedCount = 0;

    for (const sample of samples) {
      if (!enabled.has(sample.metricType)) {
        skippedCount += 1;
        continue;
      }
      const sampleKey = `${selfProfile.id}:${sample.sourceSampleKey}`;
      if (this.healthKitSamples.has(sampleKey)) {
        skippedCount += 1;
        continue;
      }
      if (!isValidHealthKitSample(sample)) {
        failedCount += 1;
        continue;
      }
      this.healthKitSamples.set(sampleKey, {
        ...sample,
        id: crypto.randomUUID(),
        familyId: current.family.id,
        personId: selfProfile.id,
        userId: actorUserId,
        syncRunId
      });
      if (sample.metricType === "blood_pressure") {
        const reading: BloodPressureReading = {
          id: crypto.randomUUID(),
          familyId: current.family.id,
          personId: selfProfile.id,
          recordedByUserId: actorUserId,
          systolic: sample.systolic!,
          diastolic: sample.diastolic!,
          pulse: sample.pulse,
          measuredAt: sample.startDate,
          source: "healthkit",
          createdAt: now,
          updatedAt: now
        };
        this.bloodPressureReadings.set(reading.id, reading);
      } else if (sample.metricType === "blood_glucose") {
        const reading: BloodGlucoseReading = {
          id: crypto.randomUUID(),
          familyId: current.family.id,
          personId: selfProfile.id,
          recordedByUserId: actorUserId,
          value: sample.value!,
          unit: "mg/dL",
          context: sample.glucoseContext ?? "random",
          measuredAt: sample.startDate,
          source: "healthkit",
          createdAt: now,
          updatedAt: now
        };
        this.bloodGlucoseReadings.set(reading.id, reading);
      }
      importedCount += 1;
    }

    this.rebuildHealthMetricSummaries(current.family.id, selfProfile.id);
    const run = {
      id: syncRunId,
      userId: actorUserId,
      personId: selfProfile.id,
      status: failedCount > 0 ? "failed" as const : "completed" as const,
      startedAt: now,
      finishedAt: new Date().toISOString(),
      importedCount,
      skippedCount,
      failedCount
    };
    this.healthKitSyncRuns.set(syncRunId, run);
    this.audit({
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
    const current = this.requireActiveMember(actorUserId);
    return [...this.healthMetricDailySummaries.values()]
      .filter((summary) => summary.familyId === current.family.id)
      .filter((summary) => !personId || summary.personId === personId)
      .filter((summary) => !metricType || summary.metricType === metricType)
      .sort((a, b) => b.date.localeCompare(a.date))
      .slice(0, limit);
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

  private rebuildHealthMetricSummaries(familyId: string, personId: string) {
    for (const key of [...this.healthMetricDailySummaries.keys()]) {
      const summary = this.healthMetricDailySummaries.get(key);
      if (summary?.familyId === familyId && summary.personId === personId) {
        this.healthMetricDailySummaries.delete(key);
      }
    }
    const samples = [...this.healthKitSamples.values()].filter(
      (sample) => sample.familyId === familyId && sample.personId === personId && !["blood_pressure", "blood_glucose"].includes(sample.metricType)
    );
    const groups = new Map<string, typeof samples>();
    for (const sample of samples) {
      const key = `${sample.metricType}:${sample.startDate.slice(0, 10)}`;
      groups.set(key, [...(groups.get(key) ?? []), sample]);
    }
    for (const [key, grouped] of groups) {
      const [metricType, date] = key.split(":") as [HealthKitMetricType, string];
      const latest = grouped.sort((a, b) => Date.parse(b.startDate) - Date.parse(a.startDate))[0];
      if (!latest) continue;
      const aggregateValue = metricType === "weight"
        ? latest.value ?? 0
        : grouped.reduce((sum, sample) => sum + (sample.value ?? 0), 0);
      const summary: HealthMetricDailySummary = {
        id: crypto.randomUUID(),
        familyId,
        personId,
        metricType,
        date,
        value: aggregateValue,
        unit: latest.unit ?? defaultUnit(metricType),
        source: "healthkit",
        sampleCount: grouped.length,
        updatedAt: new Date().toISOString()
      };
      this.healthMetricDailySummaries.set(`${personId}:${metricType}:${date}`, summary);
    }
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

function isValidHealthKitSample(sample: HealthKitSampleInput) {
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

function isHealthKitMetricType(metricType: string): metricType is HealthKitMetricType {
  return ["steps", "walking_distance", "sleep", "weight", "blood_pressure", "blood_glucose"].includes(metricType);
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
