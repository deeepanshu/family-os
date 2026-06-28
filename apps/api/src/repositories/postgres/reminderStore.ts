import type { AuditLog, NotificationDelivery, NotificationDevice, Reminder, ReminderRecipient } from "@family-os/shared";
import { HttpError } from "../../errors";
import type { CreateReminderInput, RegisterDeviceInput, UpdateReminderInput } from "../families";
import { PostgresRepositoryContext } from "./context";
import { mapAuditLog, mapDelivery, mapDevice, mapReminder, mapRecipient } from "./mappers";
import { requireRow } from "./types";

export class PostgresReminderStore {
  constructor(private readonly context: PostgresRepositoryContext) {}

  async createReminder(input: CreateReminderInput): Promise<Reminder> {
    const current = await this.context.requireActiveMember(input.actorUserId);
    await this.context.assertProfileInFamily(input.subjectPersonId, current.family.id);
    await this.context.syncAuthUsers(input.recipientUserIds);

    return this.context.sql.begin(async (tx: any) => {
      const [reminder] = await tx`
        insert into reminders
          (family_id, subject_person_id, created_by_user_id, type, title, message, schedule_kind, time_of_day, timezone, days_of_week, starts_on, ends_on, enabled)
        values (
          ${current.family.id},
          ${input.subjectPersonId ?? null},
          ${input.actorUserId},
          ${input.type},
          ${input.title},
          ${input.message},
          ${input.scheduleKind},
          ${input.timeOfDay ?? null},
          ${input.timezone},
          ${input.daysOfWeek ?? null},
          ${input.startsOn ?? null},
          ${input.endsOn ?? null},
          true
        )
        returning *
      `;
      const createdReminder = requireRow(reminder, "Failed to create reminder.");
      const recipients = await this.context.replaceRecipients(tx, current.family.id, createdReminder.id, input.recipientUserIds);
      await this.context.audit(
        {
          familyId: current.family.id,
          actorUserId: input.actorUserId,
          action: "reminder.created",
          resourceType: "reminder",
          resourceId: createdReminder.id,
          metadata: { type: input.type }
        },
        tx
      );
      return mapReminder(createdReminder, recipients);
    });
  }

  async listReminders(actorUserId: string): Promise<Reminder[]> {
    const current = await this.context.requireActiveMember(actorUserId);
    const reminders = await this.context.sql`
      select *
      from reminders
      where family_id = ${current.family.id}
        and deleted_at is null
      order by created_at asc
    `;
    return Promise.all(reminders.map(async (reminder: any) => mapReminder(reminder, await this.context.listRecipients(reminder.id))));
  }

  async getReminder(actorUserId: string, reminderId: string): Promise<Reminder> {
    const current = await this.context.requireActiveMember(actorUserId);
    const [reminder] = await this.context.sql`
      select *
      from reminders
      where id = ${reminderId}
        and family_id = ${current.family.id}
        and deleted_at is null
    `;
    if (!reminder) {
      throw new HttpError(404, "reminder_not_found", "Reminder was not found.");
    }
    return mapReminder(reminder, await this.context.listRecipients(reminderId));
  }

  async updateReminder(actorUserId: string, reminderId: string, input: UpdateReminderInput): Promise<Reminder> {
    const current = await this.context.requireActiveMember(actorUserId);
    const existing = await this.getReminder(actorUserId, reminderId);
    if (existing.createdByUserId !== actorUserId && current.membership.role !== "manager") {
      throw new HttpError(403, "reminder_owner_or_manager_required", "Only the creator or a manager can change this reminder.");
    }
    await this.context.assertProfileInFamily(input.subjectPersonId, current.family.id);
    if (input.recipientUserIds) {
      await this.context.syncAuthUsers(input.recipientUserIds);
    }

    return this.context.sql.begin(async (tx: any) => {
      const [reminder] = await tx`
        update reminders
        set
          subject_person_id = coalesce(${input.subjectPersonId ?? null}, subject_person_id),
          type = coalesce(${input.type ?? null}, type),
          title = coalesce(${input.title ?? null}, title),
          message = coalesce(${input.message ?? null}, message),
          schedule_kind = coalesce(${input.scheduleKind ?? null}, schedule_kind),
          time_of_day = coalesce(${input.timeOfDay ?? null}, time_of_day),
          timezone = coalesce(${input.timezone ?? null}, timezone),
          days_of_week = coalesce(${input.daysOfWeek ?? null}, days_of_week),
          starts_on = coalesce(${input.startsOn ?? null}, starts_on),
          ends_on = coalesce(${input.endsOn ?? null}, ends_on),
          enabled = coalesce(${input.enabled ?? null}, enabled)
        where id = ${reminderId}
        returning *
      `;
      if (!reminder) {
        throw new HttpError(404, "reminder_not_found", "Reminder was not found.");
      }
      const recipients = input.recipientUserIds
        ? await this.context.replaceRecipients(tx, current.family.id, reminderId, input.recipientUserIds)
        : await this.context.listRecipients(reminderId, tx);
      await this.context.audit(
        {
          familyId: current.family.id,
          actorUserId,
          action: "reminder.updated",
          resourceType: "reminder",
          resourceId: reminderId
        },
        tx
      );
      return mapReminder(reminder, recipients);
    });
  }

