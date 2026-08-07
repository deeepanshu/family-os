import Foundation
import HealthKit

/// All-type workout import: fat summary (A) + events (B) + multi-sport activities (C).
/// No GPS routes or per-second metric series.
enum HealthKitWorkoutSync {
    static let backfillWindowDays = 90

    struct WorkoutSample: Sendable {
        let sourceSampleKey: String
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
        let sourceBundleId: String?
        let deviceName: String?
        let deviceManufacturer: String?
        let isIndoor: Bool?
        let elevationAscendedMeters: Double?
        let averageMETs: Double?
        let swimmingStrokeCount: Int?
        let totalFlightsClimbed: Int?
        let events: [WorkoutEventWire]?
        let activities: [WorkoutActivityWire]?
    }

    struct WorkoutEventWire: Sendable, Codable {
        let type: String
        let dateUtc: String
        let endDateUtc: String?
    }

    struct WorkoutActivityWire: Sendable, Codable {
        let workoutType: String
        let startedAtUtc: String
        let endedAtUtc: String
        let durationSeconds: Int
    }

    static func fetchWorkouts(
        store: HKHealthStore = HKHealthStore(),
        now: Date = Date()
    ) async throws -> [WorkoutSample] {
        #if DEBUG
        if ProcessInfo.processInfo.arguments.contains("-FamilyOSLocalSmoke") {
            CrashReporting.log("healthkit_workout_fetch_skipped_for_local_smoke")
            return []
        }
        #endif

        let start = Calendar.current.date(byAdding: .day, value: -backfillWindowDays, to: now) ?? now
        let predicate = HKQuery.predicateForSamples(withStart: start, end: now, options: .strictStartDate)
        let workouts: [HKWorkout] = try await querySamples(
            store: store,
            sampleType: HKObjectType.workoutType(),
            predicate: predicate
        )
        CrashReporting.log("healthkit_workout_raw_count=\(workouts.count)")

        let iso = makeISOFormatter()
        var results: [WorkoutSample] = []
        results.reserveCapacity(workouts.count)

        for workout in workouts {
            let durationSeconds = max(0, Int(workout.duration.rounded()))
            guard durationSeconds >= 0, workout.endDate >= workout.startDate else { continue }

            let energy = energyKcal(from: workout)
            let distance = distanceMeters(from: workout)
            let hr = heartRateStats(from: workout)
            let events = mapEvents(workout.workoutEvents, iso: iso)
            let activities = mapActivities(workout, iso: iso)

            var isIndoor: Bool?
            if let indoor = workout.metadata?[HKMetadataKeyIndoorWorkout] as? Bool {
                isIndoor = indoor
            } else if let num = workout.metadata?[HKMetadataKeyIndoorWorkout] as? NSNumber {
                isIndoor = num.boolValue
            }

            var elevation: Double?
            if let qty = workout.metadata?[HKMetadataKeyElevationAscended] as? HKQuantity {
                elevation = qty.doubleValue(for: .meter())
            }

            var mets: Double?
            if let qty = workout.metadata?[HKMetadataKeyAverageMETs] as? HKQuantity {
                // METs are unitless relative energy; Apple uses kcal/(kg*hr) style unit.
                mets = qty.doubleValue(for: HKUnit(from: "kcal/kg*hr"))
            }

            var strokes: Int?
            if let type = HKQuantityType.quantityType(forIdentifier: .swimmingStrokeCount),
               let qty = workout.statistics(for: type)?.sumQuantity() {
                strokes = Int(qty.doubleValue(for: .count()).rounded())
            }

            var flights: Int?
            if let type = HKQuantityType.quantityType(forIdentifier: .flightsClimbed),
               let qty = workout.statistics(for: type)?.sumQuantity() {
                flights = Int(qty.doubleValue(for: .count()).rounded())
            }

            results.append(
                WorkoutSample(
                    sourceSampleKey: workout.uuid.uuidString.lowercased(),
                    workoutType: activityTypeString(workout.workoutActivityType),
                    startedAtUtc: isoString(workout.startDate, iso: iso),
                    endedAtUtc: isoString(workout.endDate, iso: iso),
                    durationSeconds: durationSeconds,
                    activeEnergyKcal: energy,
                    distanceMeters: distance,
                    averageHeartRateBpm: hr.avg,
                    maximumHeartRateBpm: hr.max,
                    minimumHeartRateBpm: hr.min,
                    sourceName: nonEmpty(workout.sourceRevision.source.name),
                    sourceBundleId: nonEmpty(workout.sourceRevision.source.bundleIdentifier),
                    deviceName: nonEmpty(workout.device?.name),
                    deviceManufacturer: nonEmpty(workout.device?.manufacturer),
                    isIndoor: isIndoor,
                    elevationAscendedMeters: elevation,
                    averageMETs: mets,
                    swimmingStrokeCount: strokes,
                    totalFlightsClimbed: flights,
                    events: events.isEmpty ? nil : events,
                    activities: activities.isEmpty ? nil : activities
                )
            )
        }

        CrashReporting.log("healthkit_workout_mapped_count=\(results.count)")
        return results
    }

