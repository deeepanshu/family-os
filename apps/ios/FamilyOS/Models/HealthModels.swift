import Foundation
import HealthKit

struct APIEnvelope<T: Decodable>: Decodable {
    let data: T
}

struct HealthcheckResponse: Decodable {
    let service: String
    let status: String
}

struct SessionResponse: Decodable {
    let userId: String
}

struct BootstrapResponse: Decodable {
    /// Null until the user optionally creates a household.
    let family: Family?
    let membership: FamilyMembership?
    let creatorDisplayName: String?
    let liveInvite: LiveInviteSummary?
    let profiles: [HealthProfile]
    let selfProfile: HealthProfile?
    let needsProfileSetup: Bool
}

struct FamilyResponse: Decodable {
    let family: Family
    let membership: FamilyMembership
    let creatorDisplayName: String?
    let liveInvite: LiveInviteSummary?
}

struct LiveInviteSummary: Decodable {
    let expiresAt: String
    let status: FamilyInviteStatus
    let token: String?
    let url: String?
}

enum FamilyInviteStatus: String, Decodable {
    case pending
    case accepted
    case revoked
    case expired
}

struct Family: Decodable {
    let id: String
    let name: String
    let kind: FamilyKind
    let createdByUserId: String?
}

enum FamilyKind: String, Decodable {
    case personal
    case family
}

struct FamilyMembership: Decodable, Identifiable {
    let id: String
    let userId: String
    let role: FamilyRole
    let status: MembershipStatus
    let creatorRelationshipLabel: CreatorRelationshipLabel?
}

struct FamilyMember: Decodable, Identifiable {
    var id: String { membership.id }

    let membership: FamilyMembership
    let email: String?
    let displayName: String?
}

enum FamilyRole: String, Codable {
    case manager
    case member

    var displayName: String {
        switch self {
        case .manager:
            return "Manager"
        case .member:
            return "Member"
        }
    }
}

enum MembershipStatus: String, Codable {
    case active
    case invited
    case removed
}

struct CreateInviteResponse: Decodable {
    let token: String
    let url: String?
}

struct PublicInvitePreview: Decodable {
    let familyName: String
    let creatorDisplayName: String
    let status: FamilyInviteStatus
    let expiresAt: String
}

enum CreatorRelationshipLabel: String, CaseIterable, Identifiable, Codable {
    case father = "Father"
    case mother = "Mother"
    case husband = "Husband"
    case wife = "Wife"
    case partner = "Partner"
    case son = "Son"
    case daughter = "Daughter"
    case brother = "Brother"
    case sister = "Sister"
    case grandfather = "Grandfather"
    case grandmother = "Grandmother"
    case grandson = "Grandson"
    case granddaughter = "Granddaughter"

    var id: String { rawValue }
}

struct HealthProfile: Decodable, Identifiable {
    let id: String
    let linkedUserId: String?
    let displayName: String
    let relationshipLabel: String?
}

struct BloodPressureReading: Decodable, Identifiable {
    let id: String
    let systolic: Int
    let diastolic: Int
    let pulse: Int?
    let source: HealthDataSource
    let measuredAt: String
}

struct SleepDayReading: Decodable, Identifiable {
    let personId: String
    let sleepDay: String
    let totalMinutes: Int
    let coreMinutes: Int
    let deepMinutes: Int
    let remMinutes: Int
    let unspecifiedAsleepMinutes: Int
    let awakeMinutes: Int
    let inBedMinutes: Int
    let wristTemperatureCelsius: Double?
    let breathingDisturbanceCount: Int?

    var id: String { sleepDay }
}

struct StepDayReading: Decodable, Identifiable {
    let localDay: String
    let count: Int

    var id: String { localDay }
}

struct HeartRateDayReading: Decodable, Identifiable {
    let localDay: String
    let averageValue: Double?
    let minimumValue: Double?
    let maximumValue: Double?
    let latestValue: Double?
    let sampleCount: Int
    let unit: String?

    var id: String { localDay }

    var averageBpm: Int? {
        averageValue.map { Int($0.rounded()) }
    }
}

struct WorkoutSetLog: Codable, Identifiable, Hashable {
    var id = UUID()
    var reps: Int
    var weightKg: Double?

    enum CodingKeys: String, CodingKey {
        case reps, weightKg
    }

    func encode(to encoder: Encoder) throws {
        var container = encoder.container(keyedBy: CodingKeys.self)
        try container.encode(reps, forKey: .reps)
        try container.encodeIfPresent(weightKg, forKey: .weightKg)
    }
}


struct WorkoutExerciseCatalogEntry: Decodable, Identifiable, Hashable {
    let id: String
    let name: String
    let category: String
    let equipment: [String]
}

struct WorkoutExerciseLog: Codable, Identifiable, Hashable {
    var id = UUID()
    var exerciseId: String
    var name: String
    var sets: [WorkoutSetLog]

    enum CodingKeys: String, CodingKey {
        case exerciseId, name, sets
    }

    func encode(to encoder: Encoder) throws {
        var container = encoder.container(keyedBy: CodingKeys.self)
        try container.encode(exerciseId, forKey: .exerciseId)
        try container.encode(sets, forKey: .sets)
    }
}

struct WorkoutHistoryEvent: Decodable {
    let type: String
    let dateUtc: String
    let endDateUtc: String?
}

struct WorkoutHistoryActivity: Decodable {
    let workoutType: String
    let startedAtUtc: String
    let endedAtUtc: String
    let durationSeconds: Int
}

struct WorkoutReading: Decodable, Identifiable {
    let id: String
    let workoutType: String
    let startedAtUtc: String
    let endedAtUtc: String
    let durationSeconds: Int
    let activeEnergyKcal: Double?
    let distanceMeters: Double?
    let averageHeartRateBpm: Double?
    let maximumHeartRateBpm: Double?
    let minimumHeartRateBpm: Double?
    let sourceName: String?
    let deviceName: String?
    let isIndoor: Bool?
    let elevationAscendedMeters: Double?
    let averageMETs: Double?
    let swimmingStrokeCount: Int?
    let totalFlightsClimbed: Int?
    let events: [WorkoutHistoryEvent]?
    let activities: [WorkoutHistoryActivity]?
    let exercises: [WorkoutExerciseLog]?

    var isStrengthWorkout: Bool {
        switch workoutType {
        case "traditional_strength_training", "functional_strength_training", "core_training":
            return true
        default:
            return false
        }
    }

    var isSwimmingWorkout: Bool {
        workoutType == "swimming" || workoutType == "swim_bike_run"
    }
}

struct HistoryMetricCell: Equatable, Identifiable {
    let label: String
    let value: String
    let detail: String?

    var id: String { label }

    init(label: String, value: String, detail: String? = nil) {
        self.label = label
        self.value = value
        self.detail = detail
    }
}

struct HistoryItemPresentation: Equatable {
    let title: String
    let subtitle: String?
    let metrics: [HistoryMetricCell]
}

extension WorkoutReading {
    var historyTitle: String {
        workoutType.replacingOccurrences(of: "_", with: " ").localizedCapitalized
    }

    func historySubtitle(timeZone: TimeZone) -> String? {
        HistoryTimeline.formatTimeRange(startISO: startedAtUtc, endISO: endedAtUtc, timeZone: timeZone)
    }

