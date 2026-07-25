import Foundation

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
    let family: Family
    let membership: FamilyMembership
    let profiles: [HealthProfile]
    let selfProfile: HealthProfile?
    let needsProfileSetup: Bool
}

struct FamilyResponse: Decodable {
    let family: Family
    let membership: FamilyMembership
}

struct Family: Decodable {
    let id: String
    let name: String
    let kind: FamilyKind
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
}

struct BloodGlucoseReading: Decodable, Identifiable {
    let id: String
    let value: Double
    let context: GlucoseContext
    let source: HealthDataSource
}

enum HealthDataSource: String, Codable {
    case manual
    case healthkit

    var displayName: String {
        switch self {
        case .manual:
            return "Manual"
        case .healthkit:
            return "HealthKit"
        }
    }
}

enum GlucoseContext: String, Codable, CaseIterable, Identifiable {
    case fasting
    case beforeMeal = "before_meal"
    case afterMeal = "after_meal"
    case bedtime
    case random

    var id: String { rawValue }

    var displayName: String {
        switch self {
        case .fasting:
            return "Fasting"
        case .beforeMeal:
            return "Before meal"
        case .afterMeal:
            return "After meal"
        case .bedtime:
            return "Bedtime"
        case .random:
            return "Random"
        }
    }
}

enum HealthKitSyncMetric: String, Codable, CaseIterable, Identifiable {
    case steps
    case sleep
    case bloodPressure = "blood_pressure"

    var id: String { rawValue }

    var displayName: String {
        switch self {
        case .steps:
            return "Steps"
        case .sleep:
            return "Sleep"
        case .bloodPressure:
            return "Blood pressure"
        }
    }
}

/// Matches frozen API `HealthMetricSyncStatusCode`.
enum HealthKitMetricSyncStatus: String, Codable {
    case neverSynced = "never_synced"
    case ready
    case repairing
    case repairNeeded = "repair_needed"
    case error
    case disabled

    var displayName: String {
        switch self {
        case .neverSynced:
            return "Not started"
        case .ready:
            return "Ready"
        case .repairing:
            return "Repairing"
        case .repairNeeded:
            return "Repair needed"
        case .error:
            return "Error"
        case .disabled:
            return "Disabled"
        }
    }
}

struct HealthKitMetricState: Decodable, Identifiable {
    var id: String { metric.rawValue }

    let metric: HealthKitSyncMetric
    let enabled: Bool
    let status: HealthKitMetricSyncStatus
    let lastSuccessfulAt: String?
    let lastAttemptAt: String?
    let lastErrorCode: String?
    let coverageStartAt: String?
    let coverageEndAt: String?
}

/// Matches frozen API `HealthKitSettings` from GET/PUT `/healthkit/settings`.
struct HealthKitSyncStatus: Decodable {
    let personId: String
    let consentVersion: String?
    let consentedAt: String?
    let healthTimezone: String
    let healthTimezoneVersion: Int
    let enabledMetrics: [HealthKitSyncMetric]
    let activeInstallationId: String?
    let metrics: [HealthKitMetricState]

    var consentActive: Bool {
        consentVersion != nil && consentedAt != nil && !enabledMetrics.isEmpty
    }
}

struct HealthKitSyncResult: Decodable {
    let syncId: String
    let accepted: Bool
    let operationCount: Int
    let metricsAffected: [HealthKitSyncMetric]
    let repairId: String?
    let chunkIndex: Int?
}

struct HealthKitRepair: Decodable {
    let repairId: String
    let personId: String
    let metric: HealthKitSyncMetric
    let installationId: String
    let timezoneVersion: Int
    let rangeStart: String
    let rangeEnd: String
    let rangeStartDay: String
    let rangeEndDay: String
    let expiresAt: String
}

struct HealthKitRepairCompleteResult: Decodable {
    let repairId: String
    let metric: HealthKitSyncMetric
    let completed: Bool
    let expectedChunkCount: Int
    let completedChunkCount: Int
}

enum HealthKitSyncOperation: Encodable {
    case stepsHourUpsert(hourStartUtc: String, count: Int)
    case sleepDayUpsert(sleepDay: String, durationMinutes: Int)
    case bloodPressureUpsert(sourceSampleKey: String, measuredAtUtc: String, systolic: Int, diastolic: Int, pulse: Int?)
    case bloodPressureDelete(sourceSampleKey: String)

    private enum CodingKeys: String, CodingKey {
        case kind
        case hourStartUtc
        case count
        case sleepDay
        case durationMinutes
        case sourceSampleKey
        case measuredAtUtc
        case systolic
        case diastolic
        case pulse
    }

    func encode(to encoder: Encoder) throws {
        var container = encoder.container(keyedBy: CodingKeys.self)
        switch self {
        case let .stepsHourUpsert(hourStartUtc, count):
            try container.encode("steps_hour_upsert", forKey: .kind)
            try container.encode(hourStartUtc, forKey: .hourStartUtc)
            try container.encode(count, forKey: .count)
        case let .sleepDayUpsert(sleepDay, durationMinutes):
            try container.encode("sleep_day_upsert", forKey: .kind)
            try container.encode(sleepDay, forKey: .sleepDay)
            try container.encode(durationMinutes, forKey: .durationMinutes)
        case let .bloodPressureUpsert(sourceSampleKey, measuredAtUtc, systolic, diastolic, pulse):
            try container.encode("blood_pressure_upsert", forKey: .kind)
            try container.encode(sourceSampleKey, forKey: .sourceSampleKey)
            try container.encode(measuredAtUtc, forKey: .measuredAtUtc)
            try container.encode(systolic, forKey: .systolic)
            try container.encode(diastolic, forKey: .diastolic)
            try container.encodeIfPresent(pulse, forKey: .pulse)
        case let .bloodPressureDelete(sourceSampleKey):
            try container.encode("blood_pressure_delete", forKey: .kind)
            try container.encode(sourceSampleKey, forKey: .sourceSampleKey)
        }
    }

    var metric: HealthKitSyncMetric {
        switch self {
        case .stepsHourUpsert:
            return .steps
        case .sleepDayUpsert:
            return .sleep
        case .bloodPressureUpsert, .bloodPressureDelete:
            return .bloodPressure
        }
    }

    /// Stable sort key for deterministic repair chunking / resume.
    var stableKey: String {
        switch self {
        case let .stepsHourUpsert(hourStartUtc, _):
            return "steps:\(hourStartUtc)"
        case let .sleepDayUpsert(sleepDay, _):
            return "sleep:\(sleepDay)"
        case let .bloodPressureUpsert(sourceSampleKey, _, _, _, _):
            return "bp_up:\(sourceSampleKey)"
        case let .bloodPressureDelete(sourceSampleKey):
            return "bp_del:\(sourceSampleKey)"
        }
    }
}

enum HealthKitConsent {
    /// Must match the server's accepted consent version for enabling metrics.
    static let version = "2026-07-25"
}
