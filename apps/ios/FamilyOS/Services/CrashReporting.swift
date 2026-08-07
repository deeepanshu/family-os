import Foundation
import OSLog

#if canImport(FirebaseCore)
import FirebaseCore
#endif

#if canImport(FirebaseCrashlytics)
import FirebaseCrashlytics
#endif

/// Thin facade around Firebase Crashlytics + OSLog.
///
/// Safe to call when Firebase is not configured (missing `GoogleService-Info.plist`
/// or Debug collection disabled). Never logs health readings, tokens, free-text notes,
/// or raw sample payloads.
enum CrashReporting {
    private static let logger = Logger(subsystem: "com.deepanshujain.familyos", category: "CrashReporting")
    private static let healthKitLogger = Logger(subsystem: "com.deepanshujain.familyos", category: "HealthKitSync")

    /// Written once at launch from the main actor; read from call sites afterward.
    nonisolated(unsafe) private(set) static var isEnabled = false

    /// Operational domain for HealthKit non-fatals in Crashlytics.
    static let healthKitErrorDomain = "com.deepanshujain.familyos.healthkit"

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
        // OSLog breadcrumbs still work via `log` / `healthKit` helpers.
        Crashlytics.crashlytics().setCrashlyticsCollectionEnabled(false)
        isEnabled = false
        logger.notice("Crashlytics collection disabled in DEBUG builds (OSLog still active)")
        #else
        Crashlytics.crashlytics().setCrashlyticsCollectionEnabled(true)
        isEnabled = true
        let env = AppEnvironment.current.name.rawValue
        Crashlytics.crashlytics().setCustomValue(env, forKey: "app_environment")
        Crashlytics.crashlytics().setCustomValue("ops_batch_v1", forKey: "healthkit_protocol")
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

    /// Breadcrumb-style log. Always writes OSLog; Crashlytics only when collection is on.
    /// Keep messages free of PHI and secrets.
    static func log(_ message: String) {
        logger.info("\(message, privacy: .public)")
        #if canImport(FirebaseCrashlytics)
        if isEnabled {
            Crashlytics.crashlytics().log(message)
        }
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
        let info = sanitized(userInfo)
        logger.error("nonfatal \(String(describing: error), privacy: .public) info=\(String(describing: info), privacy: .public)")
        #if canImport(FirebaseCrashlytics)
        guard isEnabled else { return }
        let existing = error as NSError
        var merged = existing.userInfo
        for (key, value) in info {
            merged[key] = value
        }
        let nsError = NSError(domain: existing.domain, code: existing.code, userInfo: merged)
        Crashlytics.crashlytics().record(error: nsError)
        #endif
    }

    /// Structured non-fatal with a stable domain/code for filtering in Crashlytics.
    static func recordNonFatal(
        domain: String,
        code: Int,
        message: String,
        userInfo: [String: Any] = [:]
    ) {
        var info = sanitized(userInfo)
        info[NSLocalizedDescriptionKey] = String(message.prefix(200))
        let error = NSError(domain: domain, code: code, userInfo: info)
        record(error: error, userInfo: info)
    }

    // MARK: - HealthKit stages (no PHI)

    /// Stable stage names for filtering Crashlytics logs / custom keys.
    enum HealthKitStage: String {
        case syncStarted = "sync_started"
        case settingsLoaded = "settings_loaded"
        case importStarted = "import_started"
        case authRequested = "auth_requested"
        case samplesFetched = "samples_fetched"
        case samplesEnqueued = "samples_enqueued"
        case drainStarted = "drain_started"
        case drainBatch = "drain_batch"
        case drainFinished = "drain_finished"
        case groupReady = "group_ready"
        case syncCompleted = "sync_completed"
        case syncFailed = "sync_failed"
        case settingsSaved = "settings_saved"
        case storeOpenFailed = "store_open_failed"
        case opRejected = "op_rejected"
    }

    enum HealthKitCode: Int {
        case missingSelfProfile = 1001
        case wrongProfileTarget = 1002
        case healthKitUnavailable = 1003
        case consentMissing = 1004
        case storeOpenFailed = 1005
        case queueIncomplete = 1006
        case batchFailed = 1007
        case opRejected = 1008
        case fetchFailed = 1009
        case settingsFailed = 1010
        case syncFailed = 1011
    }

    /// Breadcrumb + stage key for HealthKit pipeline. Counts only — never sample values.
    static func healthKit(
        _ stage: HealthKitStage,
        group: String? = nil,
        metric: String? = nil,
        count: Int? = nil,
        extra: [String: String] = [:]
    ) {
        var parts = ["healthkit_stage=\(stage.rawValue)"]
        if let group { parts.append("group=\(group)") }
        if let metric { parts.append("metric=\(metric)") }
        if let count { parts.append("count=\(count)") }
        for (key, value) in extra.sorted(by: { $0.key < $1.key }) {
            parts.append("\(key)=\(value)")
        }
        let message = parts.joined(separator: " ")
        healthKitLogger.info("\(message, privacy: .public)")
        log(message)

        var keys: [String: String] = ["healthkit_stage": stage.rawValue]
        if let group { keys["healthkit_group"] = group }
        if let metric { keys["healthkit_metric"] = metric }
        if let count { keys["healthkit_count"] = String(count) }
        for (key, value) in extra {
            keys[key] = value
        }
        setCustomValues(keys)
    }

    static func healthKitNonFatal(
        _ code: HealthKitCode,
        stage: HealthKitStage,
        message: String,
        group: String? = nil,
        metric: String? = nil,
        underlying: Error? = nil
    ) {
        healthKit(stage, group: group, metric: metric, extra: ["error_code": String(code.rawValue)])
        var info: [String: Any] = [
            "healthkit_stage": stage.rawValue,
            "healthkit_code": code.rawValue
        ]
        if let group { info["healthkit_group"] = group }
        if let metric { info["healthkit_metric"] = metric }
        if let underlying {
            let ns = underlying as NSError
            info["underlying_domain"] = ns.domain
            info["underlying_code"] = ns.code
            // Prefer stable API error codes over free-text.
            if let api = underlying as? HealthAPIError, let apiCode = api.errorCode {
                info["api_error_code"] = apiCode
            }
        }
        recordNonFatal(
            domain: healthKitErrorDomain,
            code: code.rawValue,
            message: message,
            userInfo: info
        )
    }

    private static func sanitized(_ userInfo: [String: Any]) -> [String: Any] {
        var result: [String: Any] = [:]
        for (key, value) in userInfo {
            // Drop keys that often carry PHI or secrets if callers slip.
            let lower = key.lowercased()
            if lower.contains("token")
                || lower.contains("password")
                || lower.contains("authorization")
                || lower.contains("payload")
                || lower.contains("sample")
                || lower.contains("systolic")
                || lower.contains("diastolic")
                || lower.contains("glucose")
            {
                continue
            }
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
