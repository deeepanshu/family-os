import Foundation
import XCTest
@testable import FamilyOS

final class AppMetricsTests: XCTestCase {
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