    var historyMetrics: [HistoryMetricCell] {
        var metrics = [
            HistoryMetricCell(label: "Time", value: HistoryTimeline.formatDuration(seconds: durationSeconds))
        ]
        if let kcal = activeEnergyKcal {
            metrics.append(HistoryMetricCell(label: "Active", value: "\(Int(kcal.rounded())) kcal"))
        }
        if let meters = distanceMeters {
            metrics.append(HistoryMetricCell(label: "Distance", value: HistoryTimeline.formatDistance(meters: meters)))
        }
        if let avg = averageHeartRateBpm {
            let range: String?
            if let min = minimumHeartRateBpm, let max = maximumHeartRateBpm {
                range = "\(Int(min.rounded()))–\(Int(max.rounded()))"
            } else if let max = maximumHeartRateBpm {
                range = "max \(Int(max.rounded()))"
            } else {
                range = nil
            }
            metrics.append(HistoryMetricCell(label: "Heart rate", value: "\(Int(avg.rounded())) bpm", detail: range))
        } else if let max = maximumHeartRateBpm {
            metrics.append(HistoryMetricCell(label: "Heart rate", value: "max \(Int(max.rounded())) bpm"))
        }
        if let elevation = elevationAscendedMeters, elevation > 0 {
            metrics.append(HistoryMetricCell(label: "Elev", value: String(format: "+%.0f m", elevation)))
        }
        if let mets = averageMETs {
            metrics.append(HistoryMetricCell(label: "METs", value: String(format: "%.1f", mets)))
        }
        if let strokes = swimmingStrokeCount, strokes > 0 {
            metrics.append(HistoryMetricCell(label: "Strokes", value: HistoryTimeline.formatCount(strokes)))
        }
        if let flights = totalFlightsClimbed, flights > 0 {
            metrics.append(HistoryMetricCell(label: "Flights", value: "\(flights)"))
        }
        let laps = events?.filter { $0.type == "lap" }.count ?? 0
        if laps > 0 {
            metrics.append(HistoryMetricCell(label: "Laps", value: "\(laps)"))
        }
        if let activities, activities.count > 1 {
            metrics.append(HistoryMetricCell(label: "Segments", value: "\(activities.count)"))
        }
        if let indoor = isIndoor {
            metrics.append(HistoryMetricCell(label: "Place", value: indoor ? "Indoor" : "Outdoor"))
        }
        if let first = exercises?.first {
            let extra = (exercises?.count ?? 1) > 1 ? " +\((exercises?.count ?? 1) - 1)" : ""
            metrics.append(HistoryMetricCell(label: "Exercises", value: "\(first.name)\(extra)"))
        }
        if let source = compactSourceName {
            metrics.append(HistoryMetricCell(label: "Source", value: source))
        }
        return metrics
    }

    private var compactSourceName: String? {
        let raw = deviceName ?? sourceName
        guard let raw, !raw.isEmpty else { return nil }
        if raw.localizedCaseInsensitiveContains("watch") { return "Watch" }
        return raw
    }
}

extension SleepDayReading {
    var historyMetrics: [HistoryMetricCell] {
        var metrics = [
            HistoryMetricCell(label: "Core", value: HistoryTimeline.formatMinutes(coreMinutes)),
            HistoryMetricCell(label: "Deep", value: HistoryTimeline.formatMinutes(deepMinutes)),
            HistoryMetricCell(label: "REM", value: HistoryTimeline.formatMinutes(remMinutes))
        ]
        if unspecifiedAsleepMinutes > 0 {
            metrics.append(HistoryMetricCell(label: "Other", value: HistoryTimeline.formatMinutes(unspecifiedAsleepMinutes)))
        }
        if awakeMinutes > 0 {
            metrics.append(HistoryMetricCell(label: "Awake", value: HistoryTimeline.formatMinutes(awakeMinutes)))
        }
        if inBedMinutes > 0, inBedMinutes != totalMinutes {
            metrics.append(HistoryMetricCell(label: "In bed", value: HistoryTimeline.formatMinutes(inBedMinutes)))
        }
        if let temp = wristTemperatureCelsius {
            metrics.append(HistoryMetricCell(label: "Wrist", value: String(format: "%.1f°C", temp)))
        }
        if let breathing = breathingDisturbanceCount {
            metrics.append(HistoryMetricCell(label: "Breathing", value: "\(breathing)"))
        }
        return metrics
    }
}

extension HistoryItem {
    func presentation(timeZone: TimeZone) -> HistoryItemPresentation {
        switch self {
        case let .bloodPressure(reading):
            var metrics = [
                HistoryMetricCell(label: "Reading", value: "\(reading.systolic)/\(reading.diastolic) mmHg")
            ]
            if let pulse = reading.pulse {
                metrics.append(HistoryMetricCell(label: "Pulse", value: "\(pulse) bpm"))
            } else {
                metrics.append(HistoryMetricCell(label: "Pulse", value: "Not recorded"))
            }
            return HistoryItemPresentation(
                title: "Blood Pressure",
                subtitle: HistoryTimeline.formatTime(reading.measuredAt, timeZone: timeZone),
                metrics: metrics
            )
        case let .sleep(day):
            return HistoryItemPresentation(
                title: "Sleep",
                subtitle: HistoryTimeline.formatMinutes(day.totalMinutes),
                metrics: day.historyMetrics
            )
        case let .steps(day):
            return HistoryItemPresentation(
                title: "Steps",
                subtitle: nil,
                metrics: [HistoryMetricCell(label: "Count", value: HistoryTimeline.formatCount(day.count))]
            )
        case let .heartRate(day):
            var metrics: [HistoryMetricCell] = []
            if let min = day.minimumValue, let max = day.maximumValue {
                metrics.append(HistoryMetricCell(label: "Range", value: "\(Int(min.rounded()))–\(Int(max.rounded())) bpm"))
            }
            if day.sampleCount > 0 {
                metrics.append(HistoryMetricCell(label: "Samples", value: HistoryTimeline.formatCount(day.sampleCount)))
            }
            return HistoryItemPresentation(
                title: "Heart Rate",
                subtitle: day.averageBpm.map { "\($0) bpm" },
                metrics: metrics
            )
        case let .workout(workout):
            return HistoryItemPresentation(
                title: workout.historyTitle,
                subtitle: workout.historySubtitle(timeZone: timeZone),
                metrics: workout.historyMetrics
            )
        }
    }
}



enum HistoryMetricFilter: String, CaseIterable, Identifiable {
    case all
    case bloodPressure
    case heartRate
    case sleep
    case steps
    case workouts
    case swimming

    var id: String { rawValue }

    var title: String {
        switch self {
        case .all: return "All"
        case .bloodPressure: return "BP"
        case .heartRate: return "HR"
        case .sleep: return "Sleep"
        case .steps: return "Steps"
        case .workouts: return "Workouts"
        case .swimming: return "Swim"
        }
    }
}

enum HistoryItem: Identifiable {
    case bloodPressure(BloodPressureReading)
    case heartRate(HeartRateDayReading)
    case workout(WorkoutReading)
    case sleep(SleepDayReading)
    case steps(StepDayReading)

