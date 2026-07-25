import type {
  AuditLog,
  BloodGlucoseReading,
  BloodPressureReading,
  BootstrapResponse,
  CompleteHealthKitRepairInput,
  CreateHealthKitRepairInput,
  CreateInviteResponse,
  CurrentFamilyResponse,
  FamilyMember,
  FamilyMembership,
  HealthKitMetric,
  HealthKitRepair,
  HealthKitRepairCompleteResult,
  HealthKitSettings,
  HealthKitSyncInput,
  HealthKitSyncResult,
  HealthMetricFreshness,
  HealthProfile,
  HealthSleepDayRecord,
  HealthStepHourRecord,
  McpCapability,
  McpConnectionGrant,
  NotificationDelivery,
  NotificationDevice,
  PublicInviteResponse,
  PutHealthKitSettingsInput,
  Reminder,
  ReminderRecipient
} from "@family-os/shared";
import type {
  CreateBloodGlucoseInput,
  CreateFamilyInput,
  CreateInviteInput,
  CreateProfileInput,
  CreateReminderInput,
  RegisterDeviceInput,
  UpdateBloodGlucoseInput,
  UpdateProfileInput,
  UpdateReminderInput
} from "./families";

export type RecordAuditInput = {
  familyId: string;
  actorUserId?: string;
  action: string;
  resourceType: string;
  resourceId: string;
  metadata?: Record<string, unknown>;
};

export interface FamilyStore {
  createFamily(input: CreateFamilyInput): Promise<CurrentFamilyResponse>;
  getCurrentFamily(userId: string): Promise<CurrentFamilyResponse>;
  bootstrap(userId: string): Promise<BootstrapResponse>;
  listMembers(actorUserId: string): Promise<FamilyMember[]>;
}

export interface InviteStore {
  createInvite(input: CreateInviteInput): Promise<CreateInviteResponse>;
  getInviteByToken(token: string): Promise<PublicInviteResponse>;
  acceptInvite(token: string, userId: string, userEmail?: string): Promise<CurrentFamilyResponse>;
}

export interface ProfileStore {
  listProfiles(actorUserId: string): Promise<HealthProfile[]>;
  getProfile(actorUserId: string, profileId: string): Promise<HealthProfile>;
  createProfile(input: CreateProfileInput): Promise<HealthProfile>;
  createSelfProfile(actorUserId: string, displayName: string): Promise<HealthProfile>;
  getSelfProfile(actorUserId: string): Promise<HealthProfile | null>;
  updateProfile(actorUserId: string, profileId: string, input: UpdateProfileInput): Promise<HealthProfile>;
  deleteProfile(actorUserId: string, profileId: string): Promise<void>;
}

export interface ReadingStore {
  /** HealthKit-synced BP only (manual BP write paths are removed). */
  listBloodPressure(actorUserId: string, personId?: string, limit?: number): Promise<BloodPressureReading[]>;
  getBloodPressure(actorUserId: string, readingId: string): Promise<BloodPressureReading>;
  createBloodGlucose(input: CreateBloodGlucoseInput): Promise<BloodGlucoseReading>;
  listBloodGlucose(actorUserId: string, personId?: string, limit?: number): Promise<BloodGlucoseReading[]>;
  getBloodGlucose(actorUserId: string, readingId: string): Promise<BloodGlucoseReading>;
  updateBloodGlucose(actorUserId: string, readingId: string, input: UpdateBloodGlucoseInput): Promise<BloodGlucoseReading>;
  deleteBloodGlucose(actorUserId: string, readingId: string): Promise<void>;
}

export interface HealthKitStore {
  getHealthKitSettings(actorUserId: string, personId?: string): Promise<HealthKitSettings>;
  putHealthKitSettings(actorUserId: string, input: PutHealthKitSettingsInput): Promise<HealthKitSettings>;
  syncHealthKit(actorUserId: string, input: HealthKitSyncInput): Promise<HealthKitSyncResult>;
  createHealthKitRepair(actorUserId: string, input: CreateHealthKitRepairInput): Promise<HealthKitRepair>;
  completeHealthKitRepair(
    actorUserId: string,
    repairId: string,
    input: CompleteHealthKitRepairInput
  ): Promise<HealthKitRepairCompleteResult>;
  getHealthMetricFreshness(actorUserId: string, personId: string, metric: HealthKitMetric): Promise<HealthMetricFreshness>;
  listStepHours(
    actorUserId: string,
    personId: string,
    rangeStartUtc: string,
    rangeEndUtc: string
  ): Promise<HealthStepHourRecord[]>;
  listSleepDays(
    actorUserId: string,
    personId: string,
    rangeStartDay: string,
    rangeEndDay: string
  ): Promise<HealthSleepDayRecord[]>;
  listHealthKitBloodPressure(
    actorUserId: string,
    personId: string,
    rangeStartUtc: string,
    rangeEndUtc: string,
    limit: number
  ): Promise<BloodPressureReading[]>;
}

export type CreateMcpConnectionInput = {
  userId: string;
  oauthClientId: string;
  capabilities: McpCapability[];
  consentVersion: string;
  expiresAt?: string;
};

export interface McpConnectionStore {
  createConnection(input: CreateMcpConnectionInput): Promise<McpConnectionGrant>;
  getActiveConnection(userId: string, oauthClientId: string): Promise<McpConnectionGrant | null>;
  revokeConnection(userId: string, connectionId: string): Promise<McpConnectionGrant>;
  listConnections(userId: string): Promise<McpConnectionGrant[]>;
}

export interface ReminderStore {
  createReminder(input: CreateReminderInput): Promise<Reminder>;
  listReminders(actorUserId: string): Promise<Reminder[]>;
  getReminder(actorUserId: string, reminderId: string): Promise<Reminder>;
  updateReminder(actorUserId: string, reminderId: string, input: UpdateReminderInput): Promise<Reminder>;
  deleteReminder(actorUserId: string, reminderId: string): Promise<void>;
  disableReminderForSelf(actorUserId: string, reminderId: string): Promise<ReminderRecipient>;
}

export interface DeviceStore {
  registerDevice(input: RegisterDeviceInput): Promise<NotificationDevice>;
  deleteDevice(actorUserId: string, deviceId: string): Promise<void>;
}

export interface NotificationDeliveryStore {
  listDueReminderDeliveries(now: Date): Promise<Array<{ reminder: Reminder; recipient: ReminderRecipient; devices: NotificationDevice[]; delivery: NotificationDelivery }>>;
  markDeliverySent(deliveryId: string): Promise<void>;
  markDeliveryFailed(deliveryId: string, error: string): Promise<void>;
}

export interface AuditLogStore {
  listAuditLogs(actorUserId: string, limit?: number): Promise<AuditLog[]>;
  recordAudit(input: RecordAuditInput): Promise<void>;
}

export type AppRepositories = {
  families: FamilyStore;
  invites: InviteStore;
  profiles: ProfileStore;
  readings: ReadingStore;
  healthKit: HealthKitStore;
  reminders: ReminderStore;
  devices: DeviceStore;
  notificationDeliveries: NotificationDeliveryStore;
  auditLogs: AuditLogStore;
  mcpConnections: McpConnectionStore;
};
