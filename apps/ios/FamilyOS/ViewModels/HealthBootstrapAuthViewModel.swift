import AuthenticationServices
import Foundation

extension HealthBootstrapViewModel {
    func prepareAppleSignInRequest(_ request: ASAuthorizationAppleIDRequest) {
        do {
            let nonce = try authClient.makeAppleNonce()
            auth.currentAppleNonce = nonce
            request.requestedScopes = [.fullName, .email]
            request.nonce = nonce.sha256
        } catch {
            isError = true
            statusMessage = error.localizedDescription
        }
    }

    func handleAppleSignInCompletion(_ result: Result<ASAuthorization, Error>) async {
        switch result {
        case .success(let authorization):
            await signInWithApple(authorization)
        case .failure(let error):
            isError = true
            statusMessage = error.localizedDescription
        }
    }

    func refreshSupabaseSession() async {
        await request {
            guard let refreshToken = auth.refreshToken else {
                return "No refresh token is available. Sign in again."
            }
            let session = try await authClient.refreshSession(
                supabaseURL: connection.supabaseURL,
                anonKey: connection.supabaseAnonKey,
                refreshToken: refreshToken
            )
            try storeSession(session)
            return "Refreshed Supabase session for \(signedInSummary)."
        }
    }

    func useManualAccessToken() {
        let trimmed = auth.accessToken.trimmingCharacters(in: .whitespacesAndNewlines)
        auth.accessToken = trimmed
        do {
            try keychain.set(trimmed, for: DefaultsKey.accessToken)
        } catch {
            isError = true
            statusMessage = error.localizedDescription
            return
        }
        keychain.remove(DefaultsKey.refreshToken)
        defaults.removeObject(forKey: DefaultsKey.userId)
        defaults.removeObject(forKey: DefaultsKey.userEmail)
        auth.refreshToken = nil
        auth.signedInUserId = nil
        auth.signedInUserEmail = nil
        isError = trimmed.isEmpty
        statusMessage = trimmed.isEmpty ? "Paste a Supabase access token first." : "Using manual access token."
    }

    private func signInWithApple(_ authorization: ASAuthorization) async {
        await request {
            guard let currentAppleNonce = auth.currentAppleNonce else {
                return "Apple sign-in nonce was missing. Try again."
            }
            let session = try await authClient.exchangeAppleCredential(
                supabaseURL: connection.supabaseURL,
                anonKey: connection.supabaseAnonKey,
                authorization: authorization,
                rawNonce: currentAppleNonce.raw
            )
            try storeSession(session)
            self.auth.currentAppleNonce = nil
            return "Signed in with Apple as \(signedInSummary)."
        }
        if hasAccessToken {
            await loadCurrentFamily()
            await loadProfiles()
        }
    }
}
