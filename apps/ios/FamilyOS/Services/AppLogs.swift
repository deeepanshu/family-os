import Foundation
import OSLog

/// Minimal OTLP/HTTP logs client for the self-hosted observability stack.
///
/// `CrashReporting` already produces the client-side narrative at every
/// interesting site, but OSLog/Crashlytics never leave the device, so none of it
/// is queryable from Grafana. This mirrors `AppMetrics`: same endpoint config,
/// same Cloudflare Access posture, same DEBUG opt-in gate.
///
/// Messages must stay operational. Never log health readings, dates, free-text,
/// tokens, or email — callers pass fixed identifiers and counters only.
enum AppLogs {
    private static let logger = Logger(subsystem: "com.deepanshujain.familyos", category: "AppLogs")
    private static let storage = Storage()

    /// DEBUG builds remain silent unless this launch argument is present.
    private static let smokeLaunchArgument = "-FamilyOSMetricsSmoke"

    enum Severity: String, Sendable {
        case debug = "DEBUG"
        case info = "INFO"
        case warn = "WARN"
        case error = "ERROR"

        var severityNumber: Int {
            switch self {
            case .debug: return 5
            case .info: return 9
            case .warn: return 13
            case .error: return 17
            }
        }
    }

    static func configure() {
        #if DEBUG
        guard ProcessInfo.processInfo.arguments.contains(smokeLaunchArgument) else {
            logger.notice("OTLP logs disabled in DEBUG builds")
            return
        }
        #endif

        guard let endpoint = Self.logsEndpoint(from: AppEnvironment.current.otlpMetricsEndpoint) else {
            logger.notice("OTLP logs disabled: endpoint is not configured")
            return
        }

        let environment = AppEnvironment.current
        var headers: [String: String] = [:]
        if let host = endpoint.host?.lowercased(), !(endpoint.scheme == "http" && host.hasSuffix(".lab")) {
            guard !environment.metricsAccessClientID.isEmpty,
                  !environment.metricsAccessClientSecret.isEmpty else {
                logger.notice("OTLP logs disabled: Cloudflare Access credentials are not configured")
                return
            }
            headers["CF-Access-Client-Id"] = environment.metricsAccessClientID
            headers["CF-Access-Client-Secret"] = environment.metricsAccessClientSecret
        }

        let info = Bundle.main.infoDictionary ?? [:]
        activate(
            Configuration(
                endpoint: endpoint,
                environment: environment.name.rawValue,
                version: Self.nonEmpty(info["CFBundleShortVersionString"] as? String) ?? "unknown",
                build: Self.nonEmpty(info["CFBundleVersion"] as? String) ?? "unknown",
                buildConfiguration: Self.buildConfiguration,
                installationID: Self.currentInstallationID(),
                headers: headers,
                requestSink: nil
            )
        )
        logger.notice("OTLP logs enabled (endpoint=\(endpoint.host ?? "unknown", privacy: .public))")
    }

    /// Test-only egress seam: captures the exact OTLP/HTTP request without a network dependency.
    static func configureForTesting(
        endpoint: URL,
        installationID: String? = nil,
        send: @escaping @Sendable (URLRequest) -> Void
    ) {
        activate(
            Configuration(
                endpoint: endpoint,
                environment: "test",
                version: "1.0",
                build: "1",
                buildConfiguration: "debug",
                installationID: Self.nonEmpty(installationID),
                headers: [:],
                requestSink: send
            )
        )
    }

    static func resetForTesting() {
        storage.lock.lock()
        storage.configuration = nil
        storage.pending.removeAll(keepingCapacity: true)
        storage.isFlushInFlight = false
        storage.lastFlush = .distantPast
        storage.lock.unlock()
    }

    static var isEnabledForTesting: Bool {
        storage.lock.lock()
        defer { storage.lock.unlock() }
        return storage.configuration != nil
    }

    /// Records an operational breadcrumb. No-op until configured.
    static func record(
        _ message: String,
        severity: Severity = .info,
        attributes: [String: String] = [:]
    ) {
        let trimmed = message.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return }

