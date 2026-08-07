import XCTest
@testable import FamilyOS

/// Live local API + SQLite worker smoke (requires API on localhost:3001 with dev auth).
final class HealthKitLocalE2ETests: XCTestCase {
    private let baseURL = "http://localhost:3001/health/api/v1"
    private let token = "dev-token"
    private let client = HealthAPIClient()

    override func setUp() async throws {
        try await super.setUp()
        do {
            _ = try await client.healthcheck(baseURL: baseURL)
        } catch {
            throw XCTSkip("Local Health API not reachable at \(baseURL): \(error)")
        }
    }

    func testLocalOpsBatchBloodPressurePath() async throws {
        _ = try await client.bootstrap(baseURL: baseURL, accessToken: token)

        let profile: HealthProfile
        do {
            profile = try await client.createSelfProfile(
                baseURL: baseURL,
                accessToken: token,
                displayName: "Simulator E2E"
            )
        } catch {
            // Profile may already exist from prior runs — bootstrap for self profile.
            let boot = try await client.bootstrap(baseURL: baseURL, accessToken: token)
            guard let selfProfile = boot.selfProfile else {
                throw error
            }
            profile = selfProfile
        }

        let installationId = UUID().uuidString.lowercased()
        let settings = try await client.putHealthKitSettings(
            baseURL: baseURL,
            accessToken: token,
            personId: profile.id,
            consentVersion: "2026-08-02-e2e",
            enabledGroups: [.vitals],
            healthTimezone: "UTC",
            installationId: installationId,
            replaceActiveInstallation: true
        )
        XCTAssertTrue(settings.enabledGroups.contains(.vitals))
        XCTAssertEqual(settings.activeInstallationId, installationId)

        _ = try await client.startHealthKitImport(
            baseURL: baseURL,
            accessToken: token,
            group: "vitals",
            installationId: installationId,
            personId: profile.id,
            timezoneVersion: settings.healthTimezoneVersion
        )

        let path = FileManager.default.temporaryDirectory
            .appendingPathComponent("healthkit-e2e-\(UUID().uuidString).sqlite")
            .path
        defer { try? FileManager.default.removeItem(atPath: path) }

        let store = try HealthKitSyncStore(path: path)
        try store.saveConfiguration(
            userId: "00000000-0000-4000-8000-000000000001",
            personId: profile.id,
            installationId: installationId,
            healthTimezone: "UTC",
            timezoneVersion: settings.healthTimezoneVersion,
            enabledGroups: ["vitals"]
        )

        let sourceKey = UUID().uuidString.lowercased()
        let payload = HealthKitOpPayloadWire.bloodPressure(
            sourceObjectKey: sourceKey,
            measuredAtUtc: "2026-08-01T12:00:00.000Z",
            systolic: 128,
            diastolic: 82,
            pulse: 68
        )
        let data = try JSONEncoder().encode(payload)
        let json = String(data: data, encoding: .utf8)
        try store.enqueue(
            op: PendingOpRecord(
                opId: UUID().uuidString.lowercased(),
                naturalKey: "blood_pressure:\(sourceKey)",
                groupKey: "vitals",
                scopeKey: "blood_pressure",
                op: "upsert",
                payloadJSON: json
            )
        )
        XCTAssertEqual(try store.pendingCount(), 1)

        let apiClient = client
        let apiBase = baseURL
        let apiToken = token
        let worker = HealthKitSyncWorker(store: store) { batch in
            try await apiClient.postHealthKitOpsBatch(
                baseURL: apiBase,
                accessToken: apiToken,
                body: batch
            )
        }
        let applied = try await worker.drain()
        XCTAssertEqual(applied, 1)
        XCTAssertEqual(try store.pendingCount(), 0)

        // Idempotent re-upload of same op_id is server-side; new op overwrites natural key.
        let opId2 = UUID().uuidString.lowercased()
        try store.enqueue(
            op: PendingOpRecord(
                opId: opId2,
                naturalKey: "blood_pressure:\(sourceKey)",
                groupKey: "vitals",
                scopeKey: "blood_pressure",
                op: "upsert",
                payloadJSON: json
            )
        )
        let applied2 = try await worker.drain()
        XCTAssertEqual(applied2, 1)

        _ = try await client.markHealthKitGroupReady(
            baseURL: baseURL,
            accessToken: token,
            group: "vitals",
            installationId: installationId,
            personId: profile.id,
            timezoneVersion: settings.healthTimezoneVersion
        )

        let readings = try await client.listBloodPressure(
            baseURL: baseURL,
            accessToken: token,
            personId: profile.id
        )
        let match = readings.first { $0.systolic == 128 && $0.diastolic == 82 }
        XCTAssertNotNil(match, "Expected BP 128/82 in API readings after worker drain")
    }

