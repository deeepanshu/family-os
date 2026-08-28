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

enum SignInWithAppleDisplayName {
    static func fromPersonName(_ name: PersonNameComponents?) -> String? {
        guard let name else { return nil }
        let formatter = PersonNameComponentsFormatter()
        formatter.style = .default
        let formatted = formatter.string(from: name)
            .trimmingCharacters(in: .whitespacesAndNewlines)
        return formatted.isEmpty ? nil : formatted
    }

    static func emailLocalPart(_ email: String?) -> String? {
        guard let email else { return nil }
        let trimmed = email.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return nil }
        let local = trimmed.split(separator: "@", maxSplits: 1, omittingEmptySubsequences: true)
            .first
            .map(String.init) ?? trimmed
        let cleaned = local.trimmingCharacters(in: .whitespacesAndNewlines)
        return cleaned.isEmpty ? nil : cleaned
    }
}

enum AccessTokenExpiry {
    static func requiresRefresh(_ token: String, within interval: TimeInterval = 60, now: Date = .now) -> Bool {
        let parts = token.split(separator: ".", omittingEmptySubsequences: false)
        guard parts.count == 3 else {
            // Local development tokens are not JWTs and must not be sent to Supabase refresh.
            return false
        }

        let payloadPart = String(parts[1])
        let paddedLength = ((payloadPart.count + 3) / 4) * 4
        let paddedPayload = payloadPart
            .replacingOccurrences(of: "-", with: "+")
            .replacingOccurrences(of: "_", with: "/")
            .padding(toLength: paddedLength, withPad: "=", startingAt: 0)

        guard let data = Data(base64Encoded: paddedPayload),
              let payload = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              let expiration = (payload["exp"] as? NSNumber)?.doubleValue
        else {
            // A JWT without a readable expiry is not safe to keep using.
            return true
        }

        return Date(timeIntervalSince1970: expiration) <= now.addingTimeInterval(interval)
    }
}
