import Foundation
import OSLog

/// Minimal OTLP/HTTP metrics client for the self-hosted observability stack.
///
/// Metrics must be fixed operational counters or durations. Never include health
/// readings, dates, free-text, tokens, email, or any other user data in names or attributes.
enum AppMetrics {
    private static let logger = Logger(subsystem: "com.deepanshujain.familyos", category: "AppMetrics")
    private static let storage = Storage()
    private static let durationBounds: [Double] = [0.25, 1, 5, 15, 30, 60]

    /// DEBUG builds remain silent unless this launch argument is present.
    private static let smokeLaunchArgument = "-FamilyOSMetricsSmoke"

    static func configure() {
        #if DEBUG
        guard ProcessInfo.processInfo.arguments.contains(smokeLaunchArgument) else {
            logger.notice("OTLP metrics disabled in DEBUG builds")
            return
        }
        #endif

        let environment = AppEnvironment.current
        guard let endpoint = URL(string: environment.otlpMetricsEndpoint),
              let scheme = endpoint.scheme?.lowercased(),
              let host = endpoint.host?.lowercased() else {
            logger.notice("OTLP metrics disabled: endpoint is not configured")
            return
        }

        let isLANEndpoint = scheme == "http" && host.hasSuffix(".lab")
        guard scheme == "https" || isLANEndpoint else {
            logger.error("OTLP metrics disabled: endpoint must use HTTPS or a .lab HTTP origin")
            return
        }

        var headers: [String: String] = [:]
        if !isLANEndpoint {
            guard !environment.metricsAccessClientID.isEmpty,
                  !environment.metricsAccessClientSecret.isEmpty else {
                logger.notice("OTLP metrics disabled: Cloudflare Access credentials are not configured")
                return
            }
            headers["CF-Access-Client-Id"] = environment.metricsAccessClientID
            headers["CF-Access-Client-Secret"] = environment.metricsAccessClientSecret
        }

        let info = Bundle.main.infoDictionary ?? [:]
        let configuration = Configuration(
            endpoint: endpoint,
            environment: environment.name.rawValue,
            version: Self.nonEmpty(info["CFBundleShortVersionString"] as? String) ?? "unknown",
            build: Self.nonEmpty(info["CFBundleVersion"] as? String) ?? "unknown",
            buildConfiguration: Self.buildConfiguration,
            headers: headers,
            startedAtUnixNanoseconds: unixTimeNanoseconds(),
            requestSink: nil
        )
        activate(configuration)
        logger.notice("OTLP metrics enabled (endpoint=\(endpoint.host ?? "unknown", privacy: .public))")
    }

    /// Test-only egress seam: captures the exact OTLP/HTTP request without a network dependency.
    static func configureForTesting(
        endpoint: URL,
        send: @escaping @Sendable (URLRequest) -> Void
    ) {
        activate(
            Configuration(
                endpoint: endpoint,
                environment: "test",
                version: "1.0",
                build: "1",
                buildConfiguration: "debug",
                headers: [:],
                startedAtUnixNanoseconds: unixTimeNanoseconds(),
                requestSink: send
            )
        )
    }

    private static func activate(_ configuration: Configuration) {
        storage.lock.lock()
        storage.configuration = configuration
        storage.counters.removeAll(keepingCapacity: true)
        storage.histograms.removeAll(keepingCapacity: true)
        storage.lastFlush = .distantPast
        storage.lock.unlock()

        increment("ios.launches")
    }

    /// Records a cumulative operational counter.
    static func increment(_ name: String, by value: Double = 1, attributes: [String: String] = [:]) {
        guard value.isFinite, value > 0 else { return }
        let key = MetricKey(name: name, attributes: metricAttributes(attributes))

        storage.lock.lock()
        defer { storage.lock.unlock() }
        guard storage.configuration != nil else { return }
        storage.counters[key, default: 0] += value
    }

