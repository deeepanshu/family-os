import Foundation
import XCTest
@testable import FamilyOS

final class AppMetricsTests: XCTestCase {
    override func tearDown() {
        AppMetrics.resetForTesting()
        AppLogs.resetForTesting()
        super.tearDown()
    }
    func testFlushEmitsCumulativeOperationalCountersAsOTLPHTTP() throws {
        let delivered = expectation(description: "OTLP metrics request")
        let recorder = RequestRecorder(expectation: delivered)

        AppMetrics.configureForTesting(endpoint: try XCTUnwrap(URL(string: "http://telemetry.lab:4318/v1/metrics"))) { request in
            recorder.record(request)
        }
        AppMetrics.increment("ios.sync.completed", by: 2, attributes: ["reason": "observer"])
        AppMetrics.flush(force: true)

        wait(for: [delivered], timeout: 1)

        let request = try XCTUnwrap(recorder.request)
        XCTAssertEqual(request.httpMethod, "POST")
        XCTAssertEqual(request.url?.path, "/v1/metrics")
        XCTAssertEqual(request.value(forHTTPHeaderField: "Content-Type"), "application/json")
        XCTAssertNil(request.value(forHTTPHeaderField: "CF-Access-Client-Id"))

        let body = try XCTUnwrap(request.httpBody)
        let root = try XCTUnwrap(try JSONSerialization.jsonObject(with: body) as? [String: Any])
        let metrics = try XCTUnwrap(
            (((root["resourceMetrics"] as? [[String: Any]])?.first?["scopeMetrics"] as? [[String: Any]])?.first?["metrics"] as? [[String: Any]])
        )

        let names = Set(metrics.compactMap { $0["name"] as? String })
        XCTAssertEqual(names, ["ios.launches", "ios.sync.completed"])

        let completed = try XCTUnwrap(metrics.first { $0["name"] as? String == "ios.sync.completed" })
        let sum = try XCTUnwrap(completed["sum"] as? [String: Any])
        let points = try XCTUnwrap(sum["dataPoints"] as? [[String: Any]])
        XCTAssertEqual(points.first?["asDouble"] as? Double, 2)
        let attributeValue = try XCTUnwrap((points.first?["attributes"] as? [[String: Any]])?.first?["value"] as? [String: Any])
        XCTAssertEqual(attributeValue["stringValue"] as? String, "observer")
        XCTAssertEqual(sum["aggregationTemporality"] as? Int, 2)
        XCTAssertEqual(sum["isMonotonic"] as? Bool, true)
    }

    func testFlushEmitsSyncDurationAsCumulativeHistogram() throws {
        let delivered = expectation(description: "OTLP histogram request")
        let recorder = RequestRecorder(expectation: delivered)

        AppMetrics.configureForTesting(endpoint: try XCTUnwrap(URL(string: "http://telemetry.lab:4318/v1/metrics"))) { request in
            recorder.record(request)
        }
        AppMetrics.observeDuration(
            "ios.healthkit.sync.duration.seconds",
            seconds: 1.5,
            attributes: ["group": "sleep", "reason": "observer"]
        )
        AppMetrics.flush(force: true)

        wait(for: [delivered], timeout: 1)

        let request = try XCTUnwrap(recorder.request)
        let body = try XCTUnwrap(request.httpBody)
        let root = try XCTUnwrap(try JSONSerialization.jsonObject(with: body) as? [String: Any])
        let metrics = try XCTUnwrap(
            (((root["resourceMetrics"] as? [[String: Any]])?.first?["scopeMetrics"] as? [[String: Any]])?.first?["metrics"] as? [[String: Any]])
        )
        let duration = try XCTUnwrap(metrics.first { $0["name"] as? String == "ios.healthkit.sync.duration.seconds" })
        let histogram = try XCTUnwrap(duration["histogram"] as? [String: Any])
        let point = try XCTUnwrap((histogram["dataPoints"] as? [[String: Any]])?.first)

        XCTAssertEqual(point["count"] as? String, "1")
        XCTAssertEqual(point["sum"] as? Double, 1.5)
        XCTAssertEqual(point["bucketCounts"] as? [String], ["0", "0", "1", "0", "0", "0", "0", "0", "0", "0", "0"])
        XCTAssertEqual(point["explicitBounds"] as? [Double], [0.25, 1, 5, 15, 30, 60, 300, 900, 1800, 3600])
        XCTAssertEqual(histogram["aggregationTemporality"] as? Int, 2)
    }

