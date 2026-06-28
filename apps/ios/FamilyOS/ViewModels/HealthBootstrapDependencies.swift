import Foundation

struct HealthBootstrapDependencies {
    let environment: AppEnvironment
    let healthClient: HealthAPIClient
    let authClient: SupabaseAuthClient
    let keychain: KeychainStore
    let defaults: UserDefaults

    @MainActor static let live = HealthBootstrapDependencies(
        environment: .current,
        healthClient: HealthAPIClient(),
        authClient: SupabaseAuthClient(),
        keychain: KeychainStore(),
        defaults: .standard
    )
}
