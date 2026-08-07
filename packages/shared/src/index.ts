import {
  HEALTHKIT_METRIC_KEYS,
  isHealthKitMetricKey,
  type HealthKitConsentGroup,
  type HealthKitMetricKey
} from "./healthkitRegistry";

/** Canonical public prefix for the Family OS health API. */
export const HEALTH_API_PREFIX = "/health/api/v1" as const;

export * from "./healthkitRegistry";
export * from "./healthkitCanonical";
export * from "./healthkitOps";
export * from "./healthkitEvents";
export * from "./healthkitFixtures";

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

/** Solo-first: family/membership are null until the user optionally creates a household. */
export type BootstrapResponse = {
  family: Family | null;
  membership: FamilyMembership | null;
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
  /** Null for solo Self profiles until the user creates a family. */
  familyId: string | null;
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
  familyId: string | null;
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
  | "syncing"
  | "ready"
  | "backfilling"
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

export type HealthWorkoutEventRecord = {
  type: string;
  dateUtc: string;
  endDateUtc?: string;
};

export type HealthWorkoutActivitySegmentRecord = {
  workoutType: string;
  startedAtUtc: string;
  endedAtUtc: string;
  durationSeconds: number;
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
  minimumHeartRateBpm?: number;
  sourceName?: string;
  sourceBundleId?: string;
  deviceName?: string;
  deviceManufacturer?: string;
  isIndoor?: boolean;
  elevationAscendedMeters?: number;
  averageMETs?: number;
  swimmingStrokeCount?: number;
  totalFlightsClimbed?: number;
  events?: HealthWorkoutEventRecord[];
  activities?: HealthWorkoutActivitySegmentRecord[];
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
  familyId: string | null;
  actorUserId?: string;
  action: string;
  resourceType: string;
  resourceId: string;
  metadata?: Record<string, unknown>;
  createdAt: string;
};

/**
 * Sleep-day attribute fields stored on the sleep row. They are returned inside
 * the `sleep` MCP result and are not independent get_health_data metrics.
 */
export const MCP_SLEEP_ATTRIBUTE_METRICS = [
  "sleeping_wrist_temperature",
  "sleep_breathing_disturbance_events"
] as const satisfies readonly HealthKitMetricKey[];

export type McpSleepAttributeMetric = (typeof MCP_SLEEP_ATTRIBUTE_METRICS)[number];

/** Metrics accepted by MCP get_health_data (registry keys minus sleep attributes). */
export type McpHealthMetric = Exclude<HealthKitMetricKey, McpSleepAttributeMetric>;

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
  /** True when stored coverage fully covers the requested range and the metric is not mid-backfill. */
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
  minimumHeartRateBpm?: number;
  sourceName?: string;
  isIndoor?: boolean;
  elevationAscendedMeters?: number;
  averageMETs?: number;
  swimmingStrokeCount?: number;
  totalFlightsClimbed?: number;
  eventCount?: number;
  activitySegmentCount?: number;
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

const MCP_SLEEP_ATTRIBUTE_METRIC_SET = new Set<string>(MCP_SLEEP_ATTRIBUTE_METRICS);

export function isMcpHealthMetric(value: string): value is McpHealthMetric {
  return isHealthKitMetricKey(value) && !MCP_SLEEP_ATTRIBUTE_METRIC_SET.has(value);
}

/** Queryable MCP metrics: full HealthKit registry except sleep-day attribute keys. */
export const MCP_HEALTH_METRICS: readonly McpHealthMetric[] = Object.freeze(
  HEALTHKIT_METRIC_KEYS.filter(isMcpHealthMetric)
);