    func testFlushIncludesAppIdentityResourceAttributes() throws {
        let delivered = expectation(description: "OTLP resource attributes")
        let recorder = RequestRecorder(expectation: delivered)

        AppMetrics.configureForTesting(
            endpoint: try XCTUnwrap(URL(string: "http://telemetry.lab:4318/v1/metrics")),
            installationID: "test-installation-id"
        ) { request in
            recorder.record(request)
        }
        AppMetrics.flush(force: true)

        wait(for: [delivered], timeout: 1)

        let body = try XCTUnwrap(recorder.request?.httpBody)
        let root = try XCTUnwrap(try JSONSerialization.jsonObject(with: body) as? [String: Any])
        let attributes = try XCTUnwrap(
            ((root["resourceMetrics"] as? [[String: Any]])?.first?["resource"] as? [String: Any])?["attributes"] as? [[String: Any]]
        )

        var values: [String: String] = [:]
        for attribute in attributes {
            let key = try XCTUnwrap(attribute["key"] as? String)
            values[key] = try XCTUnwrap((attribute["value"] as? [String: Any])?["stringValue"] as? String)
        }

        XCTAssertEqual(values["service.name"], "family-os-ios")
        XCTAssertEqual(values["service.version"], "1.0")
        XCTAssertEqual(values["ios.build"], "1")
        XCTAssertEqual(values["deployment.environment"], "test")
        XCTAssertEqual(values["ios.build_configuration"], "debug")
        XCTAssertEqual(values["device.id"], "test-installation-id")
        XCTAssertEqual(values["installation.id"], "test-installation-id")
    }

    func testFlushEmitsBootstrapUnauthorizedCounter() throws {
        let delivered = expectation(description: "OTLP bootstrap counter")
        let recorder = RequestRecorder(expectation: delivered)

        AppMetrics.configureForTesting(endpoint: try XCTUnwrap(URL(string: "http://telemetry.lab:4318/v1/metrics"))) { request in
            recorder.record(request)
        }
        AppMetrics.recordBootstrap(.unauthorized)
        AppMetrics.flush(force: true)

        wait(for: [delivered], timeout: 1)

        let point = try counterPoint(named: "ios.bootstrap.requests", in: recorder.request)
        XCTAssertEqual(point.value, 1)
        XCTAssertEqual(point.attributes["outcome"], "unauthorized")
    }

    func testFlushEmitsHealthKitSkipReason() throws {
        let delivered = expectation(description: "OTLP skip counter")
        let recorder = RequestRecorder(expectation: delivered)

        AppMetrics.configureForTesting(endpoint: try XCTUnwrap(URL(string: "http://telemetry.lab:4318/v1/metrics"))) { request in
            recorder.record(request)
        }
        AppMetrics.recordHealthKitSkip(
            reason: "bg_refresh",
            skipReason: .notBackgroundEnabled,
            group: "activity"
        )
        AppMetrics.flush(force: true)

        wait(for: [delivered], timeout: 1)

        let point = try counterPoint(named: "ios.healthkit.sync.skips", in: recorder.request)
        XCTAssertEqual(point.value, 1)
        XCTAssertEqual(point.attributes["reason"], "bg_refresh")
        XCTAssertEqual(point.attributes["skip_reason"], "not_background_enabled")
        XCTAssertEqual(point.attributes["group"], "activity")
    }

