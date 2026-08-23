import postgres from "postgres";
import type {
  AuditLog,
  BeginHealthKitRunInput,
  BloodGlucoseReading,
  BloodPressureReading,
  BootstrapResponse,
  CompleteHealthKitRunInput,
  FailHealthKitRunInput,
  AcceptInviteInput,
  CreatedInvite,
  CurrentFamilyResponse,
  FamilyMember,
  FamilyMembership,
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
  HealthKitRunFailResult,
  HealthKitSettings,
  HealthMetricFreshness,
  HealthProfile,
  HealthSleepDayRecord,
  HealthStepHourRecord,
  HealthWorkoutExerciseLog,
  HealthWorkoutExerciseWrite,
  HealthWorkoutRecord,

  MarkHealthKitGroupReadyInput,
  NotificationDelivery,
  NotificationDevice,
  PublicInviteResponse,
  PutHealthKitSettingsInput,
  Reminder,
  ReminderRecipient,
  StartHealthKitImportInput
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

  leaveFamily(actorUserId: string): Promise<void> {
    return this.familyStore.leaveFamily(actorUserId);
  }

  removeMember(actorUserId: string, memberUserId: string): Promise<void> {
    return this.familyStore.removeMember(actorUserId, memberUserId);
  }

  deleteFamily(actorUserId: string): Promise<void> {
    return this.familyStore.deleteFamily(actorUserId);
  }

  createInvite(input: CreateInviteInput): Promise<CreatedInvite> {
    return this.familyStore.createInvite(input);
  }

  getInviteByToken(token: string): Promise<PublicInviteResponse> {
    return this.familyStore.getInviteByToken(token);
  }

  acceptInvite(token: string, userId: string, input: AcceptInviteInput): Promise<CurrentFamilyResponse> {
    return this.familyStore.acceptInvite(token, userId, input);
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

  deleteAccount(actorUserId: string): Promise<void> {
    return this.familyStore.deleteAccount(actorUserId);
  }

  isAccountDeleted(userId: string): Promise<boolean> {
    return this.familyStore.isAccountDeleted(userId);
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

  applyHealthKitOps(actorUserId: string, input: HealthKitOpsBatchInput): Promise<HealthKitOpsBatchResult> {
    return this.healthKitStore.applyHealthKitOps(actorUserId, input);
  }

  beginHealthKitRun(
    actorUserId: string,
    group: HealthKitConsentGroup,
    input: BeginHealthKitRunInput
  ): Promise<HealthKitRunBeginResult> {
    return this.healthKitStore.beginHealthKitRun(actorUserId, group, input);
  }

  completeHealthKitRun(
    actorUserId: string,
    group: HealthKitConsentGroup,
    input: CompleteHealthKitRunInput
  ): Promise<HealthKitRunCompleteResult> {
    return this.healthKitStore.completeHealthKitRun(actorUserId, group, input);
  }

  failHealthKitRun(
    actorUserId: string,
    group: HealthKitConsentGroup,
    input: FailHealthKitRunInput
  ): Promise<HealthKitRunFailResult> {
    return this.healthKitStore.failHealthKitRun(actorUserId, group, input);
  }

  startHealthKitImport(
    actorUserId: string,
    group: HealthKitConsentGroup,
    input: StartHealthKitImportInput
  ): Promise<HealthKitGroupImportStartResult> {
    return this.healthKitStore.startHealthKitImport(actorUserId, group, input);
  }

  markHealthKitGroupReady(
    actorUserId: string,
    group: HealthKitConsentGroup,
    input: MarkHealthKitGroupReadyInput
  ): Promise<HealthKitGroupReadyResult> {
    return this.healthKitStore.markHealthKitGroupReady(actorUserId, group, input);
  }

  getHealthKitGroupStatus(
    actorUserId: string,
    group: HealthKitConsentGroup,
    personId?: string
  ): Promise<HealthKitGroupStatus> {
    return this.healthKitStore.getHealthKitGroupStatus(actorUserId, group, personId);
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

  putHealthKitWorkoutExercises(
    actorUserId: string,
    workoutId: string,
    exercises: HealthWorkoutExerciseWrite[]
  ): Promise<HealthWorkoutRecord> {
    return this.healthKitStore.putHealthKitWorkoutExercises(actorUserId, workoutId, exercises);
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

  purgeExpiredAuditLogs(now?: Date): Promise<number> {
    return this.reminderStore.purgeExpiredAuditLogs(now);
  }
}
