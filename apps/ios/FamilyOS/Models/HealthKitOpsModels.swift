import Foundation

// MARK: - Wire types for POST /healthkit/ops:batch (correctness rewrite)

struct HealthKitOpsBatchRequest: Encodable, Sendable {
    let installationId: String
    let personId: String
    let timezoneVersion: Int
    let ops: [HealthKitSyncOpWire]
}

struct HealthKitSyncOpWire: Codable, Sendable {
    let opId: String
    let naturalKey: String
    let group: String
    let scopeKey: String
    let op: String
    let payload: HealthKitOpPayloadWire?
}

enum HealthKitOpPayloadWire: Codable, Sendable {
    struct WorkoutEvent: Codable, Sendable {
        let type: String
        let dateUtc: String
        let endDateUtc: String?
    }

    struct WorkoutActivity: Codable, Sendable {
        let workoutType: String
        let startedAtUtc: String
        let endedAtUtc: String
        let durationSeconds: Int
    }

    case bloodPressure(sourceObjectKey: String, measuredAtUtc: String, systolic: Int, diastolic: Int, pulse: Int?)
    case stepsHour(hourStartUtc: String, count: Int)
    case sleepDay(
        sleepDay: String,
        totalMinutes: Int,
        coreMinutes: Int,
        deepMinutes: Int,
        remMinutes: Int,
        unspecifiedAsleepMinutes: Int,
        awakeMinutes: Int,
        inBedMinutes: Int
    )
    case workout(
        sourceSampleKey: String,
        workoutType: String,
        startedAtUtc: String,
        endedAtUtc: String,
        durationSeconds: Int,
        activeEnergyKcal: Double?,
        distanceMeters: Double?,
        averageHeartRateBpm: Double?,
        maximumHeartRateBpm: Double?,
        minimumHeartRateBpm: Double?,
        sourceName: String?,
        sourceBundleId: String?,
        deviceName: String?,
        deviceManufacturer: String?,
        isIndoor: Bool?,
        elevationAscendedMeters: Double?,
        averageMETs: Double?,
        swimmingStrokeCount: Int?,
        totalFlightsClimbed: Int?,
        events: [WorkoutEvent]?,
        activities: [WorkoutActivity]?
    )
    case unknown

    private enum CodingKeys: String, CodingKey {
        case kind, sourceObjectKey, measuredAtUtc, systolic, diastolic, pulse
        case hourStartUtc, count
        case sleepDay, totalMinutes, coreMinutes, deepMinutes, remMinutes
        case unspecifiedAsleepMinutes, awakeMinutes, inBedMinutes
        case sourceSampleKey, workoutType, startedAtUtc, endedAtUtc, durationSeconds
        case activeEnergyKcal, distanceMeters, averageHeartRateBpm, maximumHeartRateBpm, minimumHeartRateBpm
        case sourceName, sourceBundleId, deviceName, deviceManufacturer, isIndoor
        case elevationAscendedMeters, averageMETs, swimmingStrokeCount, totalFlightsClimbed
        case events, activities
    }