    var id: String {
        switch self {
        case let .bloodPressure(reading): return "bp:\(reading.id)"
        case let .heartRate(day): return "hr:\(day.localDay)"
        case let .workout(workout): return "workout:\(workout.id)"
        case let .sleep(day): return "sleep:\(day.sleepDay)"
        case let .steps(day): return "steps:\(day.localDay)"
        }
    }

    var metric: HistoryMetricFilter {
        switch self {
        case .bloodPressure: return .bloodPressure
        case .heartRate: return .heartRate
        case let .workout(workout): return workout.isSwimmingWorkout ? .swimming : .workouts
        case .sleep: return .sleep
        case .steps: return .steps
        }
    }
}

struct HistoryDay: Identifiable {
    let localDay: String
    let items: [HistoryItem]

    var id: String { localDay }
}

enum HistoryTimeline {
    static func days(
        bloodPressure: [BloodPressureReading],
        heartRate: [HeartRateDayReading],
        sleep: [SleepDayReading],
        steps: [StepDayReading],
        workouts: [WorkoutReading],
        filter: HistoryMetricFilter,
        timeZone: TimeZone
    ) -> [HistoryDay] {
        var grouped: [String: [HistoryItem]] = [:]

        func append(_ day: String, _ item: HistoryItem) {
            guard filter == .all || item.metric == filter || (filter == .workouts && item.metric == .swimming) else { return }
            grouped[day, default: []].append(item)
        }

        for reading in bloodPressure {
            guard let day = localDay(iso: reading.measuredAt, timeZone: timeZone) else { continue }
            append(day, .bloodPressure(reading))
        }
        for workout in workouts {
            guard let day = localDay(iso: workout.startedAtUtc, timeZone: timeZone) else { continue }
            append(day, .workout(workout))
        }
        for day in sleep {
            append(day.sleepDay, .sleep(day))
        }
        for day in steps {
            append(day.localDay, .steps(day))
        }
        for day in heartRate {
            append(day.localDay, .heartRate(day))
        }

        return grouped.keys.sorted(by: >).map { day in
            HistoryDay(localDay: day, items: grouped[day]!.sorted(by: Self.itemSort))
        }
    }

    static func dateTitle(localDay: String, now: Date = Date(), timeZone: TimeZone) -> String {
        guard let date = date(fromLocalDay: localDay, timeZone: timeZone) else { return localDay }
        var calendar = Calendar(identifier: .gregorian)
        calendar.timeZone = timeZone
        if calendar.isDate(date, inSameDayAs: now) {
            return "Today"
        }
        if let yesterday = calendar.date(byAdding: .day, value: -1, to: calendar.startOfDay(for: now)),
           calendar.isDate(date, inSameDayAs: yesterday) {
            return "Yesterday"
        }
        let formatter = DateFormatter()
        formatter.calendar = calendar
        formatter.timeZone = timeZone
        formatter.locale = Locale(identifier: "en_US_POSIX")
        let nowYear = calendar.component(.year, from: now)
        let dayYear = calendar.component(.year, from: date)
        formatter.dateFormat = nowYear == dayYear ? "d MMM" : "d MMM yyyy"
        return formatter.string(from: date)
    }

    static func localDay(iso: String, timeZone: TimeZone) -> String? {
        guard let date = parseISO(iso) else { return nil }
        var calendar = Calendar(identifier: .gregorian)
        calendar.timeZone = timeZone
        let parts = calendar.dateComponents([.year, .month, .day], from: date)
        guard let year = parts.year, let month = parts.month, let day = parts.day else { return nil }
        return String(format: "%04d-%02d-%02d", year, month, day)
    }

    static func parseISO(_ iso: String) -> Date? {
        HealthKitRunEngine.parseISODate(iso)
    }

    static func formatMinutes(_ total: Int) -> String {
        let hours = total / 60
        let minutes = total % 60
        if hours == 0 { return "\(minutes)m" }
        if minutes == 0 { return "\(hours)h" }
        return "\(hours)h \(minutes)m"
    }

    static func formatDuration(seconds: Int) -> String {
        let clamped = max(seconds, 0)
        if clamped < 60 { return "\(clamped)s" }
        return formatMinutes(clamped / 60)
    }

    static func formatDistance(meters: Double) -> String {
        if meters >= 1000 {
            return String(format: "%.1f km", meters / 1000)
        }
        return String(format: "%.0f m", meters)
    }

    static func formatTime(_ iso: String, timeZone: TimeZone) -> String? {
        guard let date = parseISO(iso) else { return nil }
        let formatter = DateFormatter()
        formatter.timeZone = timeZone
        formatter.locale = Locale(identifier: "en_US_POSIX")
        formatter.dateFormat = "HH:mm"
        return formatter.string(from: date)
    }

    static func formatTimeRange(startISO: String, endISO: String, timeZone: TimeZone) -> String? {
        guard let start = formatTime(startISO, timeZone: timeZone) else { return nil }
        guard let end = formatTime(endISO, timeZone: timeZone), end != start else { return start }
        return "\(start)–\(end)"
    }

    static func formatCount(_ value: Int) -> String {
        let formatter = NumberFormatter()
        formatter.locale = Locale(identifier: "en_US")
        formatter.numberStyle = .decimal
        formatter.maximumFractionDigits = 0
        return formatter.string(from: NSNumber(value: value)) ?? "\(value)"
    }

    private static func date(fromLocalDay localDay: String, timeZone: TimeZone) -> Date? {
        let parts = localDay.split(separator: "-").compactMap { Int($0) }
        guard parts.count == 3 else { return nil }
        var calendar = Calendar(identifier: .gregorian)
        calendar.timeZone = timeZone
        return calendar.date(from: DateComponents(year: parts[0], month: parts[1], day: parts[2]))
    }

    private static func itemSort(_ lhs: HistoryItem, _ rhs: HistoryItem) -> Bool {
        let left = sortKey(lhs)
        let right = sortKey(rhs)
        if left.rank != right.rank { return left.rank < right.rank }
        return left.time > right.time
    }

    private static func sortKey(_ item: HistoryItem) -> (rank: Int, time: TimeInterval) {
        switch item {
        case let .bloodPressure(reading):
            return (0, parseISO(reading.measuredAt)?.timeIntervalSince1970 ?? 0)
        case let .workout(workout):
            return (0, parseISO(workout.startedAtUtc)?.timeIntervalSince1970 ?? 0)
        case .heartRate:
            return (1, 0)
        case .sleep:
            return (2, 0)
        case .steps:
            return (3, 0)
        }
    }
}

enum HealthDataSource: String, Codable {
    case healthkit

    var displayName: String {
        "HealthKit"
    }
}

enum HealthKitSyncMetric: String, Codable, CaseIterable, Identifiable, Sendable {
    case activity
    case sleep
    case vitals
    case body
    case mobility
    case workouts
    case mindfulnessEnvironment = "mindfulness_environment"
    case nutrition

    // Temporary aliases keep the existing three-source sync implementation
    // working while each group is expanded into its complete HealthKit map.
    static let steps = HealthKitSyncMetric.activity
    static let bloodPressure = HealthKitSyncMetric.vitals

