import type {
  AuditLog,
  BloodGlucoseReading,
  BloodPressureReading,
  CurrentFamilyResponse,
  Family,
  FamilyInvite,
  FamilyMembership,
  HealthProfile,
  HealthMetricDailySummary,
  NotificationDelivery,
  NotificationDevice,
  Reminder,
  ReminderRecipient
} from "@family-os/shared";
import { toDateString, toIso, toOptionalIso } from "./dateUtils";
import type { Row } from "./types";

export function mapCurrentFamily(row: Row): CurrentFamilyResponse {
  return {
    family: {
      id: row.family_id,
      name: row.family_name,
      kind: row.family_kind ?? "family",
      createdByUserId: row.created_by_user_id,
      createdAt: toIso(row.family_created_at),
      updatedAt: toIso(row.family_updated_at)
    },
    membership: {
      id: row.membership_id,
      familyId: row.family_id,
      userId: row.user_id,
      role: row.role,
      status: row.status,
      createdAt: toIso(row.membership_created_at),
      updatedAt: toIso(row.membership_updated_at)
    }
  };
}

export function mapFamily(row: Row): Family {
  return {
    id: row.id,
    name: row.name,
    kind: row.kind ?? "family",
    createdByUserId: row.created_by_user_id,
    createdAt: toIso(row.created_at),
    updatedAt: toIso(row.updated_at)
  };
}

export function mapMembership(row: Row): FamilyMembership {
  return {
    id: row.id,
    familyId: row.family_id,
    userId: row.user_id,
    role: row.role,
    status: row.status,
    createdAt: toIso(row.created_at),
    updatedAt: toIso(row.updated_at)
  };
}

export function mapInvite(row: Row): FamilyInvite {
  return {
    id: row.id,
    familyId: row.family_id,
    email: row.email ?? undefined,
    role: row.role,
    status: row.status,
    expiresAt: toIso(row.expires_at),
    createdAt: toIso(row.created_at)
  };
}

export function mapProfile(row: Row): HealthProfile {
  return {
    id: row.id,
    familyId: row.family_id,
    linkedUserId: row.linked_user_id ?? undefined,
    displayName: row.display_name,
    relationshipLabel: row.relationship_label ?? undefined,
    dateOfBirth: toDateString(row.date_of_birth),
    status: row.status,
    createdAt: toIso(row.created_at),
    updatedAt: toIso(row.updated_at)
  };
}

export function mapBloodPressure(row: Row): BloodPressureReading {
  return {
    id: row.id,
    familyId: row.family_id,
    personId: row.person_id,
    recordedByUserId: row.recorded_by_user_id,
    systolic: row.systolic,
    diastolic: row.diastolic,
    pulse: row.pulse ?? undefined,
    measuredAt: toIso(row.measured_at),
    context: row.context ?? undefined,
    notes: row.notes ?? undefined,
    source: row.source ?? "manual",
    createdAt: toIso(row.created_at),
    updatedAt: toIso(row.updated_at)
  };
}

export function mapBloodGlucose(row: Row): BloodGlucoseReading {
  return {
    id: row.id,
    familyId: row.family_id,
    personId: row.person_id,
    recordedByUserId: row.recorded_by_user_id,
    value: Number(row.value),
    unit: "mg/dL",
    context: row.context,
    measuredAt: toIso(row.measured_at),
    notes: row.notes ?? undefined,
    source: row.source ?? "manual",
    createdAt: toIso(row.created_at),
    updatedAt: toIso(row.updated_at)
  };
}

export function mapHealthMetricDailySummary(row: Row): HealthMetricDailySummary {
  return {
    id: row.id,
    familyId: row.family_id,
    personId: row.person_id,
    metricType: row.metric_type,
    date: toDateString(row.date)!,
    value: Number(row.value),
    unit: row.unit,
    source: "healthkit",
    sampleCount: row.sample_count,
    updatedAt: toIso(row.updated_at)
  };
}

export function mapReminder(row: Row, recipients: ReminderRecipient[]): Reminder {
  return {
    id: row.id,
    familyId: row.family_id,
    subjectPersonId: row.subject_person_id ?? undefined,
    createdByUserId: row.created_by_user_id,
    type: row.type,
    title: row.title,
    message: row.message,
    scheduleKind: row.schedule_kind,
    timeOfDay: row.time_of_day ?? undefined,
    timezone: row.timezone,
    daysOfWeek: row.days_of_week ?? undefined,
    startsOn: toDateString(row.starts_on),
    endsOn: toDateString(row.ends_on),
    enabled: row.enabled,
    recipients,
    createdAt: toIso(row.created_at),
    updatedAt: toIso(row.updated_at)
  };
}

export function mapRecipient(row: Row): ReminderRecipient {
  return {
    id: row.id,
    reminderId: row.reminder_id,
    userId: row.user_id,
    enabled: row.enabled,
    disabledAt: toOptionalIso(row.disabled_at),
    createdAt: toIso(row.created_at)
  };
}

export function mapDevice(row: Row): NotificationDevice {
  return {
    id: row.id,
    userId: row.user_id,
    deviceToken: row.device_token,
    platform: "ios",
    createdAt: toIso(row.created_at),
    lastSeenAt: toIso(row.last_seen_at)
  };
}

export function mapDelivery(row: Row): NotificationDelivery {
  return {
    id: row.id,
    reminderId: row.reminder_id,
    recipientUserId: row.recipient_user_id,
    status: row.status,
    scheduledFor: toIso(row.scheduled_for),
    sentAt: toOptionalIso(row.sent_at),
    openedAt: toOptionalIso(row.opened_at),
    error: row.error ?? undefined,
    createdAt: toIso(row.created_at)
  };
}

export function mapAuditLog(row: Row): AuditLog {
  return {
    id: row.id,
    familyId: row.family_id,
    actorUserId: row.actor_user_id ?? undefined,
    action: row.action,
    resourceType: row.resource_type,
    resourceId: row.resource_id,
    metadata: row.metadata ?? undefined,
    createdAt: toIso(row.created_at)
  };
}
