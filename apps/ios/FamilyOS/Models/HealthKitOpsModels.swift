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
    case bloodPressure(sourceObjectKey: String, measuredAtUtc: String, systolic: Int, diastolic: Int, pulse: Int?)
    case stepsHour(hourStartUtc: String, count: Int)
    case unknown

    private enum CodingKeys: String, CodingKey {
        case kind, sourceObjectKey, measuredAtUtc, systolic, diastolic, pulse
        case hourStartUtc, count
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
