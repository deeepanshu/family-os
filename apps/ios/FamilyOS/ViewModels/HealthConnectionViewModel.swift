import Foundation

@MainActor
final class HealthConnectionViewModel: ObservableObject {
    let environmentName: AppEnvironmentName
    @Published var baseURL: String
    @Published var supabaseURL: String
    @Published var supabaseAnonKey: String

    init(defaults: UserDefaults, environment: AppEnvironment) {
        environmentName = environment.name
        baseURL = defaults.string(forKey: DefaultsKey.baseURL) ?? environment.apiBaseURL
        supabaseURL = defaults.string(forKey: DefaultsKey.supabaseURL) ?? environment.supabaseURL
        supabaseAnonKey = defaults.string(forKey: DefaultsKey.supabaseAnonKey) ?? environment.supabaseAnonKey
    }

    func save(to defaults: UserDefaults) {
        defaults.set(baseURL.trimmingCharacters(in: .whitespacesAndNewlines), forKey: DefaultsKey.baseURL)
        defaults.set(supabaseURL.trimmingCharacters(in: .whitespacesAndNewlines), forKey: DefaultsKey.supabaseURL)
        defaults.set(supabaseAnonKey.trimmingCharacters(in: .whitespacesAndNewlines), forKey: DefaultsKey.supabaseAnonKey)
    }
}
