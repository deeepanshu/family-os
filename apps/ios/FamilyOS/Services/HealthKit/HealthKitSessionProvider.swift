import Foundation

enum HealthKitSessionProviderError: LocalizedError {
    case missingSession
    case missingConfiguration
    case authenticationRequired

    var errorDescription: String? {
        switch self {
        case .missingSession:
            return "Sign in required for HealthKit sync."
        case .missingConfiguration:
            return "HealthKit sync is not configured on this device."
        case .authenticationRequired:
            return "HealthKit sync authentication expired. Sign in again."
        }
    }
}

/// Sole non-UI session reader for background HealthKit work.
/// Refreshes a normal user session once when needed. Does not store bearer tokens in the sync store.
actor HealthKitSessionProvider {
    private let stateStore: HealthKitSyncStateStore
    private let api: HealthAPIClient
    private let authClient: SupabaseAuthClient
    private let keychain: KeychainStore
    private let defaults: UserDefaults
    private let environment: AppEnvironment

    init(
        stateStore: HealthKitSyncStateStore = HealthKitSyncStateStore(),
        api: HealthAPIClient = HealthAPIClient(),
        authClient: SupabaseAuthClient = SupabaseAuthClient(),
        keychain: KeychainStore = KeychainStore(),
        defaults: UserDefaults = .standard,
        environment: AppEnvironment = .current
    ) {
        self.stateStore = stateStore
        self.api = api
        self.authClient = authClient
        self.keychain = keychain
        self.defaults = defaults
        self.environment = environment
    }

    func makeContext(
        origin: HealthKitSyncOrigin,
        refreshIfNeeded: Bool = true
    ) async throws -> HealthKitSyncEngine.SessionContext {
        guard let configuration = await stateStore.loadConfiguration(),
              configuration.consentVersion != nil,
              !configuration.enabledMetrics.isEmpty
        else {
            throw HealthKitSessionProviderError.missingConfiguration
        }

        let baseURL = defaults.string(forKey: DefaultsKey.baseURL) ?? environment.apiBaseURL
        var accessToken = (try? keychain.string(for: DefaultsKey.accessToken)) ?? ""
        let refreshToken = try? keychain.string(for: DefaultsKey.refreshToken)
        var userId = configuration.userId
        if userId.isEmpty {
            userId = defaults.string(forKey: DefaultsKey.userId) ?? ""
        }

        guard !accessToken.isEmpty else {
            throw HealthKitSessionProviderError.missingSession
        }

        if refreshIfNeeded {
            do {
                _ = try await api.session(baseURL: baseURL, accessToken: accessToken)
            } catch {
                guard let refreshToken, !refreshToken.isEmpty else {
                    throw HealthKitSessionProviderError.authenticationRequired
                }
                let supabaseURL = defaults.string(forKey: DefaultsKey.supabaseURL) ?? environment.supabaseURL
                let anonKey = defaults.string(forKey: DefaultsKey.supabaseAnonKey) ?? environment.supabaseAnonKey
                do {
                    let session = try await authClient.refreshSession(
                        supabaseURL: supabaseURL,
                        anonKey: anonKey,
                        refreshToken: refreshToken
                    )
                    accessToken = session.accessToken
                    try keychain.set(accessToken, for: DefaultsKey.accessToken)
                    if let newRefresh = session.refreshToken {
                        try keychain.set(newRefresh, for: DefaultsKey.refreshToken)
                    }
                    if let id = session.user?.id {
                        userId = id
                        defaults.set(id, forKey: DefaultsKey.userId)
                    }
                } catch {
                    throw HealthKitSessionProviderError.authenticationRequired
                }
            }
        }

        if userId.isEmpty {
            let me = try await api.session(baseURL: baseURL, accessToken: accessToken)
            userId = me.userId
            defaults.set(userId, forKey: DefaultsKey.userId)
        }

        return HealthKitSyncEngine.SessionContext(
            baseURL: baseURL,
            accessToken: accessToken,
            userId: userId,
            personId: configuration.personId,
            timezone: configuration.healthTimezone,
            timezoneVersion: configuration.healthTimezoneVersion,
            installationId: configuration.installationId,
            enabledGroups: configuration.enabledMetrics,
            origin: origin
        )
    }
}