    /// The groups with an implemented foreground product surface in this release.
    /// Activity is deliberately Steps-only; background delivery remains separate.
    /// Nonisolated so the run engine can use it without MainActor hops.
    static let productMetrics: Set<HealthKitSyncMetric> = [.activity, .vitals, .sleep, .workouts]

    var id: String { rawValue }

    var displayName: String {
        switch self {
        case .activity:
            return "Activity"
        case .sleep:
            return "Sleep"
        case .vitals:
            return "Vitals"
        case .body:
            return "Body"
        case .mobility:
            return "Mobility"
        case .workouts:
            return "Workouts"
        case .mindfulnessEnvironment:
            return "Mindfulness and Environment"
        case .nutrition:
            return "Nutrition"
        }
    }
}

enum HealthKitMetricStorage: Sendable {
    case hourly
    case dailyNumeric
    case sleepDay
    case bloodPressure
    case bloodGlucose
    case workout
}

enum HealthKitDailyAggregation: Sendable {
    case sum
    case statistics
    case latest
}

/// The iOS counterpart of the API's canonical HealthKit registry. These are
/// individual HealthKit sample types; consent and repair remain group scoped.
enum HealthKitDataMetric: String, CaseIterable, Sendable {
    case steps, walkingRunningDistance = "walking_running_distance", flightsClimbed = "flights_climbed", activeEnergyBurned = "active_energy_burned", exerciseTime = "exercise_time", standTime = "stand_time", vo2Max = "vo2_max"
    case sleep, sleepingWristTemperature = "sleeping_wrist_temperature", sleepBreathingDisturbanceEvents = "sleep_breathing_disturbance_events"
    case heartRate = "heart_rate", restingHeartRate = "resting_heart_rate", walkingHeartRateAverage = "walking_heart_rate_average", heartRateVariabilitySDNN = "heart_rate_variability_sdnn", respiratoryRate = "respiratory_rate", oxygenSaturation = "oxygen_saturation", bodyTemperature = "body_temperature", basalBodyTemperature = "basal_body_temperature", bloodPressure = "blood_pressure", bloodGlucose = "blood_glucose"
    case bodyMass = "body_mass", bodyMassIndex = "body_mass_index", bodyFatPercentage = "body_fat_percentage", leanBodyMass = "lean_body_mass", waistCircumference = "waist_circumference"
    case walkingSpeed = "walking_speed", walkingStepLength = "walking_step_length", walkingAsymmetryPercentage = "walking_asymmetry_percentage", walkingDoubleSupportPercentage = "walking_double_support_percentage", walkingSteadiness = "walking_steadiness", numberOfTimesFallen = "number_of_times_fallen"
    case workout
    case mindfulMinutes = "mindful_minutes", uvExposure = "uv_exposure", environmentalAudioExposure = "environmental_audio_exposure", headphoneAudioExposure = "headphone_audio_exposure"
    case dietaryWater = "dietary_water", dietaryCaffeine = "dietary_caffeine", numberOfAlcoholicBeverages = "number_of_alcoholic_beverages", bloodAlcoholContent = "blood_alcohol_content", dietaryEnergy = "dietary_energy", dietaryProtein = "dietary_protein", dietaryCarbohydrates = "dietary_carbohydrates", dietaryFiber = "dietary_fiber", dietarySugar = "dietary_sugar", dietaryFatTotal = "dietary_fat_total", dietaryFatSaturated = "dietary_fat_saturated", dietaryFatMonounsaturated = "dietary_fat_monounsaturated", dietaryFatPolyunsaturated = "dietary_fat_polyunsaturated", dietaryCholesterol = "dietary_cholesterol", dietarySodium = "dietary_sodium", dietaryPotassium = "dietary_potassium", dietaryCalcium = "dietary_calcium", dietaryChloride = "dietary_chloride", dietaryChromium = "dietary_chromium", dietaryCopper = "dietary_copper", dietaryIodine = "dietary_iodine", dietaryIron = "dietary_iron", dietaryMagnesium = "dietary_magnesium", dietaryManganese = "dietary_manganese", dietaryMolybdenum = "dietary_molybdenum", dietaryPhosphorus = "dietary_phosphorus", dietarySelenium = "dietary_selenium", dietaryZinc = "dietary_zinc", dietaryVitaminA = "dietary_vitamin_a", dietaryVitaminB6 = "dietary_vitamin_b6", dietaryVitaminB12 = "dietary_vitamin_b12", dietaryVitaminC = "dietary_vitamin_c", dietaryVitaminD = "dietary_vitamin_d", dietaryVitaminE = "dietary_vitamin_e", dietaryVitaminK = "dietary_vitamin_k", dietaryThiamin = "dietary_thiamin", dietaryRiboflavin = "dietary_riboflavin", dietaryNiacin = "dietary_niacin", dietaryPantothenicAcid = "dietary_pantothenic_acid", dietaryFolate = "dietary_folate", dietaryBiotin = "dietary_biotin"

    var group: HealthKitSyncMetric {
        switch self {
        case .steps, .walkingRunningDistance, .flightsClimbed, .activeEnergyBurned, .exerciseTime, .standTime, .vo2Max: .activity
        case .sleep, .sleepingWristTemperature, .sleepBreathingDisturbanceEvents: .sleep
        case .heartRate, .restingHeartRate, .walkingHeartRateAverage, .heartRateVariabilitySDNN, .respiratoryRate, .oxygenSaturation, .bodyTemperature, .basalBodyTemperature, .bloodPressure, .bloodGlucose: .vitals
        case .bodyMass, .bodyMassIndex, .bodyFatPercentage, .leanBodyMass, .waistCircumference: .body
        case .walkingSpeed, .walkingStepLength, .walkingAsymmetryPercentage, .walkingDoubleSupportPercentage, .walkingSteadiness, .numberOfTimesFallen: .mobility
        case .workout: .workouts
        case .mindfulMinutes, .uvExposure, .environmentalAudioExposure, .headphoneAudioExposure: .mindfulnessEnvironment
        default: .nutrition
        }
    }

    var storage: HealthKitMetricStorage {
        switch self {
        case .steps: .hourly
        case .sleep: .sleepDay
        case .sleepingWristTemperature, .sleepBreathingDisturbanceEvents: .sleepDay
        case .bloodPressure: .bloodPressure
        case .bloodGlucose: .bloodGlucose
        case .workout: .workout
        default: .dailyNumeric
        }
    }

