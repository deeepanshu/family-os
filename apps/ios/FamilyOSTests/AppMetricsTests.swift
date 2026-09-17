import Foundation
import XCTest
@testable import FamilyOS

final class AppMetricsTests: XCTestCase {
    override func tearDown() {
        AppMetrics.resetForTesting()
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
        XCTAssertEqual(point["bucketCounts"] as? [String], ["0", "0", "1", "0", "0", "0", "0"])
        XCTAssertEqual(point["explicitBounds"] as? [Double], [0.25, 1, 5, 15, 30, 60])
        XCTAssertEqual(histogram["aggregationTemporality"] as? Int, 2)
    }

    func testFlushIncludesAppIdentityResourceAttributes() throws {
        let delivered = expectation(description: "OTLP resource attributes")
        let recorder = RequestRecorder(expectation: delivered)

        AppMetrics.configureForTesting(endpoint: try XCTUnwrap(URL(string: "http://telemetry.lab:4318/v1/metrics"))) { request in
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

    func testHealthAPIErrorMetricCodeAllowlist() {
        XCTAssertEqual(HealthAPIError.missingToken.metricCode, .missingToken)
        XCTAssertEqual(HealthAPIError.badStatus(401, "expired", code: "unauthorized").metricCode, .unauthorized)
        XCTAssertEqual(HealthAPIError.badStatus(409, "locked", code: "healthkit_locked").metricCode, .healthkitLocked)
        XCTAssertEqual(HealthAPIError.badStatus(500, "boom", code: "not_a_real_code").metricCode, .other)
        XCTAssertNil(HealthAPIError.MetricCode(rawValue: "healthkit_loced"))
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
