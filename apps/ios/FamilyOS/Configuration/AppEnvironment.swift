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
    let otlpMetricsEndpoint: String
    let metricsAccessClientID: String
    let metricsAccessClientSecret: String

    static let current = AppEnvironment(bundle: .main)

    init(
        name: AppEnvironmentName,
        apiBaseURL: String,
        supabaseURL: String,
        supabaseAnonKey: String = "",
        otlpMetricsEndpoint: String = "",
        metricsAccessClientID: String = "",
        metricsAccessClientSecret: String = ""
    ) {
        self.name = name
        self.apiBaseURL = apiBaseURL
        self.supabaseURL = supabaseURL
        self.supabaseAnonKey = supabaseAnonKey
        self.otlpMetricsEndpoint = otlpMetricsEndpoint
        self.metricsAccessClientID = metricsAccessClientID
        self.metricsAccessClientSecret = metricsAccessClientSecret
    }

    init(bundle: Bundle) {
        let info = bundle.infoDictionary ?? [:]
        let configuredName = (info["FAMILY_OS_ENV"] as? String) ?? "release"
        name = AppEnvironmentName(rawValue: configuredName) ?? .release
        apiBaseURL = Self.nonEmpty(info["HEALTH_API_BASE_URL"] as? String) ?? Self.defaultAPIBaseURL(for: name)
        supabaseURL = Self.nonEmpty(info["SUPABASE_URL"] as? String) ?? ""
        supabaseAnonKey = Self.nonEmpty(info["SUPABASE_ANON_KEY"] as? String) ?? ""
        otlpMetricsEndpoint = Self.nonEmpty(info["OTLP_METRICS_ENDPOINT"] as? String) ?? ""
        metricsAccessClientID = Self.nonEmpty(info["CF_ACCESS_CLIENT_ID"] as? String) ?? ""
        metricsAccessClientSecret = Self.nonEmpty(info["CF_ACCESS_CLIENT_SECRET"] as? String) ?? ""
    }

    private static func defaultAPIBaseURL(for name: AppEnvironmentName) -> String {
        switch name {
        case .local:
            return "http://localhost:3001/health/api/v1"
        case .release:
            return "https://familyos.deepanshujain.me/health/api/v1"
        }
    }

    private static func nonEmpty(_ value: String?) -> String? {
        guard let trimmed = value?.trimmingCharacters(in: .whitespacesAndNewlines),
              !trimmed.isEmpty,
              !trimmed.contains("$(") else {
            return nil
        }
        return trimmed
    }
}

enum FamilyOSPublicSite {
    static func origin(fromAPIBaseURL baseURL: String) -> URL {
        guard var url = URL(string: baseURL) else {
            return URL(string: "https://familyos.deepanshujain.me")!
        }
        let trimmedPath = url.path.hasSuffix("/") ? String(url.path.dropLast()) : url.path
        if trimmedPath.hasSuffix("/health/api/v1") {
            url.deleteLastPathComponent()
            url.deleteLastPathComponent()
            url.deleteLastPathComponent()
        }
        return url
    }

    static func url(path: String, apiBaseURL: String) -> URL {
        let relative = path.hasPrefix("/") ? String(path.dropFirst()) : path
        return origin(fromAPIBaseURL: apiBaseURL).appendingPathComponent(relative)
    }
}
