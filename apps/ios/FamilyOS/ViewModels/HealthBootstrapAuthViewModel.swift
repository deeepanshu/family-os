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
            reportActionFailure(statusMessage)
        }
    }

    func handleAppleSignInCompletion(_ result: Result<ASAuthorization, Error>) async {
        switch result {
        case .success(let authorization):
            await signInWithApple(authorization)
        case .failure(let error):
            isError = true
            statusMessage = error.localizedDescription
            reportActionFailure(statusMessage)
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
            reportActionResult(statusMessage)
        } catch {
            isError = true
            statusMessage = error.localizedDescription
            reportActionFailure(statusMessage)
            return
        }
        if hasAccessToken {
            await startup()
        }
    }

    /// DEBUG-only path for headless simulator smoke (`-FamilyOSLocalSmoke` launch arg).
    func runLocalSmokeIfRequested() async {
        #if DEBUG
        guard connection.environmentName == .local else {
            statusMessage = "Local smoke requires FAMILY_OS_ENV=local."
            isError = true
            return
        }
        await useLocalDevToken()
        // Ensure profile list is populated even if needsProfileSetup was already false.
        if selfProfile == nil {
            await createSelfProfile(displayName: "Simulator Smoke")
        }
        if selfProfile == nil {
            await loadProfiles()
            if let selfRow = profiles.profiles.first(where: { $0.relationshipLabel == "Self" }) {
                profiles.selectedProfileId = selfRow.id
                healthKit.linkedProfileId = selfRow.id
            }
        }
        guard let personId = selfProfile?.id else {
            statusMessage = "Local smoke could not resolve self profile (profiles=\(profiles.profiles.count))."
            isError = true
            reportActionFailure(statusMessage)
            return
        }
        _ = personId
        healthKit.consentGranted = true
        healthKit.enabledMetrics = [.vitals]
        await saveHealthKitSettings(showsFeedback: true)
        await syncHealthKitNow()
        #endif
    }

    private func signInWithApple(_ authorization: ASAuthorization) async {
        await request(showsFeedback: true) {
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
