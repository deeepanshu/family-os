import Foundation

@MainActor
final class HealthConnectionViewModel: ObservableObject {
    let environmentName: AppEnvironmentName
    @Published var baseURL: String
    @Published var supabaseURL: String
    @Published var supabaseAnonKey: String

    init(defaults: UserDefaults, environment: AppEnvironment) {
        environmentName = environment.name
        let resolvedBaseURL = Self.resolveBaseURL(defaults.string(forKey: DefaultsKey.baseURL), environment: environment)
        baseURL = resolvedBaseURL
        defaults.set(resolvedBaseURL, forKey: DefaultsKey.baseURL)
        supabaseURL = defaults.string(forKey: DefaultsKey.supabaseURL) ?? environment.supabaseURL
        supabaseAnonKey = defaults.string(forKey: DefaultsKey.supabaseAnonKey) ?? environment.supabaseAnonKey
    }

    func save(to defaults: UserDefaults) {
        defaults.set(baseURL.trimmingCharacters(in: .whitespacesAndNewlines), forKey: DefaultsKey.baseURL)
        defaults.set(supabaseURL.trimmingCharacters(in: .whitespacesAndNewlines), forKey: DefaultsKey.supabaseURL)
        defaults.set(supabaseAnonKey.trimmingCharacters(in: .whitespacesAndNewlines), forKey: DefaultsKey.supabaseAnonKey)
    }

    private static func resolveBaseURL(_ savedURL: String?, environment: AppEnvironment) -> String {
        guard let savedURL = savedURL?.trimmingCharacters(in: .whitespacesAndNewlines), !savedURL.isEmpty else {
            return environment.apiBaseURL
        }

        switch savedURL {
        case "https://api.deepanshujain.me/health/v1", "https://familyos.deepanshujain.me/health/v1":
            return environment.apiBaseURL
        default:
            return savedURL
        }
    }
}
