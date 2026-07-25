import { HEALTHKIT_METRIC_KEYS, type HealthKitConsentGroup, type HealthKitMetricKey } from "./healthkitRegistry";

/** Canonical public prefix for the Family OS health API. */
export const HEALTH_API_PREFIX = "/health/api/v1" as const;

export * from "./healthkitRegistry";

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
  source: "healthkit";
  createdAt: string;
  updatedAt: string;
};

export type BloodGlucoseReading = {
  id: string;
  familyId: string;
  personId: string;
  recordedByUserId: string;
  value: number;
  unit: "mg/dL";
  /** HealthKit does not attach a meal context to glucose samples. */
  context?: undefined;
  measuredAt: string;
  notes?: string;
  source: "healthkit";
  createdAt: string;
  updatedAt: string;
};

/** A sync/repair unit. Individual metrics are expanded from this consent group. */
export type HealthKitMetric = HealthKitConsentGroup;

export type HealthMetricSyncStatusCode =
  | "never_synced"
  | "ready"
  | "repairing"
  | "repair_needed"
  | "error"
  | "disabled";

export type HealthKitMetricSyncState = {
  group: HealthKitConsentGroup;
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
  enabledGroups: HealthKitConsentGroup[];
  activeInstallationId?: string;
  groups: HealthKitMetricSyncState[];
};

export type PutHealthKitSettingsInput = {
  personId: string;
  consentVersion?: string;
  enabledGroups: HealthKitConsentGroup[];
  healthTimezone: string;
  installationId: string;
  replaceActiveInstallation?: boolean;
};

export type HealthKitStepsHourUpsert = {
  kind: "steps_hour_upsert";
  hourStartUtc: string;
  count: number;
};

export type HealthKitStepsHourDelete = {
  kind: "steps_hour_delete";
  hourStartUtc: string;
};

export type HealthKitSleepDayUpsert = {
  kind: "sleep_day_upsert";
  sleepDay: string;
  totalMinutes: number;
  coreMinutes: number;
  deepMinutes: number;
  remMinutes: number;
  unspecifiedAsleepMinutes: number;
  awakeMinutes: number;
  inBedMinutes: number;
  wristTemperatureCelsius?: number;
  breathingDisturbanceCount?: number;
};

export type HealthKitSleepDayDelete = {
  kind: "sleep_day_delete";
  sleepDay: string;
};

export type HealthKitDailyMetricUpsert = {
  kind: "daily_metric_upsert";
  healthMetric: HealthKitMetricKey;
  localDay: string;
  sumValue?: number;
  averageValue?: number;
  minimumValue?: number;
  maximumValue?: number;
  latestValue?: number;
  sampleCount: number;
};

export type HealthKitDailyMetricDelete = {
  kind: "daily_metric_delete";
  healthMetric: HealthKitMetricKey;
  localDay: string;
};

/** A calendar-day aggregate for a registry metric stored in health_daily_metrics. */
export type HealthDailyMetricRecord = {
  personId: string;
  healthMetric: HealthKitMetricKey;
  localDay: string;
  timezoneVersion: number;
  unit: string;
  sumValue?: number;
  averageValue?: number;
  minimumValue?: number;
  maximumValue?: number;
  latestValue?: number;
  sampleCount: number;
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

export type HealthKitBloodGlucoseUpsert = {
  kind: "blood_glucose_upsert";
  sourceSampleKey: string;
  measuredAtUtc: string;
  valueMgDl: number;
};

export type HealthKitBloodGlucoseDelete = {
  kind: "blood_glucose_delete";
  sourceSampleKey: string;
};

export type HealthKitWorkoutUpsert = {
  kind: "workout_upsert";
  sourceSampleKey: string;
  workoutType: string;
  startedAtUtc: string;
  endedAtUtc: string;
  durationSeconds: number;
  activeEnergyKcal?: number;
  distanceMeters?: number;
  averageHeartRateBpm?: number;
  maximumHeartRateBpm?: number;
};

export type HealthKitWorkoutDelete = {
  kind: "workout_delete";
  sourceSampleKey: string;
};

export type HealthWorkoutRecord = {
  id: string;
  personId: string;
  workoutType: string;
  startedAtUtc: string;
  endedAtUtc: string;
  durationSeconds: number;
  activeEnergyKcal?: number;
  distanceMeters?: number;
  averageHeartRateBpm?: number;
  maximumHeartRateBpm?: number;
};

export type HealthKitSyncOperation =
  | HealthKitStepsHourUpsert
  | HealthKitStepsHourDelete
  | HealthKitSleepDayUpsert
  | HealthKitSleepDayDelete
  | HealthKitDailyMetricUpsert
  | HealthKitDailyMetricDelete
  | HealthKitBloodPressureUpsert
  | HealthKitBloodPressureDelete
  | HealthKitBloodGlucoseUpsert
  | HealthKitBloodGlucoseDelete
  | HealthKitWorkoutUpsert
  | HealthKitWorkoutDelete;

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
  groupsAffected: HealthKitConsentGroup[];
  repairId?: string;
  chunkIndex?: number;
};