    init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        let kind = try container.decode(String.self, forKey: .kind)
        switch kind {
        case "blood_pressure":
            self = .bloodPressure(
                sourceObjectKey: try container.decode(String.self, forKey: .sourceObjectKey),
                measuredAtUtc: try container.decode(String.self, forKey: .measuredAtUtc),
                systolic: try container.decode(Int.self, forKey: .systolic),
                diastolic: try container.decode(Int.self, forKey: .diastolic),
                pulse: try container.decodeIfPresent(Int.self, forKey: .pulse)
            )
        case "steps_hour":
            self = .stepsHour(
                hourStartUtc: try container.decode(String.self, forKey: .hourStartUtc),
                count: try container.decode(Int.self, forKey: .count)
            )
        case "sleep_day":
            self = .sleepDay(
                sleepDay: try container.decode(String.self, forKey: .sleepDay),
                totalMinutes: try container.decode(Int.self, forKey: .totalMinutes),
                coreMinutes: try container.decode(Int.self, forKey: .coreMinutes),
                deepMinutes: try container.decode(Int.self, forKey: .deepMinutes),
                remMinutes: try container.decode(Int.self, forKey: .remMinutes),
                unspecifiedAsleepMinutes: try container.decode(Int.self, forKey: .unspecifiedAsleepMinutes),
                awakeMinutes: try container.decode(Int.self, forKey: .awakeMinutes),
                inBedMinutes: try container.decode(Int.self, forKey: .inBedMinutes)
            )
        case "workout":
            self = .workout(
                sourceSampleKey: try container.decode(String.self, forKey: .sourceSampleKey),
                workoutType: try container.decode(String.self, forKey: .workoutType),
                startedAtUtc: try container.decode(String.self, forKey: .startedAtUtc),
                endedAtUtc: try container.decode(String.self, forKey: .endedAtUtc),
                durationSeconds: try container.decode(Int.self, forKey: .durationSeconds),
                activeEnergyKcal: try container.decodeIfPresent(Double.self, forKey: .activeEnergyKcal),
                distanceMeters: try container.decodeIfPresent(Double.self, forKey: .distanceMeters),
                averageHeartRateBpm: try container.decodeIfPresent(Double.self, forKey: .averageHeartRateBpm),
                maximumHeartRateBpm: try container.decodeIfPresent(Double.self, forKey: .maximumHeartRateBpm),
                minimumHeartRateBpm: try container.decodeIfPresent(Double.self, forKey: .minimumHeartRateBpm),
                sourceName: try container.decodeIfPresent(String.self, forKey: .sourceName),
                sourceBundleId: try container.decodeIfPresent(String.self, forKey: .sourceBundleId),
                deviceName: try container.decodeIfPresent(String.self, forKey: .deviceName),
                deviceManufacturer: try container.decodeIfPresent(String.self, forKey: .deviceManufacturer),
                isIndoor: try container.decodeIfPresent(Bool.self, forKey: .isIndoor),
                elevationAscendedMeters: try container.decodeIfPresent(Double.self, forKey: .elevationAscendedMeters),
                averageMETs: try container.decodeIfPresent(Double.self, forKey: .averageMETs),
                swimmingStrokeCount: try container.decodeIfPresent(Int.self, forKey: .swimmingStrokeCount),
                totalFlightsClimbed: try container.decodeIfPresent(Int.self, forKey: .totalFlightsClimbed),
                events: try container.decodeIfPresent([WorkoutEvent].self, forKey: .events),
                activities: try container.decodeIfPresent([WorkoutActivity].self, forKey: .activities)
            )
        default:
            self = .unknown
        }
    }

    func encode(to encoder: Encoder) throws {
        var container = encoder.container(keyedBy: CodingKeys.self)
        switch self {
        case let .bloodPressure(sourceObjectKey, measuredAtUtc, systolic, diastolic, pulse):
            try container.encode("blood_pressure", forKey: .kind)
            try container.encode(sourceObjectKey, forKey: .sourceObjectKey)
            try container.encode(measuredAtUtc, forKey: .measuredAtUtc)
            try container.encode(systolic, forKey: .systolic)
            try container.encode(diastolic, forKey: .diastolic)
            try container.encodeIfPresent(pulse, forKey: .pulse)
        case let .stepsHour(hourStartUtc, count):
            try container.encode("steps_hour", forKey: .kind)
            try container.encode(hourStartUtc, forKey: .hourStartUtc)
            try container.encode(count, forKey: .count)
        case let .sleepDay(
            sleepDay, totalMinutes, coreMinutes, deepMinutes, remMinutes,
            unspecifiedAsleepMinutes, awakeMinutes, inBedMinutes
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
        case let .workout(
            sourceSampleKey, workoutType, startedAtUtc, endedAtUtc, durationSeconds,
            activeEnergyKcal, distanceMeters, averageHeartRateBpm, maximumHeartRateBpm, minimumHeartRateBpm,
            sourceName, sourceBundleId, deviceName, deviceManufacturer, isIndoor,
            elevationAscendedMeters, averageMETs, swimmingStrokeCount, totalFlightsClimbed,
            events, activities
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
            try container.encodeIfPresent(minimumHeartRateBpm, forKey: .minimumHeartRateBpm)
            try container.encodeIfPresent(sourceName, forKey: .sourceName)
            try container.encodeIfPresent(sourceBundleId, forKey: .sourceBundleId)
            try container.encodeIfPresent(deviceName, forKey: .deviceName)
            try container.encodeIfPresent(deviceManufacturer, forKey: .deviceManufacturer)
            try container.encodeIfPresent(isIndoor, forKey: .isIndoor)
            try container.encodeIfPresent(elevationAscendedMeters, forKey: .elevationAscendedMeters)
            try container.encodeIfPresent(averageMETs, forKey: .averageMETs)
            try container.encodeIfPresent(swimmingStrokeCount, forKey: .swimmingStrokeCount)
            try container.encodeIfPresent(totalFlightsClimbed, forKey: .totalFlightsClimbed)
            try container.encodeIfPresent(events, forKey: .events)
            try container.encodeIfPresent(activities, forKey: .activities)
        case .unknown:
            throw EncodingError.invalidValue(
                self,
                EncodingError.Context(codingPath: encoder.codingPath, debugDescription: "Cannot encode unknown payload")
            )
        }
    }
}

struct HealthKitOpsBatchResult: Decodable, Sendable {
    let results: [HealthKitOpApplyResultWire]
}

struct HealthKitOpApplyResultWire: Decodable, Sendable {
    let opId: String
    let result: String
    let errorCode: String?
    let errorMessage: String?
}

struct HealthKitGroupActionRequest: Encodable, Sendable {
    let installationId: String
    let personId: String
    let timezoneVersion: Int
    let coverageStartAt: String?
    let coverageEndAt: String?

    init(
        installationId: String,
        personId: String,
        timezoneVersion: Int,
        coverageStartAt: String? = nil,
        coverageEndAt: String? = nil
    ) {
        self.installationId = installationId
        self.personId = personId
        self.timezoneVersion = timezoneVersion
        self.coverageStartAt = coverageStartAt
        self.coverageEndAt = coverageEndAt
    }
}

struct HealthKitGroupImportStartResult: Decodable, Sendable {
    let group: String
    let status: String
    let coverageStartAt: String
    let coverageEndAt: String
}

struct HealthKitGroupReadyResult: Decodable, Sendable {
    let group: String
    let status: String
    let coverageStartAt: String?
    let coverageEndAt: String?
}