    static func enqueueSamples(_ samples: [WorkoutSample], into syncStore: HealthKitSyncStore) throws {
        let encoder = JSONEncoder()
        for sample in samples {
            let payload = HealthKitOpPayloadWire.workout(
                sourceSampleKey: sample.sourceSampleKey,
                workoutType: sample.workoutType,
                startedAtUtc: sample.startedAtUtc,
                endedAtUtc: sample.endedAtUtc,
                durationSeconds: sample.durationSeconds,
                activeEnergyKcal: sample.activeEnergyKcal,
                distanceMeters: sample.distanceMeters,
                averageHeartRateBpm: sample.averageHeartRateBpm,
                maximumHeartRateBpm: sample.maximumHeartRateBpm,
                minimumHeartRateBpm: sample.minimumHeartRateBpm,
                sourceName: sample.sourceName,
                sourceBundleId: sample.sourceBundleId,
                deviceName: sample.deviceName,
                deviceManufacturer: sample.deviceManufacturer,
                isIndoor: sample.isIndoor,
                elevationAscendedMeters: sample.elevationAscendedMeters,
                averageMETs: sample.averageMETs,
                swimmingStrokeCount: sample.swimmingStrokeCount,
                totalFlightsClimbed: sample.totalFlightsClimbed,
                events: sample.events?.map {
                    HealthKitOpPayloadWire.WorkoutEvent(type: $0.type, dateUtc: $0.dateUtc, endDateUtc: $0.endDateUtc)
                },
                activities: sample.activities?.map {
                    HealthKitOpPayloadWire.WorkoutActivity(
                        workoutType: $0.workoutType,
                        startedAtUtc: $0.startedAtUtc,
                        endedAtUtc: $0.endedAtUtc,
                        durationSeconds: $0.durationSeconds
                    )
                }
            )
            let data = try encoder.encode(payload)
            let json = String(data: data, encoding: .utf8)
            try syncStore.enqueue(
                op: PendingOpRecord(
                    opId: UUID().uuidString.lowercased(),
                    naturalKey: "workout:\(sample.sourceSampleKey)",
                    groupKey: "workouts",
                    scopeKey: "workout",
                    op: "upsert",
                    payloadJSON: json
                )
            )
        }
    }

    // MARK: - Mapping