    func testFlushEmitsAuthSignInRefreshAndSignOut() throws {
        let delivered = expectation(description: "OTLP auth counters")
        let recorder = RequestRecorder(expectation: delivered)

        AppMetrics.configureForTesting(endpoint: try XCTUnwrap(URL(string: "http://telemetry.lab:4318/v1/metrics"))) { request in
            recorder.record(request)
        }
        AppMetrics.recordSignIn(.success)
        AppMetrics.recordRefresh(source: .ui, outcome: .failed)
        AppMetrics.recordSignOut(reason: .unauthorized)
        AppMetrics.recordAuthRetry(.recovered)
        AppMetrics.recordHealthKitFailed(
            reason: "foreground",
            group: "vitals",
            error: HealthAPIError.badStatus(401, "expired", code: "unauthorized")
        )
        AppMetrics.flush(force: true)

        wait(for: [delivered], timeout: 1)

        let signIn = try counterPoint(named: "ios.auth.sign_in", in: recorder.request)
        XCTAssertEqual(signIn.attributes["outcome"], "success")
        let refresh = try counterPoint(named: "ios.auth.refresh", in: recorder.request)
        XCTAssertEqual(refresh.attributes["source"], "ui")
        XCTAssertEqual(refresh.attributes["outcome"], "failed")
        let signOut = try counterPoint(named: "ios.auth.sign_out", in: recorder.request)
        XCTAssertEqual(signOut.attributes["reason"], "unauthorized")
        let retry = try counterPoint(named: "ios.auth.api_retry", in: recorder.request)
        XCTAssertEqual(retry.attributes["outcome"], "recovered")
        let failed = try counterPoint(named: "ios.healthkit.sync.failures", in: recorder.request)
        XCTAssertEqual(failed.attributes["code"], "unauthorized")
        XCTAssertEqual(failed.attributes["group"], "vitals")
    }

    func testFlushAndWaitDeliversTerminalMetric() async throws {
        let delivered = expectation(description: "terminal OTLP metrics request")
        let recorder = RequestRecorder(expectation: delivered)

        AppMetrics.configureForTesting(endpoint: try XCTUnwrap(URL(string: "http://telemetry.lab:4318/v1/metrics"))) { request in
            recorder.record(request)
        }
        AppMetrics.recordHealthKitSkip(reason: "bg_refresh", skipReason: .runInProgress)

        let didFlush = await AppMetrics.flushAndWait(force: true)
        XCTAssertTrue(didFlush)
        await fulfillment(of: [delivered], timeout: 1)

        let skipped = try counterPoint(named: "ios.healthkit.sync.skips", in: recorder.request)
        XCTAssertEqual(skipped.attributes["skip_reason"], "run_in_progress")
    }

