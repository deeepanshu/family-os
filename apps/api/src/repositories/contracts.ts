import type {
  AbortHealthKitBackfillSessionInput,
  AuditLog,
  BloodPressureReading,
  BootstrapResponse,
  CompleteHealthKitBackfillSessionInput,
  CreateHealthKitBackfillSessionInput,
  CreateInviteResponse,
  CurrentFamilyResponse,
  FamilyMember,
  FamilyMembership,
  HealthKitBackfillSession,
  HealthKitBackfillSessionAbortResult,
  HealthKitBackfillSessionCompleteResult,
  HealthKitEventsBatchInput,
  HealthKitEventsBatchResult,
  HealthKitGroupManifest,
  HealthKitMetric,
  HealthKitMetricKey,
  HealthKitScopeManifestResult,
  HealthKitSettings,
  HealthDailyMetricRecord,
  HealthMetricFreshness,
  HealthProfile,
  HealthSleepDayRecord,
  HealthStepHourRecord,
  HealthWorkoutRecord,
  BloodGlucoseReading,
  McpCapability,
  McpConnectionGrant,
  NotificationDelivery,
  NotificationDevice,
  PublicInviteResponse,
  PutHealthKitScopeManifestInput,
  PutHealthKitSettingsInput,
  Reminder,
  ReminderRecipient
} from "@family-os/shared";
import type {
  CreateFamilyInput,
  CreateInviteInput,
  CreateProfileInput,
  CreateReminderInput,
  RegisterDeviceInput,
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
  /** HealthKit-synced readings only; manual write paths are removed. */
  listBloodPressure(actorUserId: string, personId?: string, limit?: number): Promise<BloodPressureReading[]>;
  getBloodPressure(actorUserId: string, readingId: string): Promise<BloodPressureReading>;
}

export interface HealthKitStore {
  getHealthKitSettings(actorUserId: string, personId?: string): Promise<HealthKitSettings>;
  putHealthKitSettings(actorUserId: string, input: PutHealthKitSettingsInput): Promise<HealthKitSettings>;
  applyHealthKitEvents(actorUserId: string, input: HealthKitEventsBatchInput): Promise<HealthKitEventsBatchResult>;
  createBackfillSession(
    actorUserId: string,
    input: CreateHealthKitBackfillSessionInput
  ): Promise<HealthKitBackfillSession>;
  putScopeManifest(
    actorUserId: string,
    sessionId: string,
    scopeKey: string,
    input: PutHealthKitScopeManifestInput
  ): Promise<HealthKitScopeManifestResult>;
  completeBackfillSession(
    actorUserId: string,
    sessionId: string,
    input: CompleteHealthKitBackfillSessionInput
  ): Promise<HealthKitBackfillSessionCompleteResult>;
  abortBackfillSession(
    actorUserId: string,
    sessionId: string,
    input: AbortHealthKitBackfillSessionInput
  ): Promise<HealthKitBackfillSessionAbortResult>;
  getBackfillSession(actorUserId: string, sessionId: string): Promise<HealthKitBackfillSession>;
  listBackfillPending(
    actorUserId: string,
    sessionId: string,
    cursor?: string,
    limit?: number
  ): Promise<{ eventIds: string[]; nextCursor?: string }>;
  getGroupManifest(
    actorUserId: string,
    group: HealthKitMetric,
    personId?: string
  ): Promise<HealthKitGroupManifest>;
  getHealthMetricFreshness(actorUserId: string, personId: string, healthMetric: HealthKitMetricKey): Promise<HealthMetricFreshness>;
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
  listDailyMetrics(
    actorUserId: string,
    personId: string,
    healthMetric: HealthKitMetricKey,
    rangeStartDay: string,
    rangeEndDay: string
  ): Promise<HealthDailyMetricRecord[]>;
  listHealthKitBloodPressure(
    actorUserId: string,
    personId: string,
    rangeStartUtc: string,
    rangeEndUtc: string,
    limit: number
  ): Promise<BloodPressureReading[]>;
  listHealthKitBloodGlucose(
    actorUserId: string,
    personId: string,
    rangeStartUtc: string,
    rangeEndUtc: string,
    limit: number
  ): Promise<BloodGlucoseReading[]>;
  listHealthKitWorkouts(
    actorUserId: string,
    personId: string,
    rangeStartUtc: string,
    rangeEndUtc: string,
    limit: number
  ): Promise<HealthWorkoutRecord[]>;
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