    static func activityTypeString(_ type: HKWorkoutActivityType) -> String {
        switch type {
        case .americanFootball: return "american_football"
        case .archery: return "archery"
        case .australianFootball: return "australian_football"
        case .badminton: return "badminton"
        case .baseball: return "baseball"
        case .basketball: return "basketball"
        case .bowling: return "bowling"
        case .boxing: return "boxing"
        case .climbing: return "climbing"
        case .cricket: return "cricket"
        case .crossTraining: return "cross_training"
        case .curling: return "curling"
        case .cycling: return "cycling"
        case .dance: return "dance"
        case .danceInspiredTraining: return "dance_inspired_training"
        case .elliptical: return "elliptical"
        case .equestrianSports: return "equestrian_sports"
        case .fencing: return "fencing"
        case .fishing: return "fishing"
        case .functionalStrengthTraining: return "functional_strength_training"
        case .golf: return "golf"
        case .gymnastics: return "gymnastics"
        case .handball: return "handball"
        case .hiking: return "hiking"
        case .hockey: return "hockey"
        case .hunting: return "hunting"
        case .lacrosse: return "lacrosse"
        case .martialArts: return "martial_arts"
        case .mindAndBody: return "mind_and_body"
        case .mixedMetabolicCardioTraining: return "mixed_metabolic_cardio_training"
        case .paddleSports: return "paddle_sports"
        case .play: return "play"
        case .preparationAndRecovery: return "preparation_and_recovery"
        case .racquetball: return "racquetball"
        case .rowing: return "rowing"
        case .rugby: return "rugby"
        case .running: return "running"
        case .sailing: return "sailing"
        case .skatingSports: return "skating_sports"
        case .snowSports: return "snow_sports"
        case .soccer: return "soccer"
        case .softball: return "softball"
        case .squash: return "squash"
        case .stairClimbing: return "stair_climbing"
        case .surfingSports: return "surfing_sports"
        case .swimming: return "swimming"
        case .tableTennis: return "table_tennis"
        case .tennis: return "tennis"
        case .trackAndField: return "track_and_field"
        case .traditionalStrengthTraining: return "traditional_strength_training"
        case .volleyball: return "volleyball"
        case .walking: return "walking"
        case .waterFitness: return "water_fitness"
        case .waterPolo: return "water_polo"
        case .waterSports: return "water_sports"
        case .wrestling: return "wrestling"
        case .yoga: return "yoga"
        case .barre: return "barre"
        case .coreTraining: return "core_training"
        case .crossCountrySkiing: return "cross_country_skiing"
        case .downhillSkiing: return "downhill_skiing"
        case .flexibility: return "flexibility"
        case .highIntensityIntervalTraining: return "high_intensity_interval_training"
        case .jumpRope: return "jump_rope"
        case .kickboxing: return "kickboxing"
        case .pilates: return "pilates"
        case .snowboarding: return "snowboarding"
        case .stairs: return "stairs"
        case .stepTraining: return "step_training"
        case .wheelchairWalkPace: return "wheelchair_walk_pace"
        case .wheelchairRunPace: return "wheelchair_run_pace"
        case .taiChi: return "tai_chi"
        case .mixedCardio: return "mixed_cardio"
        case .handCycling: return "hand_cycling"
        case .discSports: return "disc_sports"
        case .fitnessGaming: return "fitness_gaming"
        case .cardioDance: return "cardio_dance"
        case .socialDance: return "social_dance"
        case .pickleball: return "pickleball"
        case .cooldown: return "cooldown"
        case .swimBikeRun: return "swim_bike_run"
        case .transition: return "transition"
        case .underwaterDiving: return "underwater_diving"
        case .other: return "other"
        @unknown default: return "other"
        }
    }

    // MARK: - Private

    private static func energyKcal(from workout: HKWorkout) -> Double? {
        if let type = HKQuantityType.quantityType(forIdentifier: .activeEnergyBurned),
           let qty = workout.statistics(for: type)?.sumQuantity() {
            return qty.doubleValue(for: .kilocalorie())
        }
        if let qty = workout.totalEnergyBurned {
            return qty.doubleValue(for: .kilocalorie())
        }
        return nil
    }