    /// The expiration handler runs in an unstructured Task precisely because the
    /// cancelled work Task's own trailing flushAndWaits return early. This pins
    /// the fix: one expired run must deliver both its metrics counters and its
    /// terminal log before the task completes.
    func testBackgroundExpirationFlushDeliversMetricsAndLog() async throws {
        let metricsDelivered = expectation(description: "expiration OTLP metrics request")
        let metricsRecorder = RequestRecorder(expectation: metricsDelivered)
        let logsDelivered = expectation(description: "expiration OTLP log request")
        let logsRecorder = ExpirationLogRecorder(expectation: logsDelivered)

        AppMetrics.configureForTesting(endpoint: try XCTUnwrap(URL(string: "http://telemetry.lab:4318/v1/metrics"))) { request in
            metricsRecorder.record(request)
        }
        AppLogs.configureForTesting(endpoint: try XCTUnwrap(URL(string: "http://telemetry.lab:4318/v1/logs"))) { request in
            logsRecorder.record(request)
        }
        AppMetrics.recordHealthKitSkip(reason: "bg_task", skipReason: .runInProgress)

        await HealthKitBackgroundSync.flushForBackgroundExpiration(
            reason: "bg_task",
            message: "healthkit_bg_task_expired"
        )
        await fulfillment(of: [metricsDelivered, logsDelivered], timeout: 1)

        let skipped = try counterPoint(named: "ios.healthkit.sync.skips", in: metricsRecorder.request)
        XCTAssertEqual(skipped.value, 1)
        XCTAssertEqual(skipped.attributes["skip_reason"], "run_in_progress")

        let body = try XCTUnwrap(logsRecorder.request?.httpBody)
        let root = try XCTUnwrap(try JSONSerialization.jsonObject(with: body) as? [String: Any])
        let resourceLogs = try XCTUnwrap((root["resourceLogs"] as? [[String: Any]])?.first)
        let scopeLogs = try XCTUnwrap((resourceLogs["scopeLogs"] as? [[String: Any]])?.first)
        let entry = try XCTUnwrap((scopeLogs["logRecords"] as? [[String: Any]])?.first)
        XCTAssertEqual((entry["body"] as? [String: Any])?["stringValue"] as? String, "healthkit_bg_task_expired")
        XCTAssertEqual(entry["severityText"] as? String, "WARN")
        XCTAssertEqual(entry["severityNumber"] as? Int, 13)
    }

    func testHealthAPIErrorMetricCodeAllowlist() {
        XCTAssertEqual(HealthAPIError.missingToken.metricCode, .missingToken)
        XCTAssertEqual(HealthAPIError.badStatus(401, "expired", code: "unauthorized").metricCode, .unauthorized)
        XCTAssertEqual(HealthAPIError.badStatus(409, "locked", code: "healthkit_locked").metricCode, .healthkitLocked)
        XCTAssertEqual(HealthAPIError.badStatus(500, "boom", code: "not_a_real_code").metricCode, .other)
        XCTAssertNil(HealthAPIError.MetricCode(rawValue: "healthkit_loced"))
    }

    /// `Date()` keeps advancing while iOS has the process suspended, so a frozen
    /// run looked like hours of work. Accounting the two clocks together is what
    /// separates "genuinely slow" from "the OS froze us".
    func testSuspensionAccountingSeparatesActiveTimeFromFreezeTime() {
        let suspended = SyncDurationAccounting.account(activeSeconds: 2, wallSeconds: 3599.88)
        XCTAssertEqual(suspended.activeSeconds, 2)
        XCTAssertEqual(suspended.wallSeconds, 3599.88)
        XCTAssertEqual(suspended.suspendedSeconds, 3597.88, accuracy: 0.01)
        XCTAssertTrue(suspended.wasSuspended)

        // A genuinely slow query advances the monotonic clock, so nothing is
        // attributed to suspension.
        let hung = SyncDurationAccounting.account(activeSeconds: 3599.88, wallSeconds: 3599.88)
        XCTAssertEqual(hung.suspendedSeconds, 0, accuracy: 0.01)
        XCTAssertFalse(hung.wasSuspended)
    }

    func testSuspensionAccountingIgnoresSmallClockSkew() {
        let jitter = SyncDurationAccounting.account(activeSeconds: 3, wallSeconds: 3.4)
        XCTAssertFalse(jitter.wasSuspended)
        XCTAssertEqual(jitter.suspendedSeconds, 0, accuracy: 0.01)
    }

