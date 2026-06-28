import postgres from "postgres";
import type {
  AuditLog,
  BloodGlucoseReading,
  BloodPressureReading,
  CreateInviteResponse,
  CurrentFamilyResponse,
  HealthProfile,
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
  FamilyRepository,
  RegisterDeviceInput,
  UpdateBloodGlucoseInput,
  UpdateBloodPressureInput,
  UpdateProfileInput,
  UpdateReminderInput
} from "../families";
import { PostgresRepositoryContext } from "./context";
import { PostgresFamilyStore } from "./familyStore";
import { PostgresReadingStore } from "./readingStore";
import { PostgresReminderStore } from "./reminderStore";
import type { PostgresRepositoryOptions } from "./types";

export class PostgresFamilyRepository implements FamilyRepository {
  private readonly familyStore: PostgresFamilyStore;
  private readonly readingStore: PostgresReadingStore;
  private readonly reminderStore: PostgresReminderStore;

  constructor(context: PostgresRepositoryContext) {
    this.familyStore = new PostgresFamilyStore(context);
    this.readingStore = new PostgresReadingStore(context);
    this.reminderStore = new PostgresReminderStore(context);
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

  updateProfile(actorUserId: string, profileId: string, input: UpdateProfileInput): Promise<HealthProfile> {
    return this.familyStore.updateProfile(actorUserId, profileId, input);
  }

  deleteProfile(actorUserId: string, profileId: string): Promise<void> {
    return this.familyStore.deleteProfile(actorUserId, profileId);
  }

  createBloodPressure(input: CreateBloodPressureInput): Promise<BloodPressureReading> {
    return this.readingStore.createBloodPressure(input);
  }

  listBloodPressure(actorUserId: string, personId?: string, limit?: number): Promise<BloodPressureReading[]> {
    return this.readingStore.listBloodPressure(actorUserId, personId, limit);
  }

  getBloodPressure(actorUserId: string, readingId: string): Promise<BloodPressureReading> {
    return this.readingStore.getBloodPressure(actorUserId, readingId);
  }

  updateBloodPressure(actorUserId: string, readingId: string, input: UpdateBloodPressureInput): Promise<BloodPressureReading> {
    return this.readingStore.updateBloodPressure(actorUserId, readingId, input);
  }

  deleteBloodPressure(actorUserId: string, readingId: string): Promise<void> {
    return this.readingStore.deleteBloodPressure(actorUserId, readingId);
  }

  createBloodGlucose(input: CreateBloodGlucoseInput): Promise<BloodGlucoseReading> {
    return this.readingStore.createBloodGlucose(input);
  }

  listBloodGlucose(actorUserId: string, personId?: string, limit?: number): Promise<BloodGlucoseReading[]> {
    return this.readingStore.listBloodGlucose(actorUserId, personId, limit);
  }

  getBloodGlucose(actorUserId: string, readingId: string): Promise<BloodGlucoseReading> {
    return this.readingStore.getBloodGlucose(actorUserId, readingId);
  }

  updateBloodGlucose(actorUserId: string, readingId: string, input: UpdateBloodGlucoseInput): Promise<BloodGlucoseReading> {
    return this.readingStore.updateBloodGlucose(actorUserId, readingId, input);
  }

  deleteBloodGlucose(actorUserId: string, readingId: string): Promise<void> {
    return this.readingStore.deleteBloodGlucose(actorUserId, readingId);
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