    var aggregation: HealthKitDailyAggregation {
        switch self {
        case .walkingRunningDistance, .flightsClimbed, .activeEnergyBurned, .exerciseTime, .standTime, .numberOfTimesFallen, .mindfulMinutes, .uvExposure,
             .dietaryWater, .dietaryCaffeine, .numberOfAlcoholicBeverages, .dietaryEnergy, .dietaryProtein, .dietaryCarbohydrates, .dietaryFiber, .dietarySugar,
             .dietaryFatTotal, .dietaryFatSaturated, .dietaryFatMonounsaturated, .dietaryFatPolyunsaturated, .dietaryCholesterol, .dietarySodium, .dietaryPotassium,
             .dietaryCalcium, .dietaryChloride, .dietaryChromium, .dietaryCopper, .dietaryIodine, .dietaryIron, .dietaryMagnesium, .dietaryManganese,
             .dietaryMolybdenum, .dietaryPhosphorus, .dietarySelenium, .dietaryZinc, .dietaryVitaminA, .dietaryVitaminB6, .dietaryVitaminB12, .dietaryVitaminC,
             .dietaryVitaminD, .dietaryVitaminE, .dietaryVitaminK, .dietaryThiamin, .dietaryRiboflavin, .dietaryNiacin, .dietaryPantothenicAcid, .dietaryFolate, .dietaryBiotin:
            .sum
        case .vo2Max, .basalBodyTemperature, .bodyMass, .bodyMassIndex, .bodyFatPercentage, .leanBodyMass, .waistCircumference, .walkingSteadiness, .bloodAlcoholContent:
            .latest
        default:
            .statistics
        }
    }

    var quantityIdentifier: String? {
        switch self {
        case .sleep, .bloodPressure, .workout, .mindfulMinutes: nil
        case .steps: "StepCount"
        case .walkingRunningDistance: "DistanceWalkingRunning"
        case .flightsClimbed: "FlightsClimbed"
        case .activeEnergyBurned: "ActiveEnergyBurned"
        case .exerciseTime: "AppleExerciseTime"
        case .standTime: "AppleStandTime"
        case .vo2Max: "VO2Max"
        case .sleepingWristTemperature: "AppleSleepingWristTemperature"
        case .sleepBreathingDisturbanceEvents: "AppleSleepingBreathingDisturbances"
        case .heartRate: "HeartRate"
        case .restingHeartRate: "RestingHeartRate"
        case .walkingHeartRateAverage: "WalkingHeartRateAverage"
        case .heartRateVariabilitySDNN: "HeartRateVariabilitySDNN"
        case .respiratoryRate: "RespiratoryRate"
        case .oxygenSaturation: "OxygenSaturation"
        case .bodyTemperature: "BodyTemperature"
        case .basalBodyTemperature: "BasalBodyTemperature"
        case .bloodGlucose: "BloodGlucose"
        case .bodyMass: "BodyMass"
        case .bodyMassIndex: "BodyMassIndex"
        case .bodyFatPercentage: "BodyFatPercentage"
        case .leanBodyMass: "LeanBodyMass"
        case .waistCircumference: "WaistCircumference"
        case .walkingSpeed: "WalkingSpeed"
        case .walkingStepLength: "WalkingStepLength"
        case .walkingAsymmetryPercentage: "WalkingAsymmetryPercentage"
        case .walkingDoubleSupportPercentage: "WalkingDoubleSupportPercentage"
        case .walkingSteadiness: "AppleWalkingSteadiness"
        case .numberOfTimesFallen: "NumberOfTimesFallen"
        case .uvExposure: "UVExposure"
        case .environmentalAudioExposure: "EnvironmentalAudioExposure"
        case .headphoneAudioExposure: "HeadphoneAudioExposure"
        case .dietaryWater: "DietaryWater"
        case .dietaryCaffeine: "DietaryCaffeine"
        case .numberOfAlcoholicBeverages: "NumberOfAlcoholicBeverages"
        case .bloodAlcoholContent: "BloodAlcoholContent"
        case .dietaryEnergy: "DietaryEnergyConsumed"
        default: "Dietary" + rawValue.dropFirst("dietary_".count).split(separator: "_").map { $0.prefix(1).uppercased() + $0.dropFirst() }.joined()
        }
    }

    var sampleType: HKSampleType? {
        switch self {
        case .sleep:
            return HKCategoryType.categoryType(forIdentifier: .sleepAnalysis)
        case .bloodPressure:
            return HKCorrelationType.correlationType(forIdentifier: .bloodPressure)
        case .workout:
            return HKWorkoutType.workoutType()
        case .mindfulMinutes:
            return HKCategoryType.categoryType(forIdentifier: .mindfulSession)
        default:
            guard let quantityIdentifier else { return nil }
            return HKQuantityType.quantityType(forIdentifier: HKQuantityTypeIdentifier(rawValue: "HKQuantityTypeIdentifier" + quantityIdentifier))
        }
    }

    var unit: HKUnit? {
        switch self {
        case .steps, .flightsClimbed, .numberOfTimesFallen, .numberOfAlcoholicBeverages, .uvExposure, .sleepBreathingDisturbanceEvents: .count()
        case .walkingRunningDistance, .waistCircumference, .walkingStepLength: .meter()
        case .walkingSpeed: HKUnit.meter().unitDivided(by: .second())
        case .activeEnergyBurned, .dietaryEnergy: .kilocalorie()
        case .exerciseTime, .standTime: .minute()
        case .vo2Max:
            HKUnit.literUnit(with: .milli).unitDivided(
                by: HKUnit.gramUnit(with: .kilo).unitMultiplied(by: .minute())
            )
        case .sleepingWristTemperature, .bodyTemperature, .basalBodyTemperature: .degreeCelsius()
        case .heartRate, .restingHeartRate, .walkingHeartRateAverage: HKUnit.count().unitDivided(by: .minute())
        case .heartRateVariabilitySDNN: .secondUnit(with: .milli)
        case .respiratoryRate: HKUnit.count().unitDivided(by: .minute())
        case .oxygenSaturation, .bodyFatPercentage, .walkingAsymmetryPercentage, .walkingDoubleSupportPercentage, .walkingSteadiness, .bloodAlcoholContent: .percent()
        case .bloodGlucose: HKUnit(from: "mg/dL")
        case .bodyMass, .leanBodyMass: .gramUnit(with: .kilo)
        case .bodyMassIndex: .count()
        case .environmentalAudioExposure, .headphoneAudioExposure: HKUnit(from: "dBASPL")
        case .dietaryWater: .literUnit(with: .milli)
        case .dietaryCaffeine, .dietaryCholesterol, .dietarySodium, .dietaryPotassium, .dietaryCalcium, .dietaryChloride, .dietaryCopper, .dietaryIron, .dietaryMagnesium, .dietaryManganese, .dietaryPhosphorus, .dietaryZinc, .dietaryVitaminB6, .dietaryVitaminC, .dietaryThiamin, .dietaryRiboflavin, .dietaryNiacin, .dietaryPantothenicAcid: .gramUnit(with: .milli)
        case .dietaryChromium, .dietaryIodine, .dietaryMolybdenum, .dietarySelenium, .dietaryVitaminA, .dietaryVitaminB12, .dietaryVitaminD, .dietaryVitaminE, .dietaryVitaminK, .dietaryFolate, .dietaryBiotin: .gramUnit(with: .micro)
        case .dietaryProtein, .dietaryCarbohydrates, .dietaryFiber, .dietarySugar, .dietaryFatTotal, .dietaryFatSaturated, .dietaryFatMonounsaturated, .dietaryFatPolyunsaturated: .gram()
        case .sleep, .bloodPressure, .workout, .mindfulMinutes: nil
        }
    }

    static func metrics(for group: HealthKitSyncMetric) -> [HealthKitDataMetric] {
        allCases.filter { $0.group == group }
    }
}

/// Matches frozen API `HealthMetricSyncStatusCode`.
enum HealthKitMetricSyncStatus: String, Codable {
    case neverSynced = "never_synced"
    case syncing
    case ready
    case backfilling
    case error
    case disabled

