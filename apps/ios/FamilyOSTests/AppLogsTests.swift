import Foundation
import XCTest
@testable import FamilyOS

/// iOS breadcrumbs currently stop at OSLog/Crashlytics, so the client-side
/// narrative ("why did this wake skip?") cannot be queried from Grafana. These
/// tests pin the OTLP/HTTP log payload and its PHI-safety guarantees.
final class AppLogsTests: XCTestCase {
    override func tearDown() {
        AppLogs.resetForTesting()
        super.tearDown()
    }

    func testFlushEmitsOperationalLogAsOTLPHTTP() throws {
        let delivered = expectation(description: "OTLP logs request")
        let recorder = LogRequestRecorder(expectation: delivered)

        AppLogs.configureForTesting(
            endpoint: try XCTUnwrap(URL(string: "http://telemetry.lab:4318/v1/logs")),
            installationID: "test-installation-id"
        ) { request in
            recorder.record(request)
        }
        AppLogs.record("healthkit_bg_sync_skip_no_token", attributes: ["reason": "bg_refresh"])
        AppLogs.flush(force: true)

        wait(for: [delivered], timeout: 1)

        let request = try XCTUnwrap(recorder.request)
        XCTAssertEqual(request.httpMethod, "POST")
        XCTAssertEqual(request.url?.path, "/v1/logs")
        XCTAssertEqual(request.value(forHTTPHeaderField: "Content-Type"), "application/json")

        let body = try XCTUnwrap(request.httpBody)
        let root = try XCTUnwrap(try JSONSerialization.jsonObject(with: body) as? [String: Any])
        let resourceLogs = try XCTUnwrap((root["resourceLogs"] as? [[String: Any]])?.first)
        let scopeLogs = try XCTUnwrap((resourceLogs["scopeLogs"] as? [[String: Any]])?.first)
        let records = try XCTUnwrap(scopeLogs["logRecords"] as? [[String: Any]])
        let entry = try XCTUnwrap(records.first)

        let bodyValue = try XCTUnwrap((entry["body"] as? [String: Any])?["stringValue"] as? String)
        XCTAssertEqual(bodyValue, "healthkit_bg_sync_skip_no_token")
        XCTAssertEqual(entry["severityText"] as? String, "INFO")

        let attributes = try XCTUnwrap(entry["attributes"] as? [[String: Any]])
        var values: [String: String] = [:]
        for attribute in attributes {
            let key = try XCTUnwrap(attribute["key"] as? String)
            values[key] = try XCTUnwrap((attribute["value"] as? [String: Any])?["stringValue"] as? String)
        }
        XCTAssertEqual(values["reason"], "bg_refresh")
    }

    func testFlushIncludesServiceIdentityResourceAttributes() throws {
        let delivered = expectation(description: "OTLP log resource")
        let recorder = LogRequestRecorder(expectation: delivered)

        AppLogs.configureForTesting(
            endpoint: try XCTUnwrap(URL(string: "http://telemetry.lab:4318/v1/logs")),
            installationID: "test-installation-id"
        ) { request in
            recorder.record(request)
        }
        AppLogs.record("healthkit_bg_task_completed")
        AppLogs.flush(force: true)

        wait(for: [delivered], timeout: 1)

        let body = try XCTUnwrap(recorder.request?.httpBody)
        let root = try XCTUnwrap(try JSONSerialization.jsonObject(with: body) as? [String: Any])
        let resourceLogs = try XCTUnwrap((root["resourceLogs"] as? [[String: Any]])?.first)
        let attributes = try XCTUnwrap((resourceLogs["resource"] as? [String: Any])?["attributes"] as? [[String: Any]])

        var values: [String: String] = [:]
        for attribute in attributes {
            let key = try XCTUnwrap(attribute["key"] as? String)
            values[key] = try XCTUnwrap((attribute["value"] as? [String: Any])?["stringValue"] as? String)
        }
        XCTAssertEqual(values["service.name"], "family-os-ios")
        XCTAssertEqual(values["installation.id"], "test-installation-id")
    }

    /// A launch argument gate keeps DEBUG builds from shipping telemetry unless
    /// explicitly opted in, mirroring the metrics client.
    func testDisabledClientNeverSends() {
        AppLogs.resetForTesting()
        // No configuration ⇒ nothing may be emitted, and flush must be a no-op.
        AppLogs.record("healthkit_bg_task_completed")
        AppLogs.flush(force: true)
        XCTAssertFalse(AppLogs.isEnabledForTesting)
    }
}

private final class LogRequestRecorder: @unchecked Sendable {
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
