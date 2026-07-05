import type {
  AuditLog,
  BloodGlucoseReading,
  BloodPressureReading,
  BootstrapResponse,
  CreateInviteResponse,
  CurrentFamilyResponse,
  FamilyMember,
  FamilyMembership,
  HealthProfile,
  HealthKitImportResult,
  HealthKitMetricType,
  HealthKitSampleInput,
  HealthKitSyncStatus,
  HealthMetricDailySummary,
  NotificationDelivery,
  NotificationDevice,
  PublicInviteResponse,
  Reminder,
  ReminderRecipient
} from "@family-os/shared";
import type {
  CreateBloodGlucoseInput,
  CreateBloodPressureInput,
  CreateFamilyInput,
  CreateInviteInput,
  CreateProfileInput,
  CreateReminderInput,
  RegisterDeviceInput,
  UpdateBloodGlucoseInput,
  UpdateBloodPressureInput,
  UpdateProfileInput,
  UpdateReminderInput
} from "./families";

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

export interface HealthKitStore {
  getHealthKitSyncStatus(actorUserId: string): Promise<HealthKitSyncStatus>;
  linkHealthKitProfile(actorUserId: string, personId: string): Promise<HealthKitSyncStatus>;
  updateHealthKitSyncSettings(actorUserId: string, enabledMetrics: HealthKitMetricType[]): Promise<HealthKitSyncStatus>;
  importHealthKitSamples(actorUserId: string, samples: HealthKitSampleInput[]): Promise<HealthKitImportResult>;
  listHealthMetricDailySummaries(actorUserId: string, personId?: string, metricType?: HealthKitMetricType, limit?: number): Promise<HealthMetricDailySummary[]>;
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
};
