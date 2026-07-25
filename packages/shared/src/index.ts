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

export type BootstrapResponse = {
  family: Family;
  membership: FamilyMembership;
  profiles: HealthProfile[];
  selfProfile: HealthProfile | null;
  needsProfileSetup: boolean;
};

export type FamilyRole = "manager" | "member";

export type MembershipStatus = "active" | "invited" | "removed";

export type FamilyKind = "personal" | "family";

export type Family = {
  id: string;
  name: string;
  kind: FamilyKind;
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

export type FamilyMember = {
  membership: FamilyMembership;
  email?: string;
  displayName?: string;
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
  linkedUserId?: string;
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
  source: "manual" | "healthkit";
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
  source: "manual" | "healthkit";
  createdAt: string;
  updatedAt: string;
};

/** Supported HealthKit background-sync metrics (v1). */
export type HealthKitMetric = "steps" | "sleep" | "blood_pressure";

export type HealthMetricSyncStatusCode =
  | "never_synced"
  | "ready"
  | "repairing"
  | "repair_needed"
  | "error"
  | "disabled";

export type HealthKitMetricSyncState = {
  metric: HealthKitMetric;
  enabled: boolean;
  lastSuccessfulAt?: string;
  lastAttemptAt?: string;
  lastErrorCode?: string;
  coverageStartAt?: string;
  coverageEndAt?: string;
  status: HealthMetricSyncStatusCode;
};

export type HealthKitSettings = {
  personId: string;
  consentVersion?: string;
  consentedAt?: string;
  healthTimezone: string;
  healthTimezoneVersion: number;
  enabledMetrics: HealthKitMetric[];
  activeInstallationId?: string;
  metrics: HealthKitMetricSyncState[];
};

export type PutHealthKitSettingsInput = {
  personId: string;
  consentVersion?: string;
  enabledMetrics: HealthKitMetric[];
  healthTimezone: string;
  installationId: string;
  replaceActiveInstallation?: boolean;
};

export type HealthKitStepsHourUpsert = {
  kind: "steps_hour_upsert";
  hourStartUtc: string;
  count: number;
};

export type HealthKitSleepDayUpsert = {
  kind: "sleep_day_upsert";
  sleepDay: string;
  durationMinutes: number;
};

export type HealthKitBloodPressureUpsert = {
  kind: "blood_pressure_upsert";
  sourceSampleKey: string;
  measuredAtUtc: string;
  systolic: number;
  diastolic: number;
  pulse?: number;
};

export type HealthKitBloodPressureDelete = {
  kind: "blood_pressure_delete";
  sourceSampleKey: string;
};

export type HealthKitSyncOperation =
  | HealthKitStepsHourUpsert
  | HealthKitSleepDayUpsert
  | HealthKitBloodPressureUpsert
  | HealthKitBloodPressureDelete;

export type HealthKitSyncInput = {
  syncId: string;
  installationId: string;
  personId: string;
  timezoneVersion: number;
  repairId?: string;
  chunkIndex?: number;
  operations: HealthKitSyncOperation[];
};

/** Redacted acknowledgement for an accepted sync or replayed idempotent request. */
export type HealthKitSyncResult = {
  syncId: string;
  accepted: true;
  operationCount: number;
  metricsAffected: HealthKitMetric[];
  repairId?: string;
  chunkIndex?: number;
};

export type CreateHealthKitRepairInput = {
  installationId: string;
  personId: string;
  metric: HealthKitMetric;
  timezoneVersion: number;
};

export type HealthKitRepair = {
  repairId: string;
  personId: string;
  metric: HealthKitMetric;
  installationId: string;
  timezoneVersion: number;
  /** Inclusive UTC instant bounds for steps/BP. */
  rangeStart: string;
  rangeEnd: string;
  /** Inclusive profile-local sleep days (health timezone calendar). */
  rangeStartDay: string;
  rangeEndDay: string;
  expiresAt: string;
};

export type CompleteHealthKitRepairInput = {
  expectedChunkCount: number;
};

export type HealthKitRepairCompleteResult = {
  repairId: string;
  metric: HealthKitMetric;
  completed: true;
  expectedChunkCount: number;
  completedChunkCount: number;
};

export type HealthStepHourRecord = {
  personId: string;
  hourStartUtc: string;
  count: number;
};

export type HealthSleepDayRecord = {
  personId: string;
  sleepDay: string;
  timezoneVersion: number;
  durationMinutes: number;
};

export type HealthMetricFreshness = {
  metric: HealthKitMetric;
  healthTimezone: string;
  healthTimezoneVersion: number;
  lastSuccessfulAt?: string;
  status: HealthMetricSyncStatusCode;
  coverageStartAt?: string;
  coverageEndAt?: string;
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

export type McpHealthMetric = "steps" | "sleep" | "blood_pressure";

export type McpHealthViewType =
  | "hourly_series"
  | "daily_series"
  | "daily_duration_series"
  | "daily_reading_table";

export type McpStepsGranularity = "hourly" | "daily";

export type McpCapability = "health_read";

export type McpConnectionGrant = {
  id: string;
  userId: string;
  oauthClientId: string;
  capabilities: McpCapability[];
  consentVersion: string;
  createdAt: string;
  expiresAt?: string;
  revokedAt?: string;
};

export type McpAuthorizedProfile = {
  personId: string;
  label: string;
  availableMetrics: McpHealthMetric[];
};

export type McpListAuthorizedProfilesResult = {
  profiles: McpAuthorizedProfile[];
  disclaimer: string;
};

export type McpGetHealthDataInput = {
  personId: string;
  healthMetric: McpHealthMetric;
  rangeDays: number;
  granularity?: McpStepsGranularity;
  timezone?: string;
};

export type McpCoverage = {
  requestedRangeDays: number;
  rangeStart: string;
  rangeEnd: string;
  daysWithData: number;
  /** True when stored coverage fully covers the requested range and the metric is not mid-repair. */
  complete: boolean;
  availableStart?: string;
  availableEnd?: string;
};

export type McpSeriesPoint = {
  bucket: string;
  value: number;
};

export type McpBloodPressureReadingRow = {
  localDate: string;
  localTime: string;
  systolic: number;
  diastolic: number;
  pulse?: number;
};

export type McpHealthDataBase = {
  personId: string;
  healthMetric: McpHealthMetric;
  viewType: McpHealthViewType;
  unit: string;
  /** Profile health timezone used for sleep-day grouping and calendar presentation. */
  healthTimezone: string;
  /** Request timezone used only for local presentation of instants (e.g. BP table). */
  timezone: string;
  coverage: McpCoverage;
  lastSyncedAt?: string;
  /** Redacted per-metric sync status (never implies device online / permission). */
  metricSyncStatus: HealthMetricSyncStatusCode;
  disclaimer: string;
};

export type McpHourlySeriesResult = McpHealthDataBase & {
  viewType: "hourly_series";
  healthMetric: "steps";
  points: McpSeriesPoint[];
};

export type McpDailySeriesResult = McpHealthDataBase & {
  viewType: "daily_series";
  healthMetric: "steps";
  points: McpSeriesPoint[];
};

export type McpDailyDurationSeriesResult = McpHealthDataBase & {
  viewType: "daily_duration_series";
  healthMetric: "sleep";
  points: McpSeriesPoint[];
};

export type McpDailyReadingTableResult = McpHealthDataBase & {
  viewType: "daily_reading_table";
  healthMetric: "blood_pressure";
  readings: McpBloodPressureReadingRow[];
  truncated: boolean;
};

export type McpGetHealthDataResult =
  | McpHourlySeriesResult
  | McpDailySeriesResult
  | McpDailyDurationSeriesResult
  | McpDailyReadingTableResult;

export const MCP_HEALTH_DISCLAIMER =
  "Informational only. Not medical advice. Coverage and freshness metadata describe the stored Family OS data and may be incomplete or delayed." as const;

export const MCP_RELEASE1_METRICS: readonly McpHealthMetric[] = ["steps", "sleep", "blood_pressure"] as const;
