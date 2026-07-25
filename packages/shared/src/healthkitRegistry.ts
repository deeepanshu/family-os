/**
 * The complete Family OS HealthKit allowlist. This is deliberately narrower
 * than every HealthKit type: sensitive clinical, location, reproductive, and
 * raw waveform data are excluded. API, MCP, and iOS mappings must use these
 * keys rather than inventing identifiers from HealthKit type names.
 */
export const HEALTHKIT_CONSENT_GROUPS = [
  "activity",
  "sleep",
  "vitals",
  "body",
  "mobility",
  "workouts",
  "mindfulness_environment",
  "nutrition"
] as const;

export type HealthKitConsentGroup = (typeof HEALTHKIT_CONSENT_GROUPS)[number];

export type HealthKitMetricStorage =
  | "hourly"
  | "daily_numeric"
  | "sleep_day"
  | "blood_pressure"
  | "blood_glucose"
  | "workout";

export type HealthKitDailyAggregation = "sum" | "statistics" | "latest";

export type HealthKitMetricDefinition = {
  group: HealthKitConsentGroup;
  unit: string;
  storage: HealthKitMetricStorage;
  aggregation?: HealthKitDailyAggregation;
};

const metric = <T extends HealthKitMetricDefinition>(definition: T): T => definition;

export const HEALTHKIT_METRIC_REGISTRY = {
  steps: metric({ group: "activity", unit: "count", storage: "hourly" }),
  walking_running_distance: metric({ group: "activity", unit: "m", storage: "daily_numeric", aggregation: "sum" }),
  flights_climbed: metric({ group: "activity", unit: "count", storage: "daily_numeric", aggregation: "sum" }),
  active_energy_burned: metric({ group: "activity", unit: "kcal", storage: "daily_numeric", aggregation: "sum" }),
  exercise_time: metric({ group: "activity", unit: "min", storage: "daily_numeric", aggregation: "sum" }),
  stand_time: metric({ group: "activity", unit: "min", storage: "daily_numeric", aggregation: "sum" }),
  vo2_max: metric({ group: "activity", unit: "ml/(kg*min)", storage: "daily_numeric", aggregation: "latest" }),

  sleep: metric({ group: "sleep", unit: "min", storage: "sleep_day" }),
  sleeping_wrist_temperature: metric({ group: "sleep", unit: "degC", storage: "sleep_day" }),
  sleep_breathing_disturbance_events: metric({ group: "sleep", unit: "count", storage: "sleep_day" }),

  heart_rate: metric({ group: "vitals", unit: "bpm", storage: "daily_numeric", aggregation: "statistics" }),
  resting_heart_rate: metric({ group: "vitals", unit: "bpm", storage: "daily_numeric", aggregation: "statistics" }),
  walking_heart_rate_average: metric({ group: "vitals", unit: "bpm", storage: "daily_numeric", aggregation: "statistics" }),
  heart_rate_variability_sdnn: metric({ group: "vitals", unit: "ms", storage: "daily_numeric", aggregation: "statistics" }),
  respiratory_rate: metric({ group: "vitals", unit: "breaths/min", storage: "daily_numeric", aggregation: "statistics" }),
  oxygen_saturation: metric({ group: "vitals", unit: "percent", storage: "daily_numeric", aggregation: "statistics" }),
  body_temperature: metric({ group: "vitals", unit: "degC", storage: "daily_numeric", aggregation: "statistics" }),
  basal_body_temperature: metric({ group: "vitals", unit: "degC", storage: "daily_numeric", aggregation: "latest" }),
  blood_pressure: metric({ group: "vitals", unit: "mmHg", storage: "blood_pressure" }),
  blood_glucose: metric({ group: "vitals", unit: "mg/dL", storage: "blood_glucose" }),

  body_mass: metric({ group: "body", unit: "kg", storage: "daily_numeric", aggregation: "latest" }),
  body_mass_index: metric({ group: "body", unit: "count", storage: "daily_numeric", aggregation: "latest" }),
  body_fat_percentage: metric({ group: "body", unit: "percent", storage: "daily_numeric", aggregation: "latest" }),
  lean_body_mass: metric({ group: "body", unit: "kg", storage: "daily_numeric", aggregation: "latest" }),
  waist_circumference: metric({ group: "body", unit: "m", storage: "daily_numeric", aggregation: "latest" }),

  walking_speed: metric({ group: "mobility", unit: "m/s", storage: "daily_numeric", aggregation: "statistics" }),
  walking_step_length: metric({ group: "mobility", unit: "m", storage: "daily_numeric", aggregation: "statistics" }),
  walking_asymmetry_percentage: metric({ group: "mobility", unit: "percent", storage: "daily_numeric", aggregation: "statistics" }),
  walking_double_support_percentage: metric({ group: "mobility", unit: "percent", storage: "daily_numeric", aggregation: "statistics" }),
  walking_steadiness: metric({ group: "mobility", unit: "percent", storage: "daily_numeric", aggregation: "latest" }),
  number_of_times_fallen: metric({ group: "mobility", unit: "count", storage: "daily_numeric", aggregation: "sum" }),

  workout: metric({ group: "workouts", unit: "workout", storage: "workout" }),

  mindful_minutes: metric({ group: "mindfulness_environment", unit: "min", storage: "daily_numeric", aggregation: "sum" }),
  uv_exposure: metric({ group: "mindfulness_environment", unit: "count", storage: "daily_numeric", aggregation: "sum" }),
  environmental_audio_exposure: metric({ group: "mindfulness_environment", unit: "dBA", storage: "daily_numeric", aggregation: "statistics" }),
  headphone_audio_exposure: metric({ group: "mindfulness_environment", unit: "dBA", storage: "daily_numeric", aggregation: "statistics" }),

  dietary_water: metric({ group: "nutrition", unit: "mL", storage: "daily_numeric", aggregation: "sum" }),
  dietary_caffeine: metric({ group: "nutrition", unit: "mg", storage: "daily_numeric", aggregation: "sum" }),
  number_of_alcoholic_beverages: metric({ group: "nutrition", unit: "count", storage: "daily_numeric", aggregation: "sum" }),
  blood_alcohol_content: metric({ group: "nutrition", unit: "percent", storage: "daily_numeric", aggregation: "latest" }),
  dietary_energy: metric({ group: "nutrition", unit: "kcal", storage: "daily_numeric", aggregation: "sum" }),
  dietary_protein: metric({ group: "nutrition", unit: "g", storage: "daily_numeric", aggregation: "sum" }),
  dietary_carbohydrates: metric({ group: "nutrition", unit: "g", storage: "daily_numeric", aggregation: "sum" }),
  dietary_fiber: metric({ group: "nutrition", unit: "g", storage: "daily_numeric", aggregation: "sum" }),
  dietary_sugar: metric({ group: "nutrition", unit: "g", storage: "daily_numeric", aggregation: "sum" }),
  dietary_fat_total: metric({ group: "nutrition", unit: "g", storage: "daily_numeric", aggregation: "sum" }),
  dietary_fat_saturated: metric({ group: "nutrition", unit: "g", storage: "daily_numeric", aggregation: "sum" }),
  dietary_fat_monounsaturated: metric({ group: "nutrition", unit: "g", storage: "daily_numeric", aggregation: "sum" }),
  dietary_fat_polyunsaturated: metric({ group: "nutrition", unit: "g", storage: "daily_numeric", aggregation: "sum" }),
  dietary_cholesterol: metric({ group: "nutrition", unit: "mg", storage: "daily_numeric", aggregation: "sum" }),
  dietary_sodium: metric({ group: "nutrition", unit: "mg", storage: "daily_numeric", aggregation: "sum" }),
  dietary_potassium: metric({ group: "nutrition", unit: "mg", storage: "daily_numeric", aggregation: "sum" }),
  dietary_calcium: metric({ group: "nutrition", unit: "mg", storage: "daily_numeric", aggregation: "sum" }),
  dietary_chloride: metric({ group: "nutrition", unit: "mg", storage: "daily_numeric", aggregation: "sum" }),
  dietary_chromium: metric({ group: "nutrition", unit: "mcg", storage: "daily_numeric", aggregation: "sum" }),
  dietary_copper: metric({ group: "nutrition", unit: "mg", storage: "daily_numeric", aggregation: "sum" }),
  dietary_iodine: metric({ group: "nutrition", unit: "mcg", storage: "daily_numeric", aggregation: "sum" }),
  dietary_iron: metric({ group: "nutrition", unit: "mg", storage: "daily_numeric", aggregation: "sum" }),
  dietary_magnesium: metric({ group: "nutrition", unit: "mg", storage: "daily_numeric", aggregation: "sum" }),
  dietary_manganese: metric({ group: "nutrition", unit: "mg", storage: "daily_numeric", aggregation: "sum" }),
  dietary_molybdenum: metric({ group: "nutrition", unit: "mcg", storage: "daily_numeric", aggregation: "sum" }),
  dietary_phosphorus: metric({ group: "nutrition", unit: "mg", storage: "daily_numeric", aggregation: "sum" }),
  dietary_selenium: metric({ group: "nutrition", unit: "mcg", storage: "daily_numeric", aggregation: "sum" }),
  dietary_zinc: metric({ group: "nutrition", unit: "mg", storage: "daily_numeric", aggregation: "sum" }),
  dietary_vitamin_a: metric({ group: "nutrition", unit: "mcg", storage: "daily_numeric", aggregation: "sum" }),
  dietary_vitamin_b6: metric({ group: "nutrition", unit: "mg", storage: "daily_numeric", aggregation: "sum" }),
  dietary_vitamin_b12: metric({ group: "nutrition", unit: "mcg", storage: "daily_numeric", aggregation: "sum" }),
  dietary_vitamin_c: metric({ group: "nutrition", unit: "mg", storage: "daily_numeric", aggregation: "sum" }),
  dietary_vitamin_d: metric({ group: "nutrition", unit: "mcg", storage: "daily_numeric", aggregation: "sum" }),
  dietary_vitamin_e: metric({ group: "nutrition", unit: "mg", storage: "daily_numeric", aggregation: "sum" }),
  dietary_vitamin_k: metric({ group: "nutrition", unit: "mcg", storage: "daily_numeric", aggregation: "sum" }),
  dietary_thiamin: metric({ group: "nutrition", unit: "mg", storage: "daily_numeric", aggregation: "sum" }),
  dietary_riboflavin: metric({ group: "nutrition", unit: "mg", storage: "daily_numeric", aggregation: "sum" }),
  dietary_niacin: metric({ group: "nutrition", unit: "mg", storage: "daily_numeric", aggregation: "sum" }),
  dietary_pantothenic_acid: metric({ group: "nutrition", unit: "mg", storage: "daily_numeric", aggregation: "sum" }),
  dietary_folate: metric({ group: "nutrition", unit: "mcg", storage: "daily_numeric", aggregation: "sum" }),
  dietary_biotin: metric({ group: "nutrition", unit: "mcg", storage: "daily_numeric", aggregation: "sum" })
} as const satisfies Record<string, HealthKitMetricDefinition>;

export type HealthKitMetricKey = keyof typeof HEALTHKIT_METRIC_REGISTRY;

export const HEALTHKIT_METRIC_KEYS = Object.keys(HEALTHKIT_METRIC_REGISTRY) as HealthKitMetricKey[];

export function isHealthKitMetricKey(value: string): value is HealthKitMetricKey {
  return value in HEALTHKIT_METRIC_REGISTRY;
}

export function healthKitMetricsForGroup(group: HealthKitConsentGroup): HealthKitMetricKey[] {
  return HEALTHKIT_METRIC_KEYS.filter((key) => HEALTHKIT_METRIC_REGISTRY[key].group === group);
}