        storage.lock.lock()
        defer { storage.lock.unlock() }
        guard storage.configuration != nil else { return }
        storage.pending.append(
            PendingLog(
                body: String(trimmed.prefix(512)),
                severity: severity,
                attributes: sanitized(attributes),
                timeUnixNano: unixTimeNanoseconds()
            )
        )
    }

    /// Sends queued logs and waits for the collector response.
    ///
    /// Background execution may be suspended immediately after its completion
    /// handler returns, so callers reporting a background terminal state use
    /// this instead of the opportunistic flush below.
    @discardableResult
    static func flushAndWait(force: Bool = false) async -> Bool {
        let snapshot: Snapshot

        storage.lock.lock()
        let now = Date()
        guard let configuration = storage.configuration,
              !storage.isFlushInFlight,
              !storage.pending.isEmpty,
              force || now.timeIntervalSince(storage.lastFlush) >= 15 else {
            storage.lock.unlock()
            return false
        }

        storage.isFlushInFlight = true
        storage.lastFlush = now
        snapshot = Snapshot(
            configuration: configuration,
            entries: storage.pending,
            capturedAtUnixNanoseconds: unixTimeNanoseconds()
        )
        storage.pending.removeAll(keepingCapacity: true)
        storage.lock.unlock()

        guard let body = payload(for: snapshot) else {
            completeFlush()
            return false
        }

        var request = URLRequest(url: snapshot.configuration.endpoint)
        request.httpMethod = "POST"
        request.timeoutInterval = 10
        request.httpBody = body
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        for (field, value) in snapshot.configuration.headers {
            request.setValue(value, forHTTPHeaderField: field)
        }

        if let requestSink = snapshot.configuration.requestSink {
            requestSink(request)
            completeFlush()
            return true
        }

        do {
            let (_, response) = try await URLSession.shared.data(for: request)
            let success = (response as? HTTPURLResponse).map { (200...299).contains($0.statusCode) } == true
            if !success {
                logger.error("OTLP logs flush failed")
            }
            completeFlush()
            return success
        } catch {
            logger.error("OTLP logs flush failed")
            completeFlush()
            return false
        }
    }

    /// Sends queued logs at most once every 15 seconds unless forced.
    static func flush(force: Bool = false) {
        let snapshot: Snapshot

        storage.lock.lock()
        let now = Date()
        guard let configuration = storage.configuration,
              !storage.isFlushInFlight,
              !storage.pending.isEmpty,
              force || now.timeIntervalSince(storage.lastFlush) >= 15 else {
            storage.lock.unlock()
            return
        }

        storage.isFlushInFlight = true
        storage.lastFlush = now
        snapshot = Snapshot(
            configuration: configuration,
            entries: storage.pending,
            capturedAtUnixNanoseconds: unixTimeNanoseconds()
        )
        storage.pending.removeAll(keepingCapacity: true)
        storage.lock.unlock()

        guard let body = payload(for: snapshot) else {
            completeFlush()
            return
        }

        var request = URLRequest(url: snapshot.configuration.endpoint)
        request.httpMethod = "POST"
        request.timeoutInterval = 10
        request.httpBody = body
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        for (field, value) in snapshot.configuration.headers {
            request.setValue(value, forHTTPHeaderField: field)
        }

        if let requestSink = snapshot.configuration.requestSink {
            requestSink(request)
            completeFlush()
            return
        }

        URLSession.shared.dataTask(with: request) { _, response, error in
            let statusCode = (response as? HTTPURLResponse)?.statusCode
            let success = error == nil && statusCode.map { (200...299).contains($0) } == true
            if !success {
                logger.error("OTLP logs flush failed status=\(statusCode ?? -1, privacy: .public)")
            }
            completeFlush()
        }.resume()
    }

    private static func activate(_ configuration: Configuration) {
        storage.lock.lock()
        storage.configuration = configuration
        storage.pending.removeAll(keepingCapacity: true)
        storage.lastFlush = .distantPast
        storage.lock.unlock()
    }

    private static func completeFlush() {
        storage.lock.lock()
        storage.isFlushInFlight = false
        storage.lock.unlock()
    }

    /// Derives the logs endpoint from the configured metrics endpoint so both
    /// signals share one origin and one set of credentials.
    static func logsEndpoint(from metricsEndpoint: String) -> URL? {
        let trimmed = metricsEndpoint.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty, var components = URLComponents(string: trimmed) else { return nil }
        let scheme = components.scheme?.lowercased() ?? ""
        let host = components.host?.lowercased() ?? ""
        let isLANEndpoint = scheme == "http" && host.hasSuffix(".lab")
        guard scheme == "https" || isLANEndpoint else { return nil }

        if components.path.hasSuffix("/v1/metrics") {
            components.path = String(components.path.dropLast("/v1/metrics".count)) + "/v1/logs"
        } else {
            components.path = components.path.hasSuffix("/")
                ? components.path + "v1/logs"
                : components.path + "/v1/logs"
        }
        return components.url
    }

    /// Keeps attribute payloads low-cardinality and free of user data.
    private static func sanitized(_ values: [String: String]) -> [String: String] {
        var result: [String: String] = [:]
        for (key, value) in values {
            let cleanedKey = String(key.prefix(64))
            let cleanedValue = String(value.prefix(64))
            guard !cleanedKey.isEmpty,
                  !cleanedValue.isEmpty,
                  !cleanedKey.contains(where: { $0.isWhitespace || $0.isNewline }),
                  !cleanedValue.contains(where: { $0.isNewline }) else {
                continue
            }
            result[cleanedKey] = cleanedValue
        }
        return result
    }

    private static func payload(for snapshot: Snapshot) -> Data? {
        let records: [[String: Any]] = snapshot.entries.map { entry in
            [
                "timeUnixNano": String(entry.timeUnixNano),
                "observedTimeUnixNano": String(entry.timeUnixNano),
                "severityNumber": entry.severity.severityNumber,
                "severityText": entry.severity.rawValue,
                "body": ["stringValue": entry.body],
                "attributes": entry.attributes
                    .sorted { $0.key < $1.key }
                    .map { ["key": $0.key, "value": ["stringValue": $0.value]] }
            ]
        }

        var resourceAttributes = [
            ["key": "service.name", "value": ["stringValue": "family-os-ios"]],
            ["key": "service.version", "value": ["stringValue": snapshot.configuration.version]],
            ["key": "deployment.environment", "value": ["stringValue": snapshot.configuration.environment]],
            ["key": "ios.build", "value": ["stringValue": snapshot.configuration.build]],
            ["key": "ios.build_configuration", "value": ["stringValue": snapshot.configuration.buildConfiguration]]
        ]
        if let installationID = snapshot.configuration.installationID {
            resourceAttributes.append(["key": "device.id", "value": ["stringValue": installationID]])
            resourceAttributes.append(["key": "installation.id", "value": ["stringValue": installationID]])
        }

        let root: [String: Any] = [
            "resourceLogs": [[
                "resource": ["attributes": resourceAttributes],
                "scopeLogs": [[
                    "scope": ["name": "com.deepanshujain.familyos.logs"],
                    "logRecords": records
                ]]
            ]]
        ]

        guard JSONSerialization.isValidJSONObject(root) else {
            logger.error("OTLP logs payload is invalid")
            return nil
        }
        return try? JSONSerialization.data(withJSONObject: root)
    }

    private static func nonEmpty(_ value: String?) -> String? {
        let trimmed = value?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        return trimmed.isEmpty ? nil : trimmed
    }

    private static func currentInstallationID() -> String? {
        guard let installationID = try? HealthKitInstallationId.current() else {
            return nil
        }
        return nonEmpty(installationID)
    }

    private static func unixTimeNanoseconds() -> UInt64 {
        UInt64((Date().timeIntervalSince1970 * 1_000_000_000).rounded())
    }

    private static var buildConfiguration: String {
        #if DEBUG
        "debug"
        #else
        "release"
        #endif
    }

    private struct PendingLog {
        let body: String
        let severity: Severity
        let attributes: [String: String]
        let timeUnixNano: UInt64
    }

    private struct Configuration {
        let endpoint: URL
        let environment: String
        let version: String
        let build: String
        let buildConfiguration: String
        let installationID: String?
        let headers: [String: String]
        let requestSink: (@Sendable (URLRequest) -> Void)?
    }

    private struct Snapshot {
        let configuration: Configuration
        let entries: [PendingLog]
        let capturedAtUnixNanoseconds: UInt64
    }

    private final class Storage: @unchecked Sendable {
        let lock = NSLock()
        var configuration: Configuration?
        var pending: [PendingLog] = []
        var isFlushInFlight = false
        var lastFlush = Date.distantPast
    }
}
