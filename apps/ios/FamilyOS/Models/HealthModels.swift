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
    let displayName: String
    let relationshipLabel: String?
}

struct BloodPressureReading: Decodable, Identifiable {
    let id: String
    let systolic: Int
    let diastolic: Int
    let pulse: Int?
}

struct BloodGlucoseReading: Decodable, Identifiable {
    let id: String
    let value: Double
    let context: GlucoseContext
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
