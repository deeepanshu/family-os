import postgres from "postgres";
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
  FamilyRepository,
  RegisterDeviceInput,
  UpdateProfileInput,
  UpdateReminderInput
} from "../families";
import type { CreateMcpConnectionInput, RecordAuditInput } from "../contracts";
import type { McpConnectionGrant } from "@family-os/shared";
import { PostgresRepositoryContext } from "./context";
import { PostgresFamilyStore } from "./familyStore";
import { PostgresHealthKitStore } from "./healthKitStore";
import { PostgresMcpConnectionStore } from "./mcpConnectionStore";
import { PostgresReadingStore } from "./readingStore";
import { PostgresReminderStore } from "./reminderStore";
import type { PostgresRepositoryOptions } from "./types";

export class PostgresFamilyRepository implements FamilyRepository {
  private readonly familyStore: PostgresFamilyStore;
  private readonly healthKitStore: PostgresHealthKitStore;
  private readonly readingStore: PostgresReadingStore;
  private readonly reminderStore: PostgresReminderStore;
  private readonly mcpConnectionStore: PostgresMcpConnectionStore;

  constructor(context: PostgresRepositoryContext) {
    this.familyStore = new PostgresFamilyStore(context);
    this.healthKitStore = new PostgresHealthKitStore(context);
    this.readingStore = new PostgresReadingStore(context);
    this.reminderStore = new PostgresReminderStore(context);
    this.mcpConnectionStore = new PostgresMcpConnectionStore(context);
  }

  static fromDatabaseUrl(databaseUrl: string, options: PostgresRepositoryOptions = {}) {
    const sql = postgres(databaseUrl, {
      max: 10,
      prepare: false,
      idle_timeout: 20,
      connect_timeout: 10
    });
    return new PostgresFamilyRepository(new PostgresRepositoryContext(sql, options));
  }

  createFamily(input: CreateFamilyInput): Promise<CurrentFamilyResponse> {
    return this.familyStore.createFamily(input);
  }

  getCurrentFamily(userId: string): Promise<CurrentFamilyResponse> {
    return this.familyStore.getCurrentFamily(userId);
  }

  bootstrap(userId: string): Promise<BootstrapResponse> {
    return this.familyStore.bootstrap(userId);
  }

  listMembers(actorUserId: string): Promise<FamilyMember[]> {
    return this.familyStore.listMembers(actorUserId);
  }

  createInvite(input: CreateInviteInput): Promise<CreateInviteResponse> {
    return this.familyStore.createInvite(input);
  }

  getInviteByToken(token: string): Promise<PublicInviteResponse> {
    return this.familyStore.getInviteByToken(token);
  }

  acceptInvite(token: string, userId: string, userEmail?: string): Promise<CurrentFamilyResponse> {
    return this.familyStore.acceptInvite(token, userId, userEmail);
  }

  listProfiles(actorUserId: string): Promise<HealthProfile[]> {
    return this.familyStore.listProfiles(actorUserId);
  }

  getProfile(actorUserId: string, profileId: string): Promise<HealthProfile> {
    return this.familyStore.getProfile(actorUserId, profileId);
  }

  createProfile(input: CreateProfileInput): Promise<HealthProfile> {
    return this.familyStore.createProfile(input);
  }

  createSelfProfile(actorUserId: string, displayName: string): Promise<HealthProfile> {
    return this.familyStore.createSelfProfile(actorUserId, displayName);
  }

  getSelfProfile(actorUserId: string): Promise<HealthProfile | null> {
    return this.familyStore.getSelfProfile(actorUserId);
  }

  updateProfile(actorUserId: string, profileId: string, input: UpdateProfileInput): Promise<HealthProfile> {
    return this.familyStore.updateProfile(actorUserId, profileId, input);
  }

  deleteProfile(actorUserId: string, profileId: string): Promise<void> {
    return this.familyStore.deleteProfile(actorUserId, profileId);
  }

