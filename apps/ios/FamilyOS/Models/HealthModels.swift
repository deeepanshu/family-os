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
    let role: String
    let status: String
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
    let context: String
}