    private static func distanceMeters(from workout: HKWorkout) -> Double? {
        let candidates: [HKQuantityTypeIdentifier] = [
            .distanceWalkingRunning,
            .distanceCycling,
            .distanceSwimming,
            .distanceWheelchair,
            .distanceDownhillSnowSports
        ]
        for id in candidates {
            if let type = HKQuantityType.quantityType(forIdentifier: id),
               let qty = workout.statistics(for: type)?.sumQuantity() {
                return qty.doubleValue(for: .meter())
            }
        }
        if let qty = workout.totalDistance {
            return qty.doubleValue(for: .meter())
        }
        return nil
    }

    private static func heartRateStats(from workout: HKWorkout) -> (avg: Double?, max: Double?, min: Double?) {
        guard let hrType = HKQuantityType.quantityType(forIdentifier: .heartRate),
              let stats = workout.statistics(for: hrType) else {
            return (nil, nil, nil)
        }
        let unit = HKUnit.count().unitDivided(by: .minute())
        let avg = stats.averageQuantity()?.doubleValue(for: unit)
        let max = stats.maximumQuantity()?.doubleValue(for: unit)
        let min = stats.minimumQuantity()?.doubleValue(for: unit)
        return (avg, max, min)
    }

    private static func mapEvents(_ events: [HKWorkoutEvent]?, iso: ISO8601DateFormatter) -> [WorkoutEventWire] {
        guard let events, !events.isEmpty else { return [] }
        return events.map { event in
            let type: String
            switch event.type {
            case .pause: type = "pause"
            case .resume: type = "resume"
            case .lap: type = "lap"
            case .marker: type = "marker"
            case .motionPaused: type = "motion_paused"
            case .motionResumed: type = "motion_resumed"
            case .segment: type = "segment"
            case .pauseOrResumeRequest: type = "pause_or_resume_request"
            @unknown default: type = "other"
            }
            let interval = event.dateInterval
            let endDateUtc: String? = interval.duration > 0 ? isoString(interval.end, iso: iso) : nil
            return WorkoutEventWire(
                type: type,
                dateUtc: isoString(interval.start, iso: iso),
                endDateUtc: endDateUtc
            )
        }
    }

    private static func mapActivities(_ workout: HKWorkout, iso: ISO8601DateFormatter) -> [WorkoutActivityWire] {
        let activities = workout.workoutActivities
        guard !activities.isEmpty else { return [] }
        return activities.map { activity in
            let start = activity.startDate
            let end = activity.endDate ?? activity.startDate
            let seconds = max(0, Int(end.timeIntervalSince(start).rounded()))
            return WorkoutActivityWire(
                workoutType: activityTypeString(activity.workoutConfiguration.activityType),
                startedAtUtc: isoString(start, iso: iso),
                endedAtUtc: isoString(end, iso: iso),
                durationSeconds: seconds
            )
        }
    }

    private static func querySamples<T: HKSample>(
        store: HKHealthStore,
        sampleType: HKSampleType,
        predicate: NSPredicate
    ) async throws -> [T] {
        try await withCheckedThrowingContinuation { continuation in
            let query = HKSampleQuery(
                sampleType: sampleType,
                predicate: predicate,
                limit: HKObjectQueryNoLimit,
                sortDescriptors: [NSSortDescriptor(key: HKSampleSortIdentifierStartDate, ascending: true)]
            ) { _, samples, error in
                if let error {
                    continuation.resume(throwing: error)
                    return
                }
                continuation.resume(returning: (samples as? [T]) ?? [])
            }
            store.execute(query)
        }
    }

    private static func makeISOFormatter() -> ISO8601DateFormatter {
        let iso = ISO8601DateFormatter()
        iso.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return iso
    }

    private static func isoString(_ date: Date, iso: ISO8601DateFormatter) -> String {
        var s = iso.string(from: date)
        if s.isEmpty {
            let fallback = ISO8601DateFormatter()
            fallback.formatOptions = [.withInternetDateTime]
            s = fallback.string(from: date)
        }
        return s
    }

    private static func nonEmpty(_ value: String?) -> String? {
        guard let value else { return nil }
        let trimmed = value.trimmingCharacters(in: .whitespacesAndNewlines)
        return trimmed.isEmpty ? nil : trimmed
    }
}
