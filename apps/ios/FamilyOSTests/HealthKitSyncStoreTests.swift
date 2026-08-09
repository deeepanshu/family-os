import XCTest
@testable import FamilyOS

final class HealthKitSyncStoreTests: XCTestCase {
    func testBatchEnqueueCoalescesInSingleTransaction() throws {
        let path = FileManager.default.temporaryDirectory
            .appendingPathComponent("healthkit-sync-batch-\(UUID().uuidString).sqlite")
            .path
        defer { try? FileManager.default.removeItem(atPath: path) }

        let store = try HealthKitSyncStore(path: path)
        let ops = (0..<5).map { i in
            PendingOpRecord(
                opId: UUID().uuidString.lowercased(),
                naturalKey: "sleep_day:2026-07-0\(i + 1)",
                groupKey: "sleep",
                scopeKey: "sleep",
                op: "upsert",
                payloadJSON: #"{"kind":"sleep_day","sleepDay":"2026-07-0\#(i + 1)","totalMinutes":1,"coreMinutes":0,"deepMinutes":0,"remMinutes":0,"unspecifiedAsleepMinutes":0,"awakeMinutes":0,"inBedMinutes":0}"#
            )
        }
        try store.enqueue(ops: ops)
        XCTAssertEqual(try store.pendingCount(group: "sleep"), 5)

        // Re-enqueue overlapping natural keys coalesces within the batch transaction.
        let again = [
            PendingOpRecord(
                opId: UUID().uuidString.lowercased(),
                naturalKey: "sleep_day:2026-07-01",
                groupKey: "sleep",
                scopeKey: "sleep",
                op: "upsert",
                payloadJSON: ops[0].payloadJSON
            )
        ]
        try store.enqueue(ops: again)
        XCTAssertEqual(try store.pendingCount(group: "sleep"), 5)
    }

    func testEnqueueClaimAppliedIdempotentPath() throws {
        let path = FileManager.default.temporaryDirectory
            .appendingPathComponent("healthkit-sync-test-\(UUID().uuidString).sqlite")
            .path
        defer { try? FileManager.default.removeItem(atPath: path) }

        let store = try HealthKitSyncStore(path: path)
        try store.saveConfiguration(
            userId: "user",
            personId: "person",
            installationId: "install",
            healthTimezone: "UTC",
            timezoneVersion: 1,
            enabledGroups: ["vitals"]
        )

        let opId = UUID().uuidString.lowercased()
        let key = "blood_pressure:\(UUID().uuidString.lowercased())"
        let payload = """
        {"kind":"blood_pressure","sourceObjectKey":"aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa","measuredAtUtc":"2026-07-20T08:00:00.000Z","systolic":120,"diastolic":80}
        """
        try store.enqueue(
            op: PendingOpRecord(
                opId: opId,
                naturalKey: key,
                groupKey: "vitals",
                scopeKey: "blood_pressure",
                op: "upsert",
                payloadJSON: payload
            )
        )
        XCTAssertEqual(try store.pendingCount(), 1)

        // Coalesce same natural key
        try store.enqueue(
            op: PendingOpRecord(
                opId: UUID().uuidString.lowercased(),
                naturalKey: key,
                groupKey: "vitals",
                scopeKey: "blood_pressure",
                op: "upsert",
                payloadJSON: payload
            )
        )
        XCTAssertEqual(try store.pendingCount(), 1)

        let batch = try store.claimBatch(limit: 10)
        XCTAssertEqual(batch.count, 1)
        XCTAssertEqual(try store.pendingCount(), 1) // still in_flight

        try store.markApplied(opIds: batch.map(\.opId))
        XCTAssertEqual(try store.pendingCount(), 0)
    }

    func testWorkerDrainAppliedAndDuplicate() async throws {
        let path = FileManager.default.temporaryDirectory
            .appendingPathComponent("healthkit-worker-test-\(UUID().uuidString).sqlite")
            .path
        defer { try? FileManager.default.removeItem(atPath: path) }

        let store = try HealthKitSyncStore(path: path)
        try store.saveConfiguration(
            userId: "user",
            personId: "person",
            installationId: "install",
            healthTimezone: "UTC",
            timezoneVersion: 1,
            enabledGroups: ["vitals"]
        )

        let opId = UUID().uuidString.lowercased()
        try store.enqueue(
            op: PendingOpRecord(
                opId: opId,
                naturalKey: "blood_pressure:bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
                groupKey: "vitals",
                scopeKey: "blood_pressure",
                op: "upsert",
                payloadJSON: """
                {"kind":"blood_pressure","sourceObjectKey":"bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb","measuredAtUtc":"2026-07-20T09:00:00.000Z","systolic":118,"diastolic":76}
                """
            )
        )

        final class CallCounter: @unchecked Sendable {
            var value = 0
        }
        let callCount = CallCounter()
        let worker = HealthKitSyncWorker(store: store) { request in
            callCount.value += 1
            XCTAssertEqual(request.ops.count, 1)
            XCTAssertEqual(request.ops[0].opId, opId)
            return HealthKitOpsBatchResult(
                results: [HealthKitOpApplyResultWire(opId: opId, result: "applied", errorCode: nil, errorMessage: nil)]
            )
        }

        let applied = try await worker.drain()
        XCTAssertEqual(applied, 1)
        XCTAssertEqual(callCount.value, 1)
        XCTAssertEqual(try store.pendingCount(), 0)

        // Re-enqueue same op id path is client-side new ids; simulate server duplicate:
        let opId2 = UUID().uuidString.lowercased()
        try store.enqueue(
            op: PendingOpRecord(
                opId: opId2,
                naturalKey: "blood_pressure:bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
                groupKey: "vitals",
                scopeKey: "blood_pressure",
                op: "upsert",
                payloadJSON: """
                {"kind":"blood_pressure","sourceObjectKey":"bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb","measuredAtUtc":"2026-07-20T09:00:00.000Z","systolic":118,"diastolic":76}
                """
            )
        )
        let worker2 = HealthKitSyncWorker(store: store) { request in
            HealthKitOpsBatchResult(
                results: request.ops.map {
                    HealthKitOpApplyResultWire(opId: $0.opId, result: "duplicate", errorCode: nil, errorMessage: nil)
                }
            )
        }
        let applied2 = try await worker2.drain()
        XCTAssertEqual(applied2, 1)
        XCTAssertEqual(try store.pendingCount(), 0)
    }