    func testLocalOpsBatchSleepDayEncodePath() async throws {
        _ = try await client.bootstrap(baseURL: baseURL, accessToken: token)

        let profile: HealthProfile
        do {
            profile = try await client.createSelfProfile(
                baseURL: baseURL,
                accessToken: token,
                displayName: "Simulator Sleep E2E"
            )
        } catch {
            let boot = try await client.bootstrap(baseURL: baseURL, accessToken: token)
            guard let selfProfile = boot.selfProfile else { throw error }
            profile = selfProfile
        }

        let installationId = UUID().uuidString.lowercased()
        let settings = try await client.putHealthKitSettings(
            baseURL: baseURL,
            accessToken: token,
            personId: profile.id,
            consentVersion: "2026-08-02-e2e-sleep",
            enabledGroups: [.sleep],
            healthTimezone: "UTC",
            installationId: installationId,
            replaceActiveInstallation: true
        )
        XCTAssertTrue(settings.enabledGroups.contains(.sleep))

        _ = try await client.startHealthKitImport(
            baseURL: baseURL,
            accessToken: token,
            group: "sleep",
            installationId: installationId,
            personId: profile.id,
            timezoneVersion: settings.healthTimezoneVersion
        )

        let path = FileManager.default.temporaryDirectory
            .appendingPathComponent("healthkit-e2e-sleep-\(UUID().uuidString).sqlite")
            .path
        defer { try? FileManager.default.removeItem(atPath: path) }

        let store = try HealthKitSyncStore(path: path)
        try store.saveConfiguration(
            userId: "00000000-0000-4000-8000-000000000001",
            personId: profile.id,
            installationId: installationId,
            healthTimezone: "UTC",
            timezoneVersion: settings.healthTimezoneVersion,
            enabledGroups: ["sleep"]
        )

        let payload = HealthKitOpPayloadWire.sleepDay(
            sleepDay: "2026-08-01",
            totalMinutes: 420,
            coreMinutes: 200,
            deepMinutes: 90,
            remMinutes: 100,
            unspecifiedAsleepMinutes: 30,
            awakeMinutes: 20,
            inBedMinutes: 450
        )
        let data = try JSONEncoder().encode(payload)
        let json = String(data: data, encoding: .utf8)
        try store.enqueue(
            op: PendingOpRecord(
                opId: UUID().uuidString.lowercased(),
                naturalKey: "sleep_day:2026-08-01",
                groupKey: "sleep",
                scopeKey: "sleep",
                op: "upsert",
                payloadJSON: json
            )
        )

        let apiClient = client
        let apiBase = baseURL
        let apiToken = token
        let worker = HealthKitSyncWorker(store: store) { batch in
            try await apiClient.postHealthKitOpsBatch(
                baseURL: apiBase,
                accessToken: apiToken,
                body: batch
            )
        }
        let applied = try await worker.drain()
        XCTAssertEqual(applied, 1)
        XCTAssertEqual(try store.pendingCount(), 0)

        _ = try await client.markHealthKitGroupReady(
            baseURL: baseURL,
            accessToken: token,
            group: "sleep",
            installationId: installationId,
            personId: profile.id,
            timezoneVersion: settings.healthTimezoneVersion
        )
    }
}
