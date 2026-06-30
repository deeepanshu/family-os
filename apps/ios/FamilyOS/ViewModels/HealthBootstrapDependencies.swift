import Foundation

struct HealthBootstrapDependencies {
    let environment: AppEnvironment
    let healthClient: HealthAPIClient
    let healthKitClient: HealthKitClient
    let authClient: SupabaseAuthClient
    let keychain: KeychainStore
    let defaults: UserDefaults

    @MainActor static let live = HealthBootstrapDependencies(
        environment: .current,
        healthClient: HealthAPIClient(),
        healthKitClient: HealthKitClient(),
        authClient: SupabaseAuthClient(),
        keychain: KeychainStore(),
        defaults: .standard
    )
}
