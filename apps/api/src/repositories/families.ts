import { createHash } from "node:crypto";
import type {
  CreateInviteResponse,
  BloodPressureReading,
  BloodGlucoseReading,
  CurrentFamilyResponse,
  Family,
  FamilyInvite,
  FamilyMembership,
  FamilyRole,
  HealthProfile,
  GlucoseContext,
  PersonStatus,
  PublicInviteResponse
} from "@family-os/shared";
import { HttpError } from "../errors";

export type CreateFamilyInput = {
  name: string;
  userId: string;
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

export interface FamilyRepository {
  createFamily(input: CreateFamilyInput): Promise<CurrentFamilyResponse>;
  getCurrentFamily(userId: string): Promise<CurrentFamilyResponse>;
  createInvite(input: CreateInviteInput): Promise<CreateInviteResponse>;
  getInviteByToken(token: string): Promise<PublicInviteResponse>;
  acceptInvite(token: string, userId: string, userEmail?: string): Promise<CurrentFamilyResponse>;
  listProfiles(actorUserId: string): Promise<HealthProfile[]>;
  getProfile(actorUserId: string, profileId: string): Promise<HealthProfile>;
  createProfile(input: CreateProfileInput): Promise<HealthProfile>;
  updateProfile(actorUserId: string, profileId: string, input: UpdateProfileInput): Promise<HealthProfile>;
  deleteProfile(actorUserId: string, profileId: string): Promise<void>;
  createBloodPressure(input: CreateBloodPressureInput): Promise<BloodPressureReading>;
  listBloodPressure(actorUserId: string, personId?: string, limit?: number): Promise<BloodPressureReading[]>;
  getBloodPressure(actorUserId: string, readingId: string): Promise<BloodPressureReading>;
  updateBloodPressure(actorUserId: string, readingId: string, input: UpdateBloodPressureInput): Promise<BloodPressureReading>;
  deleteBloodPressure(actorUserId: string, readingId: string): Promise<void>;
  createBloodGlucose(input: CreateBloodGlucoseInput): Promise<BloodGlucoseReading>;
  listBloodGlucose(actorUserId: string, personId?: string, limit?: number): Promise<BloodGlucoseReading[]>;
  getBloodGlucose(actorUserId: string, readingId: string): Promise<BloodGlucoseReading>;
  updateBloodGlucose(actorUserId: string, readingId: string, input: UpdateBloodGlucoseInput): Promise<BloodGlucoseReading>;
  deleteBloodGlucose(actorUserId: string, readingId: string): Promise<void>;
}

export class InMemoryFamilyRepository implements FamilyRepository {
  private readonly families = new Map<string, Family>();
  private readonly memberships = new Map<string, FamilyMembership>();
  private readonly invites = new Map<string, FamilyInvite & { tokenHash: string }>();
  private readonly profiles = new Map<string, HealthProfile>();
  private readonly bloodPressureReadings = new Map<string, BloodPressureReading & { deletedAt?: string }>();
  private readonly bloodGlucoseReadings = new Map<string, BloodGlucoseReading & { deletedAt?: string }>();

  async createFamily(input: CreateFamilyInput): Promise<CurrentFamilyResponse> {
    const existing = await this.getCurrentFamily(input.userId);
    if (existing) {
      throw new HttpError(409, "family_already_exists", "User already has an active family.");
    }

    const now = new Date().toISOString();
    const family: Family = {
      id: crypto.randomUUID(),
      name: input.name,
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

  async createInvite(input: CreateInviteInput): Promise<CreateInviteResponse> {
    const current = this.getCurrentFamilySync(input.actorUserId);
    if (!current || current.membership.role !== "manager") {
      throw new HttpError(403, "manager_required", "Only family managers can create invites.");
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
      throw new HttpError(409, "family_already_exists", "User already has an active family.");
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

    const family = this.families.get(invite.familyId);
    if (!family) {
      throw new HttpError(404, "invite_not_found", "Invite was not found.");
    }

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
      createdAt: now,
      updatedAt: now
    };
    this.bloodPressureReadings.set(reading.id, reading);
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
      createdAt: now,
      updatedAt: now
    };
    this.bloodGlucoseReadings.set(reading.id, reading);
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
}

function defined<T extends object>(input: T): Partial<T> {
  return Object.fromEntries(Object.entries(input).filter(([, value]) => value !== undefined)) as Partial<T>;
}

function stripDeleted<T extends { deletedAt?: string }>(input: T): Omit<T, "deletedAt"> {
  const { deletedAt: _deletedAt, ...rest } = input;
  return rest;
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