export type CreateHealthKitRepairInput = {
  installationId: string;
  personId: string;
  group: HealthKitConsentGroup;
  timezoneVersion: number;
};

export type HealthKitRepair = {
  repairId: string;
  personId: string;
  group: HealthKitConsentGroup;
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
  group: HealthKitConsentGroup;
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
  totalMinutes: number;
  coreMinutes: number;
  deepMinutes: number;
  remMinutes: number;
  unspecifiedAsleepMinutes: number;
  awakeMinutes: number;
  inBedMinutes: number;
  wristTemperatureCelsius?: number;
  breathingDisturbanceCount?: number;
};

export type HealthMetricFreshness = {
  healthMetric: HealthKitMetricKey;
  group: HealthKitConsentGroup;
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

/** MCP accepts every metric explicitly present in the shared HealthKit registry. */
export type McpHealthMetric = HealthKitMetricKey;

export type McpHealthViewType =
  | "hourly_series"
  | "daily_series"
  | "daily_duration_series"
  | "daily_reading_table"
  | "workout_table";

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

export type McpDailyMetricPoint = {
  bucket: string;
  /** Primary value: sum for totals, latest for latest-value metrics, average for statistics. */
  value: number;
  sumValue?: number;
  averageValue?: number;
  minimumValue?: number;
  maximumValue?: number;
  latestValue?: number;
  sampleCount: number;
};

export type McpSleepPoint = {
  bucket: string;
  /** Total sleep duration in hours, retained for simple trend consumers. */
  value: number;
  totalHours: number;
  coreHours: number;
  deepHours: number;
  remHours: number;
  unspecifiedAsleepHours: number;
  awakeHours: number;
  inBedHours: number;
  wristTemperatureCelsius?: number;
  breathingDisturbanceCount?: number;
};

export type McpBloodPressureReadingRow = {
  localDate: string;
  localTime: string;
  systolic: number;
  diastolic: number;
  pulse?: number;
};

export type McpBloodGlucoseReadingRow = {
  localDate: string;
  localTime: string;
  valueMgDl: number;
  /** Present only to preserve discriminated-union property access for existing clients. */
  systolic?: never;
  diastolic?: never;
};

export type McpWorkoutRow = {
  localDate: string;
  localTime: string;
  workoutType: string;
  durationMinutes: number;
  activeEnergyKcal?: number;
  distanceMeters?: number;
  averageHeartRateBpm?: number;
  maximumHeartRateBpm?: number;
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
  healthMetric: Exclude<McpHealthMetric, "steps" | "sleep" | "blood_pressure" | "blood_glucose" | "workout">;
  points: McpDailyMetricPoint[];
};

export type McpStepsDailySeriesResult = McpHealthDataBase & {
  viewType: "daily_series";
  healthMetric: "steps";
  points: McpSeriesPoint[];
};

export type McpDailyDurationSeriesResult = McpHealthDataBase & {
  viewType: "daily_duration_series";
  healthMetric: "sleep";
  points: McpSleepPoint[];
};

export type McpDailyReadingTableResult = McpHealthDataBase & {
  viewType: "daily_reading_table";
  healthMetric: "blood_pressure";
  readings: McpBloodPressureReadingRow[];
  truncated: boolean;
};

export type McpBloodGlucoseTableResult = McpHealthDataBase & {
  viewType: "daily_reading_table";
  healthMetric: "blood_glucose";
  readings: McpBloodGlucoseReadingRow[];
  truncated: boolean;
};

export type McpWorkoutTableResult = McpHealthDataBase & {
  viewType: "workout_table";
  healthMetric: "workout";
  workouts: McpWorkoutRow[];
  truncated: boolean;
};

export type McpGetHealthDataResult =
  | McpHourlySeriesResult
  | McpStepsDailySeriesResult
  | McpDailySeriesResult
  | McpDailyDurationSeriesResult
  | McpDailyReadingTableResult
  | McpBloodGlucoseTableResult
  | McpWorkoutTableResult;

export const MCP_HEALTH_DISCLAIMER =
  "Informational only. Not medical advice. Coverage and freshness metadata describe the stored Family OS data and may be incomplete or delayed." as const;

export const MCP_HEALTH_METRICS: readonly McpHealthMetric[] = HEALTHKIT_METRIC_KEYS;