    var displayName: String {
        switch self {
        case .neverSynced:
            return "Not started"
        case .syncing, .backfilling:
            return "Syncing"
        case .ready:
            return "Ready"
        case .error:
            return "Failed"
        case .disabled:
            return "Disabled"
        }
    }
}

struct HealthKitMetricState: Decodable, Identifiable {
    var id: String { group.rawValue }

    let group: HealthKitSyncMetric
    let enabled: Bool
    let status: HealthKitMetricSyncStatus
    let lastSuccessfulAt: String?
    let lastAttemptAt: String?
    let lastErrorCode: String?
    let coverageStartAt: String?
    let coverageEndAt: String?
    /// Server-derived: no completed history import matches the active
    /// installation + timezone version. Optional for older server compatibility;
    /// falls back to status-based derivation when absent.
    let needsInitialImport: Bool?
    let historyImportCompletedAt: String?

    var metric: HealthKitSyncMetric { group }

    /// Display/Eligibility source of truth for the Import history vs Sync gate.
    var needsImport: Bool {
        needsInitialImport ?? (status != .ready)
    }
}

/// Matches frozen API `HealthKitSettings` from GET/PUT `/healthkit/settings`.
struct HealthKitSyncStatus: Decodable {
    let personId: String
    let consentVersion: String?
    let consentedAt: String?
    let healthTimezone: String
    let healthTimezoneVersion: Int
    let enabledGroups: [HealthKitSyncMetric]
    let activeInstallationId: String?
    let groups: [HealthKitMetricState]

    var consentActive: Bool {
        consentVersion != nil && consentedAt != nil && !enabledGroups.isEmpty
    }

    var enabledMetrics: [HealthKitSyncMetric] { enabledGroups }
    var metrics: [HealthKitMetricState] { groups }
}

struct HealthKitEventApplyResult: Decodable {
    let eventId: String
    let result: String
    let errorCode: String?
    let errorMessage: String?
}

struct HealthKitEventsBatchResult: Decodable {
    let results: [HealthKitEventApplyResult]
}

struct HealthKitBackfillSession: Decodable {
    let sessionId: String
    let personId: String
    let group: HealthKitSyncMetric
    let installationId: String
    let timezoneVersion: Int
    let rangeStart: String
    let rangeEnd: String
    let rangeStartDay: String
    let rangeEndDay: String
    let requiredScopeKeys: [String]
    let status: String
    let expiresAt: String
    let pendingCount: Int?

    var metric: HealthKitSyncMetric { group }
}

struct HealthKitScopeManifestResult: Decodable {
    let sessionId: String
    let scopeKey: String
    let status: String
    let eventCount: Int
}

struct HealthKitBackfillSessionCompleteResult: Decodable {
    let sessionId: String
    let group: HealthKitSyncMetric
    let completed: Bool

    var metric: HealthKitSyncMetric { group }
}

struct HealthKitBackfillSessionAbortResult: Decodable {
    let sessionId: String
    let group: HealthKitSyncMetric
    let aborted: Bool
}

/// Wire event for POST /healthkit/events:batch.
struct HealthKitWireEvent: Encodable {
    let eventId: String
    let entityKey: String
    let entityVersion: Int
    let group: HealthKitSyncMetric
    let scopeKey: String
    let op: String
    let sessionId: String?
    let payload: HealthKitEventPayload?
}

enum HealthKitEventPayload: Encodable {
    case stepsHour(hourStartUtc: String, count: Int)
    case sleepDay(
        sleepDay: String,
        totalMinutes: Int,
        coreMinutes: Int,
        deepMinutes: Int,
        remMinutes: Int,
        unspecifiedAsleepMinutes: Int,
        awakeMinutes: Int,
        inBedMinutes: Int,
        wristTemperatureCelsius: Double?,
        breathingDisturbanceCount: Int?
    )
    case dailyMetric(
        healthMetric: HealthKitDataMetric,
        localDay: String,
        sumValue: Double?,
        averageValue: Double?,
        minimumValue: Double?,
        maximumValue: Double?,
        latestValue: Double?,
        sampleCount: Int
    )
    case bloodPressure(sourceObjectKey: String, measuredAtUtc: String, systolic: Int, diastolic: Int, pulse: Int?)
    case bloodGlucose(sourceSampleKey: String, measuredAtUtc: String, valueMgDl: Double)
    case workout(
        sourceSampleKey: String,
        workoutType: String,
        startedAtUtc: String,
        endedAtUtc: String,
        durationSeconds: Int,
        activeEnergyKcal: Double?,
        distanceMeters: Double?,
        averageHeartRateBpm: Double?,
        maximumHeartRateBpm: Double?
    )

    func encode(to encoder: Encoder) throws {
        var container = encoder.container(keyedBy: CodingKeys.self)
        switch self {
        case let .stepsHour(hourStartUtc, count):
            try container.encode("steps_hour", forKey: .kind)
            try container.encode(hourStartUtc, forKey: .hourStartUtc)
            try container.encode(count, forKey: .count)
        case let .sleepDay(
            sleepDay, totalMinutes, coreMinutes, deepMinutes, remMinutes,
            unspecifiedAsleepMinutes, awakeMinutes, inBedMinutes,
            wristTemperatureCelsius, breathingDisturbanceCount
        ):
            try container.encode("sleep_day", forKey: .kind)
            try container.encode(sleepDay, forKey: .sleepDay)
            try container.encode(totalMinutes, forKey: .totalMinutes)
            try container.encode(coreMinutes, forKey: .coreMinutes)
            try container.encode(deepMinutes, forKey: .deepMinutes)
            try container.encode(remMinutes, forKey: .remMinutes)
            try container.encode(unspecifiedAsleepMinutes, forKey: .unspecifiedAsleepMinutes)
            try container.encode(awakeMinutes, forKey: .awakeMinutes)
            try container.encode(inBedMinutes, forKey: .inBedMinutes)
            try container.encodeIfPresent(wristTemperatureCelsius, forKey: .wristTemperatureCelsius)
            try container.encodeIfPresent(breathingDisturbanceCount, forKey: .breathingDisturbanceCount)
        case let .dailyMetric(healthMetric, localDay, sumValue, averageValue, minimumValue, maximumValue, latestValue, sampleCount):
            try container.encode("daily_metric", forKey: .kind)
            try container.encode(healthMetric.rawValue, forKey: .healthMetric)
            try container.encode(localDay, forKey: .localDay)
            try container.encodeIfPresent(sumValue, forKey: .sumValue)
            try container.encodeIfPresent(averageValue, forKey: .averageValue)
            try container.encodeIfPresent(minimumValue, forKey: .minimumValue)
            try container.encodeIfPresent(maximumValue, forKey: .maximumValue)
            try container.encodeIfPresent(latestValue, forKey: .latestValue)
            try container.encode(sampleCount, forKey: .sampleCount)
        case let .bloodPressure(sourceObjectKey, measuredAtUtc, systolic, diastolic, pulse):
            try container.encode("blood_pressure", forKey: .kind)
            try container.encode(sourceObjectKey, forKey: .sourceObjectKey)
            try container.encode(measuredAtUtc, forKey: .measuredAtUtc)
            try container.encode(systolic, forKey: .systolic)
            try container.encode(diastolic, forKey: .diastolic)
            try container.encodeIfPresent(pulse, forKey: .pulse)
        case let .bloodGlucose(sourceSampleKey, measuredAtUtc, valueMgDl):
            try container.encode("blood_glucose", forKey: .kind)
            try container.encode(sourceSampleKey, forKey: .sourceSampleKey)
            try container.encode(measuredAtUtc, forKey: .measuredAtUtc)
            try container.encode(valueMgDl, forKey: .valueMgDl)
        case let .workout(
            sourceSampleKey, workoutType, startedAtUtc, endedAtUtc, durationSeconds,
            activeEnergyKcal, distanceMeters, averageHeartRateBpm, maximumHeartRateBpm
        ):
            try container.encode("workout", forKey: .kind)
            try container.encode(sourceSampleKey, forKey: .sourceSampleKey)
            try container.encode(workoutType, forKey: .workoutType)
            try container.encode(startedAtUtc, forKey: .startedAtUtc)
            try container.encode(endedAtUtc, forKey: .endedAtUtc)
            try container.encode(durationSeconds, forKey: .durationSeconds)
            try container.encodeIfPresent(activeEnergyKcal, forKey: .activeEnergyKcal)
            try container.encodeIfPresent(distanceMeters, forKey: .distanceMeters)
            try container.encodeIfPresent(averageHeartRateBpm, forKey: .averageHeartRateBpm)
            try container.encodeIfPresent(maximumHeartRateBpm, forKey: .maximumHeartRateBpm)
        }
    }