    /// Records a duration into a cumulative OTLP histogram.
    static func observeDuration(_ name: String, seconds: TimeInterval, attributes: [String: String] = [:]) {
        guard seconds.isFinite, seconds >= 0 else { return }
        let key = MetricKey(name: name, attributes: metricAttributes(attributes))

        storage.lock.lock()
        defer { storage.lock.unlock() }
        guard storage.configuration != nil else { return }

        var histogram = storage.histograms[key] ?? Histogram(bucketCount: durationBounds.count + 1)
        histogram.count += 1
        histogram.sum += seconds
        let bucketIndex = durationBounds.firstIndex(where: { seconds <= $0 }) ?? durationBounds.count
        histogram.bucketCounts[bucketIndex] += 1
        storage.histograms[key] = histogram
    }

    /// Sends cumulative metrics at most once every 15 seconds unless forced.
    static func flush(force: Bool = false) {
        let snapshot: Snapshot

        storage.lock.lock()
        let now = Date()
        guard let configuration = storage.configuration,
              !storage.isFlushInFlight,
              (!storage.counters.isEmpty || !storage.histograms.isEmpty),
              force || now.timeIntervalSince(storage.lastFlush) >= 15 else {
            storage.lock.unlock()
            return
        }

        storage.isFlushInFlight = true
        storage.lastFlush = now
        snapshot = Snapshot(
            configuration: configuration,
            counters: storage.counters,
            histograms: storage.histograms,
            capturedAtUnixNanoseconds: unixTimeNanoseconds()
        )
        storage.lock.unlock()

        guard let body = payload(for: snapshot) else {
            completeFlush(success: false)
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
            completeFlush(success: true)
            return
        }

        URLSession.shared.dataTask(with: request) { _, response, error in
            let statusCode = (response as? HTTPURLResponse)?.statusCode
            let success = error == nil && statusCode.map { (200...299).contains($0) } == true
            if !success {
                logger.error("OTLP metrics flush failed status=\(statusCode ?? -1, privacy: .public)")
            }
            completeFlush(success: success)
        }.resume()
    }

    private static func completeFlush(success: Bool) {
        storage.lock.lock()
        storage.isFlushInFlight = false
        storage.lock.unlock()
    }

    private static func metricAttributes(_ values: [String: String]) -> [MetricAttribute] {
        values
            .compactMap { key, value -> MetricAttribute? in
                let cleanedKey = String(key.prefix(64))
                let cleanedValue = String(value.prefix(64))
                guard !cleanedKey.isEmpty,
                      !cleanedValue.isEmpty,
                      !cleanedKey.contains(where: { $0.isWhitespace || $0.isNewline }),
                      !cleanedValue.contains(where: { $0.isNewline }) else {
                    return nil
                }
                return MetricAttribute(key: cleanedKey, value: cleanedValue)
            }
            .sorted {
                if $0.key != $1.key {
                    return $0.key < $1.key
                }
                return $0.value < $1.value
            }
    }

    private static func unixTimeNanoseconds() -> UInt64 {
        UInt64((Date().timeIntervalSince1970 * 1_000_000_000).rounded())
    }