    /// The old top bound was 60s, so every freeze collapsed into `+Inf` and the
    /// p95 panel read healthy while the tail was hours long.
    func testDurationHistogramBoundsCoverSuspensionScaleDurations() throws {
        let delivered = expectation(description: "OTLP histogram bounds")
        let recorder = RequestRecorder(expectation: delivered)

        AppMetrics.configureForTesting(endpoint: try XCTUnwrap(URL(string: "http://telemetry.lab:4318/v1/metrics"))) { request in
            recorder.record(request)
        }
        AppMetrics.observeDuration(
            "ios.healthkit.sync.duration.seconds",
            seconds: 300,
            attributes: ["group": "sleep"]
        )
        AppMetrics.flush(force: true)

        wait(for: [delivered], timeout: 1)

        let body = try XCTUnwrap(recorder.request?.httpBody)
        let root = try XCTUnwrap(try JSONSerialization.jsonObject(with: body) as? [String: Any])
        let metrics = try XCTUnwrap(
            (((root["resourceMetrics"] as? [[String: Any]])?.first?["scopeMetrics"] as? [[String: Any]])?.first?["metrics"] as? [[String: Any]])
        )
        let duration = try XCTUnwrap(metrics.first { $0["name"] as? String == "ios.healthkit.sync.duration.seconds" })
        let histogram = try XCTUnwrap(duration["histogram"] as? [String: Any])
        let point = try XCTUnwrap((histogram["dataPoints"] as? [[String: Any]])?.first)

        let bounds = try XCTUnwrap(point["explicitBounds"] as? [Double])
        XCTAssertTrue(bounds.contains(300), "A 300s observation must land in a real bucket, not +Inf")
        XCTAssertEqual(bounds.last, 3600)

        let buckets = try XCTUnwrap(point["bucketCounts"] as? [String])
        XCTAssertEqual(buckets.last, "0", "Nothing may fall into the +Inf overflow bucket")
    }
}

private final class RequestRecorder: @unchecked Sendable {
    private let lock = NSLock()
    private let expectation: XCTestExpectation
    private(set) var request: URLRequest?

    init(expectation: XCTestExpectation) {
        self.expectation = expectation
    }

    func record(_ request: URLRequest) {
        lock.lock()
        self.request = request
        lock.unlock()
        expectation.fulfill()
    }
}
private final class ExpirationLogRecorder: @unchecked Sendable {
    private let lock = NSLock()
    private let expectation: XCTestExpectation
    private(set) var request: URLRequest?

    init(expectation: XCTestExpectation) {
        self.expectation = expectation
    }

    func record(_ request: URLRequest) {
        lock.lock()
        self.request = request
        lock.unlock()
        expectation.fulfill()
    }
}


func counterPoint(named name: String, in request: URLRequest?) throws -> (value: Double, attributes: [String: String]) {
    let body = try XCTUnwrap(request?.httpBody)
    let root = try XCTUnwrap(try JSONSerialization.jsonObject(with: body) as? [String: Any])
    let metrics = try XCTUnwrap(
        (((root["resourceMetrics"] as? [[String: Any]])?.first?["scopeMetrics"] as? [[String: Any]])?.first?["metrics"] as? [[String: Any]])
    )
    let metric = try XCTUnwrap(metrics.first { $0["name"] as? String == name })
    let sum = try XCTUnwrap(metric["sum"] as? [String: Any])
    let point = try XCTUnwrap((sum["dataPoints"] as? [[String: Any]])?.first)
    let value = try XCTUnwrap(point["asDouble"] as? Double)
    var attributes: [String: String] = [:]
    for attribute in (point["attributes"] as? [[String: Any]]) ?? [] {
        let key = try XCTUnwrap(attribute["key"] as? String)
        attributes[key] = try XCTUnwrap((attribute["value"] as? [String: Any])?["stringValue"] as? String)
    }
    return (value, attributes)
}

func otlpMetricNames(in request: URLRequest?) throws -> Set<String> {
    let body = try XCTUnwrap(request?.httpBody)
    let root = try XCTUnwrap(try JSONSerialization.jsonObject(with: body) as? [String: Any])
    let metrics = try XCTUnwrap(
        (((root["resourceMetrics"] as? [[String: Any]])?.first?["scopeMetrics"] as? [[String: Any]])?.first?["metrics"] as? [[String: Any]])
    )
    return Set(metrics.compactMap { $0["name"] as? String })
}
