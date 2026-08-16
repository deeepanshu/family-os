import AuthenticationServices
import CryptoKit
import Foundation
import Security

enum SupabaseAuthError: LocalizedError {
    case missingConfiguration
    case missingAppleIdentityToken
    case invalidAppleIdentityToken
    case invalidSupabaseURL
    case badStatus(Int, String?)
    case requestFailed(String)

    var errorDescription: String? {
        switch self {
        case .missingConfiguration:
            return "Enter the Supabase URL and anon key first."
        case .missingAppleIdentityToken:
            return "Apple did not return an identity token."
        case .invalidAppleIdentityToken:
            return "Apple returned an identity token that could not be read."
        case .invalidSupabaseURL:
            return "The Supabase URL is invalid."
        case .badStatus(let status, let message):
            return message.map { "Supabase Auth returned HTTP \(status): \($0)" } ?? "Supabase Auth returned HTTP \(status)."
        case .requestFailed(let message):
            return message
        }
    }
}

struct SupabaseAuthClient {
    let session: URLSession

    init(session: URLSession = .shared) {
        self.session = session
    }

    func makeAppleNonce() throws -> AppleSignInNonce {
        let raw = try randomNonceString()
        return AppleSignInNonce(raw: raw, sha256: sha256(raw))
    }

    func exchangeAppleCredential(
        supabaseURL: String,
        anonKey: String,
        authorization: ASAuthorization,
        rawNonce: String
    ) async throws -> SupabaseSession {
        guard !supabaseURL.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty,
              !anonKey.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else {
            throw SupabaseAuthError.missingConfiguration
        }
        guard let credential = authorization.credential as? ASAuthorizationAppleIDCredential else {
            throw SupabaseAuthError.requestFailed("Apple returned an unsupported credential.")
        }
        guard let identityToken = credential.identityToken else {
            throw SupabaseAuthError.missingAppleIdentityToken
        }
        guard let idToken = String(data: identityToken, encoding: .utf8) else {
            throw SupabaseAuthError.invalidAppleIdentityToken
        }

        let body = SignInWithIdTokenRequest(provider: "apple", idToken: idToken, nonce: rawNonce)
        return try await tokenRequest(
            supabaseURL: supabaseURL,
            anonKey: anonKey,
            grantType: "id_token",
            body: body
        )
    }

    func refreshSession(supabaseURL: String, anonKey: String, refreshToken: String) async throws -> SupabaseSession {
        guard !refreshToken.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else {
            throw SupabaseAuthError.requestFailed("No refresh token is available.")
        }
        let body = RefreshTokenRequest(refreshToken: refreshToken)
        return try await tokenRequest(
            supabaseURL: supabaseURL,
            anonKey: anonKey,
            grantType: "refresh_token",
            body: body
        )
    }

    private func tokenRequest<Body: Encodable>(
        supabaseURL: String,
        anonKey: String,
        grantType: String,
        body: Body
    ) async throws -> SupabaseSession {
        guard let url = authTokenURL(supabaseURL: supabaseURL, grantType: grantType) else {
            throw SupabaseAuthError.invalidSupabaseURL
        }

        var request = URLRequest(url: url)
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "content-type")
        request.setValue("application/json", forHTTPHeaderField: "accept")
        request.setValue(anonKey, forHTTPHeaderField: "apikey")
        request.setValue("Bearer \(anonKey)", forHTTPHeaderField: "authorization")
        request.httpBody = try JSONEncoder.supabase.encode(body)

        let (data, response) = try await session.data(for: request)
        guard let http = response as? HTTPURLResponse else {
            throw SupabaseAuthError.badStatus(-1, nil)
        }
        guard (200..<300).contains(http.statusCode) else {
            let error = try? JSONDecoder.supabase.decode(SupabaseErrorResponse.self, from: data)
            throw SupabaseAuthError.badStatus(http.statusCode, error?.message ?? error?.errorDescription ?? error?.error)
        }

        return try JSONDecoder.supabase.decode(SupabaseSession.self, from: data)
    }

    private func authTokenURL(supabaseURL: String, grantType: String) -> URL? {
        guard let base = URL(string: supabaseURL.trimmingCharacters(in: CharacterSet(charactersIn: "/"))) else {
            return nil
        }
        let tokenURL = base.appendingPathComponent("auth").appendingPathComponent("v1").appendingPathComponent("token")
        var components = URLComponents(url: tokenURL, resolvingAgainstBaseURL: false)
        components?.queryItems = [URLQueryItem(name: "grant_type", value: grantType)]
        return components?.url
    }

    private func sha256(_ input: String) -> String {
        let digest = SHA256.hash(data: Data(input.utf8))
        return digest.map { String(format: "%02x", $0) }.joined()
    }

    private func randomNonceString(length: Int = 32) throws -> String {
        precondition(length > 0)
        let charset = Array("0123456789ABCDEFGHIJKLMNOPQRSTUVXYZabcdefghijklmnopqrstuvwxyz-._")
        var result = ""
        var remainingLength = length

        while remainingLength > 0 {
            var randoms = [UInt8](repeating: 0, count: 16)
            let status = SecRandomCopyBytes(kSecRandomDefault, randoms.count, &randoms)
            guard status == errSecSuccess else {
                throw SupabaseAuthError.requestFailed("Could not generate a secure Apple sign-in nonce.")
            }

            for random in randoms where remainingLength > 0 {
                if random < charset.count {
                    result.append(charset[Int(random)])
                    remainingLength -= 1
                }
            }
        }

        return result
    }
}