    private enum CodingKeys: String, CodingKey {
        case kind, hourStartUtc, count, sleepDay, totalMinutes, coreMinutes, deepMinutes, remMinutes
        case unspecifiedAsleepMinutes, awakeMinutes, inBedMinutes, wristTemperatureCelsius, breathingDisturbanceCount
        case healthMetric, localDay, sumValue, averageValue, minimumValue, maximumValue, latestValue, sampleCount
        case sourceSampleKey, sourceObjectKey, measuredAtUtc, systolic, diastolic, pulse, valueMgDl
        case workoutType, startedAtUtc, endedAtUtc, durationSeconds, activeEnergyKcal, distanceMeters
        case averageHeartRateBpm, maximumHeartRateBpm
    }
}

enum HealthKitSyncOperation: Encodable {
    case stepsHourUpsert(hourStartUtc: String, count: Int)
    case stepsHourDelete(hourStartUtc: String)
    case sleepDayUpsert(sleepDay: String, totalMinutes: Int, coreMinutes: Int, deepMinutes: Int, remMinutes: Int, unspecifiedAsleepMinutes: Int, awakeMinutes: Int, inBedMinutes: Int, wristTemperatureCelsius: Double? = nil, breathingDisturbanceCount: Int? = nil)
    case sleepDayDelete(sleepDay: String)
    case dailyMetricUpsert(healthMetric: HealthKitDataMetric, localDay: String, sumValue: Double?, averageValue: Double?, minimumValue: Double?, maximumValue: Double?, latestValue: Double?, sampleCount: Int)
    case dailyMetricDelete(healthMetric: HealthKitDataMetric, localDay: String)
    case bloodPressureUpsert(sourceObjectKey: String, measuredAtUtc: String, systolic: Int, diastolic: Int, pulse: Int?)
    case bloodPressureDelete(sourceObjectKey: String)
    case bloodGlucoseUpsert(sourceSampleKey: String, measuredAtUtc: String, valueMgDl: Double)
    case bloodGlucoseDelete(sourceSampleKey: String)
    case workoutUpsert(sourceSampleKey: String, workoutType: String, startedAtUtc: String, endedAtUtc: String, durationSeconds: Int, activeEnergyKcal: Double?, distanceMeters: Double?, averageHeartRateBpm: Double?, maximumHeartRateBpm: Double?)
    case workoutDelete(sourceSampleKey: String)

    private enum CodingKeys: String, CodingKey {
        case kind
        case hourStartUtc
        case count
        case sleepDay
        case totalMinutes
        case coreMinutes
        case deepMinutes
        case remMinutes
        case unspecifiedAsleepMinutes
        case awakeMinutes
        case inBedMinutes
        case wristTemperatureCelsius
        case breathingDisturbanceCount
        case healthMetric
        case localDay
        case sumValue
        case averageValue
        case minimumValue
        case maximumValue
        case latestValue
        case sampleCount
        case sourceSampleKey
        case sourceObjectKey
        case measuredAtUtc
        case systolic
        case diastolic
        case pulse
        case valueMgDl
        case workoutType
        case startedAtUtc
        case endedAtUtc
        case durationSeconds
        case activeEnergyKcal
        case distanceMeters
        case averageHeartRateBpm
        case maximumHeartRateBpm
    }

