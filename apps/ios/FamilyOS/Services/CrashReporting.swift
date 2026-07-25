import Foundation
import OSLog

#if canImport(FirebaseCore)
import FirebaseCore
#endif

#if canImport(FirebaseCrashlytics)
import FirebaseCrashlytics
#endif

/// Thin facade around Firebase Crashlytics.
///
/// Safe to call when Firebase is not configured (missing `GoogleService-Info.plist`
/// or Debug collection disabled). Never logs health readings, tokens, or free-text
/// that might contain PHI.
enum CrashReporting {
    private static let logger = Logger(subsystem: "com.deepanshujain.familyos", category: "CrashReporting")

    /// Written once at launch from the main actor; read from call sites afterward.
    nonisolated(unsafe) private(set) static var isEnabled = false

    /// Call once at app launch, before other startup work that may crash.
    @MainActor
    static func configure() {
        guard let configURL = Bundle.main.url(forResource: "GoogleService-Info", withExtension: "plist") else {
            logger.notice("GoogleService-Info.plist missing; Crashlytics disabled")
            isEnabled = false
            return
        }

        let configuration = NSDictionary(contentsOf: configURL)
        guard let googleAppID = configuration?["GOOGLE_APP_ID"] as? String,
              !googleAppID.contains("REPLACE_ME") else {
            logger.notice("Firebase placeholder configuration detected; Crashlytics disabled")
            isEnabled = false
            return
        }

        #if canImport(FirebaseCore) && canImport(FirebaseCrashlytics)
        if FirebaseApp.app() == nil {
            FirebaseApp.configure()
        }

        #if DEBUG
        // Avoid polluting production Crashlytics with local/simulator noise.
        // Still fully initializes Firebase so Release archives exercise the path.
        Crashlytics.crashlytics().setCrashlyticsCollectionEnabled(false)
        isEnabled = false
        logger.notice("Crashlytics collection disabled in DEBUG builds")
        #else
        Crashlytics.crashlytics().setCrashlyticsCollectionEnabled(true)
        isEnabled = true
        let env = AppEnvironment.current.name.rawValue
        Crashlytics.crashlytics().setCustomValue(env, forKey: "app_environment")
        // Restore user association for sessions already on device.
        if let userID = UserDefaults.standard.string(forKey: DefaultsKey.userId), !userID.isEmpty {
            Crashlytics.crashlytics().setUserID(userID)
        }
        logger.notice("Crashlytics collection enabled (env=\(env, privacy: .public))")
        #endif
        #else
        isEnabled = false
        logger.notice("Firebase modules unavailable; Crashlytics disabled")
        #endif
    }

    /// Associates crashes with a stable user id (UUID only — never email).
    static func setUserID(_ userID: String?) {
        #if canImport(FirebaseCrashlytics)
        guard isEnabled else { return }
        if let userID, !userID.isEmpty {
            Crashlytics.crashlytics().setUserID(userID)
        } else {
            Crashlytics.crashlytics().setUserID("")
        }
        #endif
    }

    /// Breadcrumb-style log. Keep messages free of PHI and secrets.
    static func log(_ message: String) {
        #if canImport(FirebaseCrashlytics)
        guard isEnabled else { return }
        Crashlytics.crashlytics().log(message)
        #endif
    }

    /// Crash context must be fixed, operational metadata only. Do not pass
    /// identifiers, dates, health values, tokens, or user-entered text.
    static func setCustomValues(_ values: [String: String]) {
        #if canImport(FirebaseCrashlytics)
        guard isEnabled else { return }
        for (key, value) in values {
            Crashlytics.crashlytics().setCustomValue(value, forKey: key)
        }
        #endif
    }

    /// Records a non-fatal error. Prefer domain + code over free-text health values.
    static func record(error: Error, userInfo: [String: Any] = [:]) {
        #if canImport(FirebaseCrashlytics)
        guard isEnabled else { return }
        let info = sanitized(userInfo)
        let existing = error as NSError
        var merged = existing.userInfo
        for (key, value) in info {
            merged[key] = value
        }
        let nsError = NSError(domain: existing.domain, code: existing.code, userInfo: merged)
        Crashlytics.crashlytics().record(error: nsError)
        #else
        _ = error
        _ = userInfo
        #endif
    }

    private static func sanitized(_ userInfo: [String: Any]) -> [String: Any] {
        var result: [String: Any] = [:]
        for (key, value) in userInfo {
            switch value {
            case let string as String:
                result[key] = String(string.prefix(200))
            case let number as NSNumber:
                result[key] = number
            case let bool as Bool:
                result[key] = bool
            default:
                result[key] = String(String(describing: value).prefix(100))
            }
        }
        return result
    }
}
