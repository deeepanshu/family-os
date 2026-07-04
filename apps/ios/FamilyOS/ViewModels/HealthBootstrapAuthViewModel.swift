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

    func useLocalDevToken() async {
        auth.accessToken = "dev-token"
        do {
            try keychain.set(auth.accessToken, for: DefaultsKey.accessToken)
            keychain.remove(DefaultsKey.refreshToken)
            defaults.removeObject(forKey: DefaultsKey.userId)
            defaults.removeObject(forKey: DefaultsKey.userEmail)
            auth.refreshToken = nil
            auth.signedInUserId = nil
            auth.signedInUserEmail = nil
            isError = false
            statusMessage = "Using local development sign in."
        } catch {
            isError = true
            statusMessage = error.localizedDescription
            return
        }
        if hasAccessToken {
            await startup()
        }
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
            await startup()
        }
    }
}
