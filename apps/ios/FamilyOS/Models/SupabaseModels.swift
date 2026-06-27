import Foundation

struct SupabaseSession: Codable {
    let accessToken: String
    let refreshToken: String?
    let expiresIn: Int?
    let tokenType: String?
    let user: SupabaseUser?
}

struct SupabaseUser: Codable {
    let id: String
    let email: String?
}

struct AppleSignInNonce {
    let raw: String
    let sha256: String
}