private struct SignInWithIdTokenRequest: Encodable {
    let provider: String
    let idToken: String
    let nonce: String
}

private struct RefreshTokenRequest: Encodable {
    let refreshToken: String
}

private struct SupabaseErrorResponse: Decodable {
    let error: String?
    let errorDescription: String?
    let message: String?
}

extension JSONEncoder {
    static var supabase: JSONEncoder {
        let encoder = JSONEncoder()
        encoder.keyEncodingStrategy = .convertToSnakeCase
        return encoder
    }
}

extension JSONDecoder {
    static var supabase: JSONDecoder {
        let decoder = JSONDecoder()
        decoder.keyDecodingStrategy = .convertFromSnakeCase
        return decoder
    }
}

/// Keychain-backed session refresh that background HealthKit can call without
/// hopping to a `@MainActor` view model. Refresh failure never signs the user out.
enum HealthSessionRefresher: Sendable {
    /// Returns a usable access token, or nil if the caller should skip.
    /// `force` ignores local JWT expiry so a 401 can still recover.
    static func freshAccessToken(force: Bool = false) async -> String? {
        await HealthSessionRefreshGate.shared.freshAccessToken(force: force)
    }

    /// One 401 retry after a forced refresh. Other errors propagate unchanged.
    static func withFreshHealthToken<T: Sendable>(
        perform: @Sendable (String) async throws -> T
    ) async throws -> T {
        guard let token = await freshAccessToken() else {
            throw HealthAPIError.missingToken
        }
        do {
            return try await perform(token)
        } catch let error as HealthAPIError {
            guard isUnauthorized(error) else { throw error }
            guard let retry = await freshAccessToken(force: true) else { throw error }
            return try await perform(retry)
        }
    }

    static func isUnauthorized(_ error: HealthAPIError) -> Bool {
        if case .badStatus(let status, _, _) = error {
            return status == 401
        }
        return false
    }

    fileprivate static func loadOrRefresh(force: Bool) async -> String? {
        let keychain = KeychainStore()
        let access = (try? keychain.string(for: DefaultsKey.accessToken)) ?? ""
        guard !access.isEmpty else {
            CrashReporting.log("healthkit_bg_sync_skip_no_token")
            return nil
        }
        if !force, !AccessTokenExpiry.requiresRefresh(access) {
            return access
        }

        let refresh = (try? keychain.string(for: DefaultsKey.refreshToken)) ?? ""
        guard !refresh.isEmpty else {
            CrashReporting.log("healthkit_bg_sync_skip_no_refresh_token")
            return nil
        }

        let defaults = UserDefaults.standard
        let supabaseURL = nonEmpty(defaults.string(forKey: DefaultsKey.supabaseURL))
            ?? AppEnvironment.current.supabaseURL
        let anonKey = nonEmpty(defaults.string(forKey: DefaultsKey.supabaseAnonKey))
            ?? AppEnvironment.current.supabaseAnonKey
        guard !supabaseURL.isEmpty, !anonKey.isEmpty else {
            CrashReporting.log("healthkit_bg_sync_skip_no_supabase_config")
            return nil
        }

        do {
            let session = try await SupabaseAuthClient().refreshSession(
                supabaseURL: supabaseURL,
                anonKey: anonKey,
                refreshToken: refresh
            )
            try keychain.set(session.accessToken, for: DefaultsKey.accessToken)
            if let nextRefresh = session.refreshToken, !nextRefresh.isEmpty {
                try keychain.set(nextRefresh, for: DefaultsKey.refreshToken)
            }
            return session.accessToken
        } catch {
            CrashReporting.healthKitNonFatal(
                .syncFailed,
                stage: .syncFailed,
                message: "healthkit_bg_token_refresh_failed",
                underlying: error
            )
            return nil
        }
    }

    private static func nonEmpty(_ value: String?) -> String? {
        let trimmed = value?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        return trimmed.isEmpty ? nil : trimmed
    }
}

actor HealthSessionRefreshGate {
    static let shared = HealthSessionRefreshGate()

    private var inFlight: Task<String?, Never>?

    func freshAccessToken(force: Bool) async -> String? {
        if let inFlight {
            return await inFlight.value
        }
        let task = Task {
            await HealthSessionRefresher.loadOrRefresh(force: force)
        }
        inFlight = task
        let value = await task.value
        inFlight = nil
        return value
    }
}