    private static func payload(for snapshot: Snapshot) -> Data? {
        let timestamp = String(snapshot.capturedAtUnixNanoseconds)
        let startTimestamp = String(snapshot.configuration.startedAtUnixNanoseconds)
        var metrics: [[String: Any]] = []

        for (key, value) in snapshot.counters.sorted(by: { $0.key < $1.key }) {
            metrics.append([
                "name": key.name,
                "sum": [
                    "dataPoints": [[
                        "attributes": otlpAttributes(key.attributes),
                        "startTimeUnixNano": startTimestamp,
                        "timeUnixNano": timestamp,
                        "asDouble": value
                    ]],
                    "aggregationTemporality": 2,
                    "isMonotonic": true
                ]
            ])
        }

        for (key, value) in snapshot.histograms.sorted(by: { $0.key < $1.key }) {
            metrics.append([
                "name": key.name,
                "histogram": [
                    "dataPoints": [[
                        "attributes": otlpAttributes(key.attributes),
                        "startTimeUnixNano": startTimestamp,
                        "timeUnixNano": timestamp,
                        "count": String(value.count),
                        "sum": value.sum,
                        "bucketCounts": value.bucketCounts.map(String.init),
                        "explicitBounds": durationBounds
                    ]],
                    "aggregationTemporality": 2
                ]
            ])
        }

        let root: [String: Any] = [
            "resourceMetrics": [[
                "resource": [
                    "attributes": otlpAttributes([
                        MetricAttribute(key: "service.name", value: "family-os-ios"),
                        MetricAttribute(key: "service.version", value: snapshot.configuration.version),
                        MetricAttribute(key: "deployment.environment", value: snapshot.configuration.environment),
                        MetricAttribute(key: "ios.build", value: snapshot.configuration.build),
                        MetricAttribute(key: "ios.build_configuration", value: snapshot.configuration.buildConfiguration)
                    ].sorted())
                ],
                "scopeMetrics": [[
                    "scope": ["name": "com.deepanshujain.familyos.metrics"],
                    "metrics": metrics
                ]]
            ]]
        ]

        guard JSONSerialization.isValidJSONObject(root) else {
            logger.error("OTLP metrics payload is invalid")
            return nil
        }
        return try? JSONSerialization.data(withJSONObject: root)
    }

    private static func otlpAttributes(_ attributes: [MetricAttribute]) -> [[String: Any]] {
        attributes.map {
            [
                "key": $0.key,
                "value": ["stringValue": $0.value]
            ]
        }
    }

    private static var buildConfiguration: String {
        #if DEBUG
        "debug"
        #else
        "release"
        #endif
    }

    private static func nonEmpty(_ value: String?) -> String? {
        guard let trimmed = value?.trimmingCharacters(in: .whitespacesAndNewlines), !trimmed.isEmpty else {
            return nil
        }
        return trimmed
    }

    private struct Configuration: Sendable {
        let endpoint: URL
        let environment: String
        let version: String
        let build: String
        let buildConfiguration: String
        let headers: [String: String]
        let startedAtUnixNanoseconds: UInt64
        let requestSink: (@Sendable (URLRequest) -> Void)?
    }

    private struct MetricAttribute: Hashable, Comparable, Sendable {
        let key: String
        let value: String

        static func < (lhs: MetricAttribute, rhs: MetricAttribute) -> Bool {
            if lhs.key != rhs.key {
                return lhs.key < rhs.key
            }
            return lhs.value < rhs.value
        }
    }

    private struct MetricKey: Hashable, Comparable, Sendable {
        let name: String
        let attributes: [MetricAttribute]

        static func < (lhs: MetricKey, rhs: MetricKey) -> Bool {
            if lhs.name != rhs.name {
                return lhs.name < rhs.name
            }
            return lhs.attributes.lexicographicallyPrecedes(rhs.attributes, by: <)
        }
    }

    private struct Histogram: Sendable {
        var count: UInt64 = 0
        var sum: Double = 0
        var bucketCounts: [UInt64]

        init(bucketCount: Int) {
            bucketCounts = Array(repeating: 0, count: bucketCount)
        }
    }

    private struct Snapshot: Sendable {
        let configuration: Configuration
        let counters: [MetricKey: Double]
        let histograms: [MetricKey: Histogram]
        let capturedAtUnixNanoseconds: UInt64
    }

    private final class Storage: @unchecked Sendable {
        let lock = NSLock()
        var configuration: Configuration?
        var counters: [MetricKey: Double] = [:]
        var histograms: [MetricKey: Histogram] = [:]
        var isFlushInFlight = false
        var lastFlush = Date.distantPast
    }
}