  listBloodPressure(actorUserId: string, personId?: string, limit?: number): Promise<BloodPressureReading[]> {
    return this.readingStore.listBloodPressure(actorUserId, personId, limit);
  }

  getBloodPressure(actorUserId: string, readingId: string): Promise<BloodPressureReading> {
    return this.readingStore.getBloodPressure(actorUserId, readingId);
  }

  getHealthKitSettings(actorUserId: string, personId?: string): Promise<HealthKitSettings> {
    return this.healthKitStore.getHealthKitSettings(actorUserId, personId);
  }

  putHealthKitSettings(actorUserId: string, input: PutHealthKitSettingsInput): Promise<HealthKitSettings> {
    return this.healthKitStore.putHealthKitSettings(actorUserId, input);
  }

  applyHealthKitEvents(actorUserId: string, input: HealthKitEventsBatchInput): Promise<HealthKitEventsBatchResult> {
    return this.healthKitStore.applyHealthKitEvents(actorUserId, input);
  }

  createBackfillSession(
    actorUserId: string,
    input: CreateHealthKitBackfillSessionInput
  ): Promise<HealthKitBackfillSession> {
    return this.healthKitStore.createBackfillSession(actorUserId, input);
  }

  putScopeManifest(
    actorUserId: string,
    sessionId: string,
    scopeKey: string,
    input: PutHealthKitScopeManifestInput
  ): Promise<HealthKitScopeManifestResult> {
    return this.healthKitStore.putScopeManifest(actorUserId, sessionId, scopeKey, input);
  }

  completeBackfillSession(
    actorUserId: string,
    sessionId: string,
    input: CompleteHealthKitBackfillSessionInput
  ): Promise<HealthKitBackfillSessionCompleteResult> {
    return this.healthKitStore.completeBackfillSession(actorUserId, sessionId, input);
  }

  abortBackfillSession(
    actorUserId: string,
    sessionId: string,
    input: AbortHealthKitBackfillSessionInput
  ): Promise<HealthKitBackfillSessionAbortResult> {
    return this.healthKitStore.abortBackfillSession(actorUserId, sessionId, input);
  }

  getBackfillSession(actorUserId: string, sessionId: string): Promise<HealthKitBackfillSession> {
    return this.healthKitStore.getBackfillSession(actorUserId, sessionId);
  }

  listBackfillPending(
    actorUserId: string,
    sessionId: string,
    cursor?: string,
    limit?: number
  ): Promise<{ eventIds: string[]; nextCursor?: string }> {
    return this.healthKitStore.listBackfillPending(actorUserId, sessionId, cursor, limit);
  }

  getGroupManifest(
    actorUserId: string,
    group: HealthKitMetric,
    personId?: string
  ): Promise<HealthKitGroupManifest> {
    return this.healthKitStore.getGroupManifest(actorUserId, group, personId);
  }

  getHealthMetricFreshness(actorUserId: string, personId: string, healthMetric: HealthKitMetricKey): Promise<HealthMetricFreshness> {
    return this.healthKitStore.getHealthMetricFreshness(actorUserId, personId, healthMetric);
  }

  listStepHours(
    actorUserId: string,
    personId: string,
    rangeStartUtc: string,
    rangeEndUtc: string
  ): Promise<HealthStepHourRecord[]> {
    return this.healthKitStore.listStepHours(actorUserId, personId, rangeStartUtc, rangeEndUtc);
  }

  listSleepDays(
    actorUserId: string,
    personId: string,
    rangeStartDay: string,
    rangeEndDay: string
  ): Promise<HealthSleepDayRecord[]> {
    return this.healthKitStore.listSleepDays(actorUserId, personId, rangeStartDay, rangeEndDay);
  }

  listDailyMetrics(
    actorUserId: string,
    personId: string,
    healthMetric: HealthKitMetricKey,
    rangeStartDay: string,
    rangeEndDay: string
  ): Promise<HealthDailyMetricRecord[]> {
    return this.healthKitStore.listDailyMetrics(actorUserId, personId, healthMetric, rangeStartDay, rangeEndDay);
  }

