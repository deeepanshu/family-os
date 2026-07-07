import Foundation

enum AppEnvironmentName: String {
    case local
    case release
}

struct AppEnvironment {
    let name: AppEnvironmentName
    let apiBaseURL: String
    let supabaseURL: String
    let supabaseAnonKey: String

    static let current = AppEnvironment(bundle: .main)

    init(name: AppEnvironmentName, apiBaseURL: String, supabaseURL: String, supabaseAnonKey: String = "") {
        self.name = name
        self.apiBaseURL = apiBaseURL
        self.supabaseURL = supabaseURL
        self.supabaseAnonKey = supabaseAnonKey
    }

    init(bundle: Bundle) {
        let info = bundle.infoDictionary ?? [:]
        let configuredName = (info["FAMILY_OS_ENV"] as? String) ?? "release"
        name = AppEnvironmentName(rawValue: configuredName) ?? .release
        apiBaseURL = Self.nonEmpty(info["HEALTH_API_BASE_URL"] as? String) ?? Self.defaultAPIBaseURL(for: name)
        supabaseURL = Self.nonEmpty(info["SUPABASE_URL"] as? String) ?? ""
        supabaseAnonKey = Self.nonEmpty(info["SUPABASE_ANON_KEY"] as? String) ?? ""
    }

    private static func defaultAPIBaseURL(for name: AppEnvironmentName) -> String {
        switch name {
        case .local:
            return "http://localhost:3001/health/v1"
        case .release:
            return "https://api.deepanshujain.me/health/v1"
        }
    }

    private static func nonEmpty(_ value: String?) -> String? {
        guard let trimmed = value?.trimmingCharacters(in: .whitespacesAndNewlines), !trimmed.isEmpty else {
            return nil
        }
        return trimmed
    }
}
