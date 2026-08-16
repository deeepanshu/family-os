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
  creatorDisplayName?: string;
  liveInvite?: LiveInviteSummary;
  profiles: HealthProfile[];
  selfProfile: HealthProfile | null;
  needsProfileSetup: boolean;
};

export type FamilyRole = "manager" | "member";

export const CREATOR_RELATIONSHIP_LABELS = [
  "Father",
  "Mother",
  "Husband",
  "Wife",
  "Partner",
  "Son",
  "Daughter",
  "Brother",
  "Sister",
  "Grandfather",
  "Grandmother",
  "Grandson",
  "Granddaughter"
] as const;

export type CreatorRelationshipLabel = (typeof CREATOR_RELATIONSHIP_LABELS)[number];

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
  /** Directed label from this member to the family creator. Absent for the creator. */
  creatorRelationshipLabel?: CreatorRelationshipLabel;
  createdAt: string;
  updatedAt: string;
};

export type FamilyMember = {
  membership: FamilyMembership;
  email?: string;
  displayName?: string;
};

export type LiveInviteSummary = {
  expiresAt: string;
  status: Extract<FamilyInviteStatus, "pending">;
  /** Present for the creator only. HTTP layer attaches `url`. */
  token: string;
  url?: string;
};

export type AcceptInviteInput = {
  relationshipLabel: CreatorRelationshipLabel;
};

export type CurrentFamilyResponse = {
  family: Family;
  membership: FamilyMembership;
  creatorDisplayName?: string;
  liveInvite?: LiveInviteSummary;
} | null;

export type FamilyInviteStatus = "pending" | "accepted" | "revoked" | "expired";

export type FamilyInvite = {
  id: string;
  familyId: string;
  status: FamilyInviteStatus;
  expiresAt: string;
  createdAt: string;
};

export type CreatedInvite = {
  invite: FamilyInvite;
  token: string;
};

export type CreateInviteResponse = CreatedInvite & {
  url: string;
};

export type PublicInviteResponse = {
  familyName: string;
  creatorDisplayName: string;
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
  /** True until a completed history import matches the active installation + timezone version. */
  needsInitialImport: boolean;
  historyImportCompletedAt?: string;
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

/**
 * Fixed product allowlist for MCP get_health_data in this release.
 * Deliberately NOT derived
 * from the HealthKit registry: enabling a broad consent group must never
 * advertise unrelated registry metrics.
 */
export const MCP_HEALTH_METRICS = ["steps", "blood_pressure", "sleep", "workout"] as const satisfies readonly HealthKitMetricKey[];

export type McpHealthMetric = (typeof MCP_HEALTH_METRICS)[number];

/**
 * Explicit app-toggle → MCP metric mapping. `vitals` means blood pressure only
 * on this product surface; it never advertises heart rate, glucose, or any
 * other broad-registry vital.
 */
export const MCP_HEALTH_METRIC_FOR_PRODUCT_GROUP = {
  activity: "steps",
  vitals: "blood_pressure",
  sleep: "sleep",
  workouts: "workout"
} as const satisfies Record<string, McpHealthMetric>;

export function mcpHealthMetricForProductGroup(group: HealthKitConsentGroup): McpHealthMetric | null {
  return (MCP_HEALTH_METRIC_FOR_PRODUCT_GROUP as Record<string, McpHealthMetric>)[group] ?? null;
}

/** Runtime filter: the MCP metrics available for a set of enabled app toggles. */
export function mcpHealthMetricsForEnabledGroups(enabledGroups: readonly HealthKitConsentGroup[]): McpHealthMetric[] {
  const metrics = enabledGroups
    .map(mcpHealthMetricForProductGroup)
    .filter((metric): metric is McpHealthMetric => metric !== null);
  return MCP_HEALTH_METRICS.filter((metric) => metrics.includes(metric));
}

export type McpHealthViewType =
  | "hourly_count_series"
  | "daily_duration_series"
  | "daily_reading_table"
  | "workout_table";

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
};

export type McpGetHealthDataInput = {
  personId: string;
  healthMetric: McpHealthMetric;
  rangeDays: number;
  timezone?: string;
};

export type McpCoverage = {
  requestedRangeDays: number;
  rangeStart: string;
  rangeEnd: string;
  daysWithData: number;
  /**
   * True when the last successfully completed coverage window fully covers the
   * requested range. Never cleared merely because a newer attempt is in
   * progress or was interrupted.
   */
  complete: boolean;
  availableStart?: string;
  availableEnd?: string;
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

export type McpStepHourPoint = {
  hourStartUtc: string;
  count: number;
};

export type McpBloodPressureReadingRow = {
  localDate: string;
  localTime: string;
  systolic: number;
  diastolic: number;
  pulse?: number;
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
  /** Last completed successful run; never moved by in-progress or interrupted attempts. */
  lastSyncedAt?: string;
};

export type McpHourlyCountSeriesResult = McpHealthDataBase & {
  viewType: "hourly_count_series";
  healthMetric: "steps";
  points: McpStepHourPoint[];
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

export type McpWorkoutTableResult = McpHealthDataBase & {
  viewType: "workout_table";
  healthMetric: "workout";
  workouts: McpWorkoutRow[];
  truncated: boolean;
};

export type McpGetHealthDataResult =
  | McpHourlyCountSeriesResult
  | McpDailyDurationSeriesResult
  | McpDailyReadingTableResult
  | McpWorkoutTableResult;

export function isMcpHealthMetric(value: string): value is McpHealthMetric {
  return (MCP_HEALTH_METRICS as readonly string[]).includes(value);
}
