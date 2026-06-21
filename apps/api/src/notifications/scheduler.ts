import type { FamilyRepository } from "../repositories/families";

export type PushPayload = {
  token: string;
  title: string;
  body: string;
  data: Record<string, string>;
};

export interface PushSender {
  send(payload: PushPayload): Promise<void>;
}

export async function sendDueReminderPushes(repository: FamilyRepository, sender: PushSender, now = new Date()) {
  const due = await repository.listDueReminderDeliveries(now);
  for (const item of due) {
    try {
      for (const device of item.devices) {
        await sender.send({
          token: device.deviceToken,
          title: item.reminder.title,
          body: item.reminder.message,
          data: {
            reminder_id: item.reminder.id,
            action: item.reminder.type === "blood_glucose" ? "open_add_blood_glucose" : item.reminder.type === "blood_pressure" ? "open_add_blood_pressure" : "open_reminder",
            subject_person_id: item.reminder.subjectPersonId ?? ""
          }
        });
      }
      await repository.markDeliverySent(item.delivery.id);
    } catch (error) {
      await repository.markDeliveryFailed(item.delivery.id, error instanceof Error ? error.message : "Push failed");
    }
  }
  return due.length;
}
