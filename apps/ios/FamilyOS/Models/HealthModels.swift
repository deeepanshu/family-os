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

struct FamilyResponse: Decodable {
    let family: Family
    let membership: FamilyMembership
}

struct Family: Decodable {
    let id: String
    let name: String
}

struct FamilyMembership: Decodable {
    let role: FamilyRole
    let status: MembershipStatus
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

enum HealthKitMetricType: String, Codable, CaseIterable, Identifiable {
    case steps
    case walkingDistance = "walking_distance"
    case sleep
    case weight
    case bloodPressure = "blood_pressure"
    case bloodGlucose = "blood_glucose"

    var id: String { rawValue }

    var displayName: String {
        switch self {
        case .steps:
            return "Steps"
        case .walkingDistance:
            return "Walking distance"
        case .sleep:
            return "Sleep"
        case .weight:
            return "Weight"
        case .bloodPressure:
            return "Blood pressure"
        case .bloodGlucose:
            return "Blood sugar"
        }
    }
}

struct HealthKitSyncStatus: Decodable {
    let linkedProfileId: String?
    let enabledMetrics: [HealthKitMetricType]
    let lastSync: HealthKitLastSync?
}

struct HealthKitLastSync: Decodable {
    let id: String
    let status: String
    let startedAt: String
    let finishedAt: String
    let importedCount: Int
    let skippedCount: Int
    let failedCount: Int
}

struct HealthKitImportResult: Decodable {
    let syncRunId: String
    let importedCount: Int
    let skippedCount: Int
    let failedCount: Int
}

struct HealthKitSampleInput: Encodable {
    let metricType: HealthKitMetricType
    let sourceSampleKey: String
    let startDate: String
    let endDate: String?
    let value: Double?
    let unit: String?
    let systolic: Int?
    let diastolic: Int?
    let pulse: Int?
    let glucoseContext: GlucoseContext?
}

struct HealthMetricDailySummary: Decodable, Identifiable {
    let id: String
    let metricType: HealthKitMetricType
    let date: String
    let value: Double
    let unit: String
    let sampleCount: Int
}