  async deleteReminder(actorUserId: string, reminderId: string): Promise<void> {
    const current = await this.context.requireActiveMember(actorUserId);
    const existing = await this.getReminder(actorUserId, reminderId);
    if (existing.createdByUserId !== actorUserId && current.membership.role !== "manager") {
      throw new HttpError(403, "reminder_owner_or_manager_required", "Only the creator or a manager can delete this reminder.");
    }
    await this.context.sql`update reminders set deleted_at = now() where id = ${reminderId}`;
    await this.context.audit({
      familyId: current.family.id,
      actorUserId,
      action: "reminder.deleted",
      resourceType: "reminder",
      resourceId: reminderId
    });
  }

  async disableReminderForSelf(actorUserId: string, reminderId: string): Promise<ReminderRecipient> {
    await this.getReminder(actorUserId, reminderId);
    const [recipient] = await this.context.sql`
      update reminder_recipients
      set enabled = false, disabled_at = now()
      where reminder_id = ${reminderId}
        and user_id = ${actorUserId}
      returning *
    `;
    if (!recipient) {
      throw new HttpError(404, "reminder_recipient_not_found", "Reminder recipient was not found.");
    }
    const reminder = await this.getReminder(actorUserId, reminderId);
    await this.context.audit({
      familyId: reminder.familyId,
      actorUserId,
      action: "reminder_recipient.disabled",
      resourceType: "reminder",
      resourceId: reminderId
    });
    return mapRecipient(recipient);
  }

  async registerDevice(input: RegisterDeviceInput): Promise<NotificationDevice> {
    await this.context.syncAuthUser(input.userId);
    const [device] = await this.context.sql`
      insert into notification_devices (user_id, device_token, platform, last_seen_at)
      values (${input.userId}, ${input.deviceToken}, 'ios', now())
      on conflict (user_id, device_token)
      do update set last_seen_at = excluded.last_seen_at
      returning *
    `;
    const savedDevice = requireRow(device, "Failed to register device.");
    const current = await this.context.getCurrentFamily(input.userId);
    if (current) {
      await this.context.audit({
        familyId: current.family.id,
        actorUserId: input.userId,
        action: "device.registered",
        resourceType: "notification_device",
        resourceId: savedDevice.id
      });
    }
    return mapDevice(savedDevice);
  }

  async deleteDevice(actorUserId: string, deviceId: string): Promise<void> {
    const [device] = await this.context.sql`
      delete from notification_devices
      where id = ${deviceId}
        and user_id = ${actorUserId}
      returning *
    `;
    if (!device) {
      throw new HttpError(404, "device_not_found", "Device was not found.");
    }
    const current = await this.context.getCurrentFamily(actorUserId);
    if (current) {
      await this.context.audit({
        familyId: current.family.id,
        actorUserId,
        action: "device.deleted",
        resourceType: "notification_device",
        resourceId: deviceId
      });
    }
  }

  async listDueReminderDeliveries(now: Date) {
    const reminders = await this.context.sql`
      select *
      from reminders
      where enabled = true
        and deleted_at is null
    `;
    const due: Array<{ reminder: Reminder; recipient: ReminderRecipient; devices: NotificationDevice[]; delivery: NotificationDelivery }> = [];
    for (const reminderRow of reminders) {
      const reminder = mapReminder(reminderRow, await this.context.listRecipients(reminderRow.id));
      if (!isReminderDue(reminder, now)) continue;
      for (const recipient of reminder.recipients.filter((candidate) => candidate.enabled)) {
        const devices = (await this.context.sql`
          select *
          from notification_devices
          where user_id = ${recipient.userId}
        `).map(mapDevice);
        const [delivery] = await this.context.sql`
          insert into notification_deliveries (reminder_id, recipient_user_id, status, scheduled_for)
          values (${reminder.id}, ${recipient.userId}, 'pending', ${now.toISOString()})
          returning *
        `;
        due.push({ reminder, recipient, devices, delivery: mapDelivery(requireRow(delivery, "Failed to create notification delivery.")) });
      }
    }
    return due;
  }

  async markDeliverySent(deliveryId: string): Promise<void> {
    const [delivery] = await this.context.sql`
      update notification_deliveries
      set status = 'sent', sent_at = now()
      where id = ${deliveryId}
      returning *
    `;
    if (delivery) {
      await this.auditDelivery(mapDelivery(delivery), "notification_delivery.sent");
    }
  }

  async markDeliveryFailed(deliveryId: string, error: string): Promise<void> {
    const [delivery] = await this.context.sql`
      update notification_deliveries
      set status = 'failed', error = ${error}
      where id = ${deliveryId}
      returning *
    `;
    if (delivery) {
      await this.auditDelivery(mapDelivery(delivery), "notification_delivery.failed", { error });
    }
  }

  async listAuditLogs(actorUserId: string, limit = 100): Promise<AuditLog[]> {
    const current = await this.context.requireManager(actorUserId, "Only family managers can view audit logs.");
    const rows = await this.context.sql`
      select *
      from audit_logs
      where family_id = ${current.family.id}
      order by created_at desc
      limit ${limit}
    `;
    return rows.map(mapAuditLog);
  }

  private async auditDelivery(delivery: NotificationDelivery, action: string, metadata?: Record<string, unknown>) {
    const [reminder] = await this.context.sql`select family_id from reminders where id = ${delivery.reminderId}`;
    if (!reminder) return;
    await this.context.audit({
      familyId: reminder.family_id,
      action,
      resourceType: "notification_delivery",
      resourceId: delivery.id,
      metadata: { recipientUserId: delivery.recipientUserId, ...metadata }
    });
  }
}

function isReminderDue(reminder: Reminder, now: Date): boolean {
  if (!reminder.timeOfDay) return false;
  const hhmm = now.toISOString().slice(11, 16);
  if (hhmm !== reminder.timeOfDay.slice(0, 5)) return false;
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