    func encode(to encoder: Encoder) throws {
        var container = encoder.container(keyedBy: CodingKeys.self)
        switch self {
        case let .stepsHourUpsert(hourStartUtc, count):
            try container.encode("steps_hour_upsert", forKey: .kind)
            try container.encode(hourStartUtc, forKey: .hourStartUtc)
            try container.encode(count, forKey: .count)
        case let .stepsHourDelete(hourStartUtc):
            try container.encode("steps_hour_delete", forKey: .kind)
            try container.encode(hourStartUtc, forKey: .hourStartUtc)
        case let .sleepDayUpsert(sleepDay, totalMinutes, coreMinutes, deepMinutes, remMinutes, unspecifiedAsleepMinutes, awakeMinutes, inBedMinutes, wristTemperatureCelsius, breathingDisturbanceCount):
            try container.encode("sleep_day_upsert", forKey: .kind)
            try container.encode(sleepDay, forKey: .sleepDay)
            try container.encode(totalMinutes, forKey: .totalMinutes)
            try container.encode(coreMinutes, forKey: .coreMinutes)
            try container.encode(deepMinutes, forKey: .deepMinutes)
            try container.encode(remMinutes, forKey: .remMinutes)
            try container.encode(unspecifiedAsleepMinutes, forKey: .unspecifiedAsleepMinutes)
            try container.encode(awakeMinutes, forKey: .awakeMinutes)
            try container.encode(inBedMinutes, forKey: .inBedMinutes)
            try container.encodeIfPresent(wristTemperatureCelsius, forKey: .wristTemperatureCelsius)
            try container.encodeIfPresent(breathingDisturbanceCount, forKey: .breathingDisturbanceCount)
        case let .sleepDayDelete(sleepDay):
            try container.encode("sleep_day_delete", forKey: .kind)
            try container.encode(sleepDay, forKey: .sleepDay)
        case let .dailyMetricUpsert(healthMetric, localDay, sumValue, averageValue, minimumValue, maximumValue, latestValue, sampleCount):
            try container.encode("daily_metric_upsert", forKey: .kind)
            try container.encode(healthMetric.rawValue, forKey: .healthMetric)
            try container.encode(localDay, forKey: .localDay)
            try container.encodeIfPresent(sumValue, forKey: .sumValue)
            try container.encodeIfPresent(averageValue, forKey: .averageValue)
            try container.encodeIfPresent(minimumValue, forKey: .minimumValue)
            try container.encodeIfPresent(maximumValue, forKey: .maximumValue)
            try container.encodeIfPresent(latestValue, forKey: .latestValue)
            try container.encode(sampleCount, forKey: .sampleCount)
        case let .dailyMetricDelete(healthMetric, localDay):
            try container.encode("daily_metric_delete", forKey: .kind)
            try container.encode(healthMetric.rawValue, forKey: .healthMetric)
            try container.encode(localDay, forKey: .localDay)
        case let .bloodPressureUpsert(sourceObjectKey, measuredAtUtc, systolic, diastolic, pulse):
            try container.encode("blood_pressure_upsert", forKey: .kind)
            try container.encode(sourceObjectKey, forKey: .sourceObjectKey)
            try container.encode(measuredAtUtc, forKey: .measuredAtUtc)
            try container.encode(systolic, forKey: .systolic)
            try container.encode(diastolic, forKey: .diastolic)
            try container.encodeIfPresent(pulse, forKey: .pulse)
        case let .bloodPressureDelete(sourceObjectKey):
            try container.encode("blood_pressure_delete", forKey: .kind)
            try container.encode(sourceObjectKey, forKey: .sourceObjectKey)
        case let .bloodGlucoseUpsert(sourceSampleKey, measuredAtUtc, valueMgDl):
            try container.encode("blood_glucose_upsert", forKey: .kind)
            try container.encode(sourceSampleKey, forKey: .sourceSampleKey)
            try container.encode(measuredAtUtc, forKey: .measuredAtUtc)
            try container.encode(valueMgDl, forKey: .valueMgDl)
        case let .bloodGlucoseDelete(sourceSampleKey):
            try container.encode("blood_glucose_delete", forKey: .kind)
            try container.encode(sourceSampleKey, forKey: .sourceSampleKey)
        case let .workoutUpsert(sourceSampleKey, workoutType, startedAtUtc, endedAtUtc, durationSeconds, activeEnergyKcal, distanceMeters, averageHeartRateBpm, maximumHeartRateBpm):
            try container.encode("workout_upsert", forKey: .kind)
            try container.encode(sourceSampleKey, forKey: .sourceSampleKey)
            try container.encode(workoutType, forKey: .workoutType)
            try container.encode(startedAtUtc, forKey: .startedAtUtc)
            try container.encode(endedAtUtc, forKey: .endedAtUtc)
            try container.encode(durationSeconds, forKey: .durationSeconds)
            try container.encodeIfPresent(activeEnergyKcal, forKey: .activeEnergyKcal)
            try container.encodeIfPresent(distanceMeters, forKey: .distanceMeters)
            try container.encodeIfPresent(averageHeartRateBpm, forKey: .averageHeartRateBpm)
            try container.encodeIfPresent(maximumHeartRateBpm, forKey: .maximumHeartRateBpm)
        case let .workoutDelete(sourceSampleKey):
            try container.encode("workout_delete", forKey: .kind)
            try container.encode(sourceSampleKey, forKey: .sourceSampleKey)
        }
    }

    var metric: HealthKitSyncMetric {
        switch self {
        case .stepsHourUpsert, .stepsHourDelete:
            return .steps
        case .sleepDayUpsert, .sleepDayDelete:
            return .sleep
        case let .dailyMetricUpsert(healthMetric, _, _, _, _, _, _, _):
            return healthMetric.group
        case let .dailyMetricDelete(healthMetric, _):
            return healthMetric.group
        case .bloodPressureUpsert, .bloodPressureDelete:
            return .bloodPressure
        case .bloodGlucoseUpsert, .bloodGlucoseDelete:
            return .vitals
        case .workoutUpsert, .workoutDelete:
            return .workouts
        }
    }

    /// Stable sort key for deterministic repair chunking / resume.
    var stableKey: String {
        switch self {
        case let .stepsHourUpsert(hourStartUtc, _):
            return "steps:\(hourStartUtc)"
        case let .stepsHourDelete(hourStartUtc):
            return "steps_del:\(hourStartUtc)"
        case let .sleepDayUpsert(sleepDay, _, _, _, _, _, _, _, _, _):
            return "sleep:\(sleepDay)"
        case let .sleepDayDelete(sleepDay):
            return "sleep_del:\(sleepDay)"
        case let .dailyMetricUpsert(healthMetric, localDay, _, _, _, _, _, _):
            return "daily:\(healthMetric.rawValue):\(localDay)"
        case let .dailyMetricDelete(healthMetric, localDay):
            return "daily_delete:\(healthMetric.rawValue):\(localDay)"
        case let .bloodPressureUpsert(sourceObjectKey, _, _, _, _):
            return "bp_up:\(sourceObjectKey)"
        case let .bloodPressureDelete(sourceObjectKey):
            return "bp_del:\(sourceObjectKey)"
        case let .bloodGlucoseUpsert(sourceSampleKey, _, _):
            return "glucose_up:\(sourceSampleKey)"
        case let .bloodGlucoseDelete(sourceSampleKey):
            return "glucose_del:\(sourceSampleKey)"
        case let .workoutUpsert(sourceSampleKey, _, _, _, _, _, _, _, _):
            return "workout_up:\(sourceSampleKey)"
        case let .workoutDelete(sourceSampleKey):
            return "workout_del:\(sourceSampleKey)"
        }
    }
}

/// Server-issued bounds for one backfill session. Bucketed records use the
/// profile-local calendar range; instant records use the UTC instant range.
struct HealthKitBackfillWindow {
    let rangeStart: Date
    let rangeEnd: Date
    let rangeStartDay: String
    let rangeEndDay: String

    func includes(_ operation: HealthKitSyncOperation) -> Bool {
        switch operation {
        case let .stepsHourUpsert(hourStartUtc, _):
            return includesInstant(hourStartUtc)
        case let .sleepDayUpsert(sleepDay, _, _, _, _, _, _, _, _, _):
            return includesDay(sleepDay)
        case let .dailyMetricUpsert(_, localDay, _, _, _, _, _, _):
            return includesDay(localDay)
        case let .bloodPressureUpsert(_, measuredAtUtc, _, _, _),
             let .bloodGlucoseUpsert(_, measuredAtUtc, _):
            return includesInstant(measuredAtUtc)
        case let .workoutUpsert(_, _, startedAtUtc, _, _, _, _, _, _):
            return includesInstant(startedAtUtc)
        case .stepsHourDelete, .sleepDayDelete, .dailyMetricDelete,
             .bloodPressureDelete, .bloodGlucoseDelete, .workoutDelete:
            // A delete proves a previously observed source disappeared. The
            // API deliberately treats its time range as soft.
            return true
        }
    }

    private func includesDay(_ day: String) -> Bool {
        day >= rangeStartDay && day <= rangeEndDay
    }

    private func includesInstant(_ value: String) -> Bool {
        guard let instant = ISO8601DateFormatter().date(from: value) else { return false }
        return instant >= rangeStart && instant <= rangeEnd
    }
}

enum HealthKitConsent {
    /// Must match the server's accepted consent version for enabling metrics.
    static let version = "2026-07-25"
}