  listHealthKitBloodPressure(
    actorUserId: string,
    personId: string,
    rangeStartUtc: string,
    rangeEndUtc: string,
    limit: number
  ): Promise<BloodPressureReading[]> {
    return this.healthKitStore.listHealthKitBloodPressure(actorUserId, personId, rangeStartUtc, rangeEndUtc, limit);
  }

  listHealthKitBloodGlucose(
    actorUserId: string,
    personId: string,
    rangeStartUtc: string,
    rangeEndUtc: string,
    limit: number
  ): Promise<BloodGlucoseReading[]> {
    return this.healthKitStore.listHealthKitBloodGlucose(actorUserId, personId, rangeStartUtc, rangeEndUtc, limit);
  }

  listHealthKitWorkouts(
    actorUserId: string,
    personId: string,
    rangeStartUtc: string,
    rangeEndUtc: string,
    limit: number
  ): Promise<HealthWorkoutRecord[]> {
    return this.healthKitStore.listHealthKitWorkouts(actorUserId, personId, rangeStartUtc, rangeEndUtc, limit);
  }

  createConnection(input: CreateMcpConnectionInput): Promise<McpConnectionGrant> {
    return this.mcpConnectionStore.createConnection(input);
  }

  getActiveConnection(userId: string, oauthClientId: string): Promise<McpConnectionGrant | null> {
    return this.mcpConnectionStore.getActiveConnection(userId, oauthClientId);
  }

  revokeConnection(userId: string, connectionId: string): Promise<McpConnectionGrant> {
    return this.mcpConnectionStore.revokeConnection(userId, connectionId);
  }

  listConnections(userId: string): Promise<McpConnectionGrant[]> {
    return this.mcpConnectionStore.listConnections(userId);
  }

  recordAudit(input: RecordAuditInput): Promise<void> {
    return this.reminderStore.recordAudit(input);
  }

  createReminder(input: CreateReminderInput): Promise<Reminder> {
    return this.reminderStore.createReminder(input);
  }

  listReminders(actorUserId: string): Promise<Reminder[]> {
    return this.reminderStore.listReminders(actorUserId);
  }

  getReminder(actorUserId: string, reminderId: string): Promise<Reminder> {
    return this.reminderStore.getReminder(actorUserId, reminderId);
  }

  updateReminder(actorUserId: string, reminderId: string, input: UpdateReminderInput): Promise<Reminder> {
    return this.reminderStore.updateReminder(actorUserId, reminderId, input);
  }

  deleteReminder(actorUserId: string, reminderId: string): Promise<void> {
    return this.reminderStore.deleteReminder(actorUserId, reminderId);
  }

  disableReminderForSelf(actorUserId: string, reminderId: string): Promise<ReminderRecipient> {
    return this.reminderStore.disableReminderForSelf(actorUserId, reminderId);
  }

  registerDevice(input: RegisterDeviceInput): Promise<NotificationDevice> {
    return this.reminderStore.registerDevice(input);
  }

  deleteDevice(actorUserId: string, deviceId: string): Promise<void> {
    return this.reminderStore.deleteDevice(actorUserId, deviceId);
  }

  listDueReminderDeliveries(now: Date): Promise<Array<{ reminder: Reminder; recipient: ReminderRecipient; devices: NotificationDevice[]; delivery: NotificationDelivery }>> {
    return this.reminderStore.listDueReminderDeliveries(now);
  }

  markDeliverySent(deliveryId: string): Promise<void> {
    return this.reminderStore.markDeliverySent(deliveryId);
  }

  markDeliveryFailed(deliveryId: string, error: string): Promise<void> {
    return this.reminderStore.markDeliveryFailed(deliveryId, error);
  }

  listAuditLogs(actorUserId: string, limit?: number): Promise<AuditLog[]> {
    return this.reminderStore.listAuditLogs(actorUserId, limit);
  }
}