    func testSleepDayPayloadEnqueueAndEncode() throws {
        let path = FileManager.default.temporaryDirectory
            .appendingPathComponent("healthkit-sleep-test-\(UUID().uuidString).sqlite")
            .path
        defer { try? FileManager.default.removeItem(atPath: path) }

        let store = try HealthKitSyncStore(path: path)
        try store.saveConfiguration(
            userId: "user",
            personId: "person",
            installationId: "install",
            healthTimezone: "America/Los_Angeles",
            timezoneVersion: 1,
            enabledGroups: ["sleep"]
        )

        let samples = [
            HealthKitSleepDaySync.SleepDaySample(
                sleepDay: "2026-08-01",
                totalMinutes: 420,
                coreMinutes: 200,
                deepMinutes: 90,
                remMinutes: 100,
                unspecifiedAsleepMinutes: 30,
                awakeMinutes: 25,
                inBedMinutes: 450
            )
        ]
        try HealthKitSleepDaySync.enqueueSamples(samples, into: store)
        XCTAssertEqual(try store.pendingCount(group: "sleep"), 1)

        let batch = try store.claimBatch(limit: 10)
        XCTAssertEqual(batch.count, 1)
        XCTAssertEqual(batch[0].naturalKey, "sleep_day:2026-08-01")
        XCTAssertEqual(batch[0].groupKey, "sleep")
        XCTAssertEqual(batch[0].scopeKey, "sleep")

        let data = try XCTUnwrap(batch[0].payloadJSON?.data(using: .utf8))
        let payload = try JSONDecoder().decode(HealthKitOpPayloadWire.self, from: data)
        if case let .sleepDay(
            sleepDay, total, core, deep, rem, unspecified, awake, inBed
        ) = payload {
            XCTAssertEqual(sleepDay, "2026-08-01")
            XCTAssertEqual(total, 420)
            XCTAssertEqual(core, 200)
            XCTAssertEqual(deep, 90)
            XCTAssertEqual(rem, 100)
            XCTAssertEqual(unspecified, 30)
            XCTAssertEqual(awake, 25)
            XCTAssertEqual(inBed, 450)
        } else {
            XCTFail("Expected sleep_day payload")
        }

        // Round-trip encode
        let encoded = try JSONEncoder().encode(payload)
        let object = try JSONSerialization.jsonObject(with: encoded) as? [String: Any]
        XCTAssertEqual(object?["kind"] as? String, "sleep_day")
        XCTAssertEqual(object?["sleepDay"] as? String, "2026-08-01")
        XCTAssertEqual(object?["totalMinutes"] as? Int, 420)
    }

    func testMarkRejectedUsesOpGroupKey() throws {
        let path = FileManager.default.temporaryDirectory
            .appendingPathComponent("healthkit-reject-test-\(UUID().uuidString).sqlite")
            .path
        defer { try? FileManager.default.removeItem(atPath: path) }

        let store = try HealthKitSyncStore(path: path)
        let opId = UUID().uuidString.lowercased()
        try store.enqueue(
            op: PendingOpRecord(
                opId: opId,
                naturalKey: "sleep_day:2026-08-02",
                groupKey: "sleep",
                scopeKey: "sleep",
                op: "upsert",
                payloadJSON: """
                {"kind":"sleep_day","sleepDay":"2026-08-02","totalMinutes":60,"coreMinutes":60,"deepMinutes":0,"remMinutes":0,"unspecifiedAsleepMinutes":0,"awakeMinutes":0,"inBedMinutes":70}
                """
            )
        )
        _ = try store.claimBatch(limit: 1)
        try store.markRejected(opId: opId, errorCode: "payload_invalid")
        XCTAssertEqual(try store.pendingCount(group: "sleep"), 0)
        XCTAssertEqual(try store.groupStatus("sleep"), "error")
        // Must not pollute vitals group state when rejecting a sleep op.
        XCTAssertNotEqual(try store.groupStatus("vitals"), "error")
    }
}
