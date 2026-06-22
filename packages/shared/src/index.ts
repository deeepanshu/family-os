export const HEALTH_API_PREFIX = "/health/v1" as const;

export type ApiEnvelope<T> = {
  data: T;
};

export type ApiErrorEnvelope = {
  error: {
    code: string;
    message: string;
  };
};

export type HealthcheckResponse = {
  service: "family-os-health-api";
  status: "ok";
};

export type AuthSessionResponse = {
  userId: string;
};

export type FamilyRole = "manager" | "member";

export type MembershipStatus = "active" | "invited" | "removed";

export type Family = {
  id: string;
  name: string;
  createdByUserId: string;
  createdAt: string;
  updatedAt: string;
};

export type FamilyMembership = {
  id: string;
  familyId: string;
  userId: string;
  role: FamilyRole;
  status: MembershipStatus;
  createdAt: string;
  updatedAt: string;
};

export type CurrentFamilyResponse = {
  family: Family;
  membership: FamilyMembership;
} | null;

export type FamilyInviteStatus = "pending" | "accepted" | "revoked" | "expired";

export type FamilyInvite = {
  id: string;
  familyId: string;
  email?: string;
  role: FamilyRole;
  status: FamilyInviteStatus;
  expiresAt: string;
  createdAt: string;
};

export type CreateInviteResponse = {
  invite: FamilyInvite;
  token: string;
};

export type PublicInviteResponse = {
  familyName: string;
  role: FamilyRole;
  status: FamilyInviteStatus;
  expiresAt: string;
};

export type PersonStatus = "active" | "inactive";

export type HealthProfile = {
  id: string;
  familyId: string;
  displayName: string;
  relationshipLabel?: string;
  dateOfBirth?: string;
  status: PersonStatus;
  createdAt: string;
  updatedAt: string;
};

export type BloodPressureReading = {
  id: string;
  familyId: string;
  personId: string;
  recordedByUserId: string;
  systolic: number;
  diastolic: number;
  pulse?: number;
  measuredAt: string;
  context?: string;
  notes?: string;
  createdAt: string;
  updatedAt: string;
};

export type GlucoseContext = "fasting" | "before_meal" | "after_meal" | "bedtime" | "random";

export type BloodGlucoseReading = {
  id: string;
  familyId: string;
  personId: string;
  recordedByUserId: string;
  value: number;
  unit: "mg/dL";
  context: GlucoseContext;
  measuredAt: string;
  notes?: string;
  createdAt: string;
  updatedAt: string;
};

export type ReminderType = "generic" | "blood_glucose" | "blood_pressure";
export type ReminderScheduleKind = "once" | "daily" | "weekly" | "custom_days";

export type ReminderRecipient = {
  id: string;
  reminderId: string;
  userId: string;
  enabled: boolean;
  disabledAt?: string;
  createdAt: string;
};

export type Reminder = {
  id: string;
  familyId: string;
  subjectPersonId?: string;
  createdByUserId: string;
  type: ReminderType;
  title: string;
  message: string;
  scheduleKind: ReminderScheduleKind;
  timeOfDay?: string;
  timezone: string;
  daysOfWeek?: number[];
  startsOn?: string;
  endsOn?: string;
  enabled: boolean;
  recipients: ReminderRecipient[];
  createdAt: string;
  updatedAt: string;
};

export type NotificationDevice = {
  id: string;
  userId: string;
  deviceToken: string;
  platform: "ios";
  createdAt: string;
  lastSeenAt: string;
};

export type NotificationDelivery = {
  id: string;
  reminderId: string;
  recipientUserId: string;
  status: "pending" | "sent" | "failed" | "opened";
  scheduledFor: string;
  sentAt?: string;
  openedAt?: string;
  error?: string;
  createdAt: string;
};

export type AuditLog = {
  id: string;
  familyId: string;
  actorUserId?: string;
  action: string;
  resourceType: string;
  resourceId: string;
  metadata?: Record<string, unknown>;
  createdAt: string;
};
