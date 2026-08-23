import HealthKit
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

    func testSleepAggregationKeepsOvernightNightOnTruncatedSyncWindow() throws {
        let iso = ISO8601DateFormatter()
        iso.formatOptions = [.withInternetDateTime]

        // Watch night 22:00 → 07:00, then a 32-minute nap ending the same local day.
        // A 24h sync that starts at yesterday's wake (~07:00) would previously
        // drop the overnight samples via strictStartDate and upsert only 32m.
        let nightStart = try XCTUnwrap(iso.date(from: "2026-08-17T22:00:00Z"))
        let nightEnd = try XCTUnwrap(iso.date(from: "2026-08-18T07:00:00Z"))
        let napStart = try XCTUnwrap(iso.date(from: "2026-08-18T13:00:00Z"))
        let napEnd = try XCTUnwrap(iso.date(from: "2026-08-18T13:32:00Z"))
        let queryStart = try XCTUnwrap(iso.date(from: "2026-08-17T07:00:00Z"))
        let rangeEnd = try XCTUnwrap(iso.date(from: "2026-08-18T14:00:00Z"))

        let days = HealthKitSleepDaySync.aggregateSleepDays(
            intervals: [
                .init(
                    start: nightStart,
                    end: nightEnd,
                    value: HKCategoryValueSleepAnalysis.asleepCore.rawValue,
                    sourceBundleId: "com.apple.health.watch",
                    sourceName: "Apple Watch"
                ),
                .init(
                    start: napStart,
                    end: napEnd,
                    value: HKCategoryValueSleepAnalysis.asleepUnspecified.rawValue,
                    sourceBundleId: "com.apple.health.watch",
                    sourceName: "Apple Watch"
                )
            ],
            healthTimezone: "UTC",
            queryStart: queryStart,
            rangeEnd: rangeEnd
        )

        XCTAssertEqual(days.count, 1)
        XCTAssertEqual(days[0].sleepDay, "2026-08-18")
        XCTAssertEqual(days[0].totalMinutes, 540 + 32)
        XCTAssertEqual(days[0].coreMinutes, 540)
        XCTAssertEqual(days[0].unspecifiedAsleepMinutes, 32)
    }

    func testSleepAggregationPutsOvernightStagesOnWakeDay() throws {
        let iso = ISO8601DateFormatter()
        iso.formatOptions = [.withInternetDateTime]

        // Watch night: 23:05 → 06:30. Pre-midnight stages used to land on yesterday.
        let queryStart = try XCTUnwrap(iso.date(from: "2026-08-17T07:00:00Z"))
        let rangeEnd = try XCTUnwrap(iso.date(from: "2026-08-18T14:00:00Z"))
        let watch = "com.apple.health.watch"

        func interval(_ start: String, _ end: String, _ value: HKCategoryValueSleepAnalysis) throws -> HealthKitSleepDaySync.SleepInterval {
            .init(
                start: try XCTUnwrap(iso.date(from: start)),
                end: try XCTUnwrap(iso.date(from: end)),
                value: value.rawValue,
                sourceBundleId: watch,
                sourceName: "Apple Watch"
            )
        }

        let days = HealthKitSleepDaySync.aggregateSleepDays(
            intervals: [
                try interval("2026-08-17T23:05:00Z", "2026-08-17T23:40:00Z", .asleepCore),
                try interval("2026-08-17T23:40:00Z", "2026-08-18T00:00:00Z", .asleepDeep),
                try interval("2026-08-18T00:00:00Z", "2026-08-18T03:10:00Z", .asleepCore),
                try interval("2026-08-18T03:10:00Z", "2026-08-18T04:00:00Z", .asleepREM),
                try interval("2026-08-18T04:00:00Z", "2026-08-18T04:15:00Z", .awake),
                try interval("2026-08-18T04:15:00Z", "2026-08-18T06:30:00Z", .asleepCore)
            ],
            healthTimezone: "UTC",
            queryStart: queryStart,
            rangeEnd: rangeEnd
        )

        XCTAssertEqual(days.count, 1)
        XCTAssertEqual(days[0].sleepDay, "2026-08-18")
        XCTAssertEqual(days[0].totalMinutes, 430)
        XCTAssertEqual(days[0].coreMinutes, 35 + 190 + 135)
        XCTAssertEqual(days[0].deepMinutes, 20)
        XCTAssertEqual(days[0].remMinutes, 50)
        XCTAssertEqual(days[0].awakeMinutes, 15)
    }

    func testSleepAggregationKeepsSubMinuteStagesInSessionTotal() throws {
        let iso = ISO8601DateFormatter()
        iso.formatOptions = [.withInternetDateTime]
        let queryStart = try XCTUnwrap(iso.date(from: "2026-08-17T07:00:00Z"))
        let rangeEnd = try XCTUnwrap(iso.date(from: "2026-08-18T14:00:00Z"))
        let start = try XCTUnwrap(iso.date(from: "2026-08-18T06:00:00Z"))

        // Nine 22s core fragments = 198s. Per-sample rounding used to drop each
        // (< 30s → 0m) and lose ~3 minutes Watch still shows.
        let intervals = (0..<9).map { i in
            let from = start.addingTimeInterval(TimeInterval(i * 22))
            return HealthKitSleepDaySync.SleepInterval(
                start: from,
                end: from.addingTimeInterval(22),
                value: HKCategoryValueSleepAnalysis.asleepCore.rawValue,
                sourceBundleId: "com.apple.health.watch",
                sourceName: "Apple Watch"
            )
        }

        let days = HealthKitSleepDaySync.aggregateSleepDays(
            intervals: intervals,
            healthTimezone: "UTC",
            queryStart: queryStart,
            rangeEnd: rangeEnd
        )

        XCTAssertEqual(days.count, 1)
        XCTAssertEqual(days[0].sleepDay, "2026-08-18")
        XCTAssertEqual(days[0].totalMinutes, 3)
        XCTAssertEqual(days[0].coreMinutes, 3)
    }


    func testSleepAggregationOmitsDayWhenQueryStartsAfterBedtime() throws {
        let iso = ISO8601DateFormatter()
        iso.formatOptions = [.withInternetDateTime]

        let napStart = try XCTUnwrap(iso.date(from: "2026-08-18T13:00:00Z"))
        let napEnd = try XCTUnwrap(iso.date(from: "2026-08-18T13:32:00Z"))
        // Query starts after the previous evening — not enough lead-in for a complete night.
        let queryStart = try XCTUnwrap(iso.date(from: "2026-08-18T07:00:00Z"))
        let rangeEnd = try XCTUnwrap(iso.date(from: "2026-08-18T14:00:00Z"))

        let days = HealthKitSleepDaySync.aggregateSleepDays(
            intervals: [
                .init(
                    start: napStart,
                    end: napEnd,
                    value: HKCategoryValueSleepAnalysis.asleepUnspecified.rawValue,
                    sourceBundleId: "com.apple.health.watch",
                    sourceName: "Apple Watch"
                )
            ],
            healthTimezone: "UTC",
            queryStart: queryStart,
            rangeEnd: rangeEnd
        )

        XCTAssertTrue(days.isEmpty)
    }

    func testStepsHourPayloadEnqueueAndEncode() throws {
        let path = FileManager.default.temporaryDirectory
            .appendingPathComponent("healthkit-steps-test-\(UUID().uuidString).sqlite")
            .path
        defer { try? FileManager.default.removeItem(atPath: path) }

        let store = try HealthKitSyncStore(path: path)
        let samples = [
            HealthKitStepsSync.StepHourSample(
                hourStartUtc: "2026-08-01T14:00:00.000Z",
                count: 1_234
            )
        ]

        try HealthKitStepsSync.enqueueSamples(samples, into: store)

        let batch = try store.claimBatch(limit: 10)
        XCTAssertEqual(batch.count, 1)
        XCTAssertEqual(batch[0].naturalKey, "steps_hour:2026-08-01T14:00:00.000Z")
        XCTAssertEqual(batch[0].groupKey, "activity")
        XCTAssertEqual(batch[0].scopeKey, "steps")

        let data = try XCTUnwrap(batch[0].payloadJSON?.data(using: .utf8))
        let payload = try JSONDecoder().decode(HealthKitOpPayloadWire.self, from: data)
        guard case let .stepsHour(hourStartUtc, count) = payload else {
            return XCTFail("Expected steps_hour payload")
        }
        XCTAssertEqual(hourStartUtc, "2026-08-01T14:00:00.000Z")
        XCTAssertEqual(count, 1_234)
    }

    func testStepsMapsUtcHoursAcrossMidnightAndSkipsZeroBuckets() throws {
        let firstHour = try XCTUnwrap(HealthKitRunEngine.parseISODate("2026-08-01T23:00:00.000Z"))
        let midnight = try XCTUnwrap(HealthKitRunEngine.parseISODate("2026-08-02T00:00:00.000Z"))
        let nextHour = try XCTUnwrap(HealthKitRunEngine.parseISODate("2026-08-02T01:00:00.000Z"))

        let samples = try HealthKitStepsSync.makeStepHourSamples(from: [
            .init(hourStart: firstHour, count: 120),
            .init(hourStart: midnight, count: 0),
            .init(hourStart: nextHour, count: 45)
        ])

        XCTAssertEqual(samples.map(HealthKitStepsSync.naturalKey(for:)), [
            "steps_hour:2026-08-01T23:00:00.000Z",
            "steps_hour:2026-08-02T01:00:00.000Z"
        ])
        XCTAssertEqual(samples.map(\.count), [120, 45])
    }

    func testStepsSkipsInvalidHourlyAggregateWithoutDiscardingOtherHours() throws {
        let firstHour = try XCTUnwrap(HealthKitRunEngine.parseISODate("2026-08-01T08:00:00.000Z"))
        let invalidHour = try XCTUnwrap(HealthKitRunEngine.parseISODate("2026-08-01T09:00:00.000Z"))
        let lastHour = try XCTUnwrap(HealthKitRunEngine.parseISODate("2026-08-01T10:00:00.000Z"))

        let samples = try HealthKitStepsSync.makeStepHourSamples(from: [
            .init(hourStart: firstHour, count: 30),
            .init(hourStart: invalidHour, count: .nan),
            .init(hourStart: lastHour, count: 60)
        ])

        XCTAssertEqual(samples.map(\.hourStartUtc), [
            "2026-08-01T08:00:00.000Z",
            "2026-08-01T10:00:00.000Z"
        ])
        XCTAssertEqual(samples.map(\.count), [30, 60])
    }

    func testStepsSplitsServerRangeIntoContiguousSevenDayWindows() throws {
        let start = try XCTUnwrap(HealthKitRunEngine.parseISODate("2026-05-01T00:00:00.000Z"))
        let end = try XCTUnwrap(HealthKitRunEngine.parseISODate("2026-05-16T00:00:00.000Z"))

        let windows = HealthKitStepsSync.queryWindows(from: start, through: end)

        XCTAssertEqual(windows.map { $0.start }, [
            try XCTUnwrap(HealthKitRunEngine.parseISODate("2026-05-01T00:00:00.000Z")),
            try XCTUnwrap(HealthKitRunEngine.parseISODate("2026-05-08T00:00:00.000Z")),
            try XCTUnwrap(HealthKitRunEngine.parseISODate("2026-05-15T00:00:00.000Z"))
        ])
        XCTAssertEqual(windows.map { $0.end }, [
            try XCTUnwrap(HealthKitRunEngine.parseISODate("2026-05-08T00:00:00.000Z")),
            try XCTUnwrap(HealthKitRunEngine.parseISODate("2026-05-15T00:00:00.000Z")),
            end
        ])
    }

    func testStepsCancellationDoesNotReturnPartialHourlyAggregates() async throws {
        let start = try XCTUnwrap(HealthKitRunEngine.parseISODate("2026-05-01T00:00:00.000Z"))
        let end = try XCTUnwrap(HealthKitRunEngine.parseISODate("2026-05-10T00:00:00.000Z"))

        do {
            _ = try await HealthKitStepsSync.fetchHourlyAggregates(from: start, through: end) { window in
                if window.start == start {
                    return [.init(hourStart: start, count: 12)]
                }
                throw CancellationError()
            }
            XCTFail("Expected cancellation to discard partial aggregate results")
        } catch is CancellationError {
            // Expected: callers can never enqueue partial results after a cancelled window.
        }
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

    func testHeartRateDayPayloadEnqueueAndEncode() throws {
        let path = FileManager.default.temporaryDirectory
            .appendingPathComponent("healthkit-hr-test-\(UUID().uuidString).sqlite")
            .path
        defer { try? FileManager.default.removeItem(atPath: path) }

        let store = try HealthKitSyncStore(path: path)
        let samples = [
            HealthKitHeartRateSync.HeartRateDaySample(
                localDay: "2026-08-19",
                averageValue: 72.4,
                minimumValue: 58,
                maximumValue: 110,
                latestValue: 80,
                sampleCount: 14
            )
        ]

        try HealthKitHeartRateSync.enqueueSamples(samples, into: store)

        let batch = try store.claimBatch(limit: 10)
        XCTAssertEqual(batch.count, 1)
        XCTAssertEqual(batch[0].naturalKey, "daily_metric:heart_rate:2026-08-19")
        XCTAssertEqual(batch[0].groupKey, "vitals")
        XCTAssertEqual(batch[0].scopeKey, "heart_rate")

        let data = try XCTUnwrap(batch[0].payloadJSON?.data(using: .utf8))
        let payload = try JSONDecoder().decode(HealthKitOpPayloadWire.self, from: data)
        guard case let .dailyMetric(healthMetric, localDay, _, average, minimum, maximum, latest, sampleCount) = payload else {
            return XCTFail("Expected daily_metric payload")
        }
        XCTAssertEqual(healthMetric, "heart_rate")
        XCTAssertEqual(localDay, "2026-08-19")
        XCTAssertEqual(average, 72.4)
        XCTAssertEqual(minimum, 58)
        XCTAssertEqual(maximum, 110)
        XCTAssertEqual(latest, 80)
        XCTAssertEqual(sampleCount, 14)
    }

    func testHeartRateAggregatesLocalDaysAndSkipsInvalidSamples() throws {
        let first = try XCTUnwrap(HealthKitRunEngine.parseISODate("2026-08-19T10:00:00.000Z"))
        let second = try XCTUnwrap(HealthKitRunEngine.parseISODate("2026-08-19T18:00:00.000Z"))
        let nextDay = try XCTUnwrap(HealthKitRunEngine.parseISODate("2026-08-20T01:00:00.000Z"))

        let days = HealthKitHeartRateSync.makeHeartRateDays(
            from: [
                .init(date: first, bpm: 60),
                .init(date: second, bpm: 80),
                .init(date: first, bpm: .nan),
                .init(date: nextDay, bpm: 90)
            ],
            healthTimezone: "UTC"
        )

        XCTAssertEqual(days.map(\.localDay), ["2026-08-19", "2026-08-20"])
        XCTAssertEqual(days[0].sampleCount, 2)
        XCTAssertEqual(days[0].minimumValue, 60)
        XCTAssertEqual(days[0].maximumValue, 80)
        XCTAssertEqual(days[0].averageValue, 70)
        XCTAssertEqual(days[0].latestValue, 80)
        XCTAssertEqual(days[1].sampleCount, 1)
        XCTAssertEqual(days[1].latestValue, 90)
    }

    func testSwimmingWorkoutFilterMatchesSwimTypes() {
        XCTAssertTrue(
            WorkoutReading(
                id: "s1",
                workoutType: "swimming",
                startedAtUtc: "2026-08-19T01:00:00.000Z",
                endedAtUtc: "2026-08-19T01:30:00.000Z",
                durationSeconds: 1800,
                activeEnergyKcal: 220,
                distanceMeters: 1500,
                averageHeartRateBpm: 140,
                maximumHeartRateBpm: nil,
                minimumHeartRateBpm: nil,
                sourceName: nil,
                deviceName: nil,
                isIndoor: nil,
                elevationAscendedMeters: nil,
                averageMETs: nil,
                swimmingStrokeCount: 620,
                totalFlightsClimbed: nil,
                events: nil,
                activities: nil,
                exercises: nil
            ).isSwimmingWorkout
        )
        XCTAssertFalse(
            WorkoutReading(
                id: "r1",
                workoutType: "running",
                startedAtUtc: "2026-08-19T01:00:00.000Z",
                endedAtUtc: "2026-08-19T01:30:00.000Z",
                durationSeconds: 1800,
                activeEnergyKcal: 220,
                distanceMeters: 5000,
                averageHeartRateBpm: nil,
                maximumHeartRateBpm: nil,
                minimumHeartRateBpm: nil,
                sourceName: nil,
                deviceName: nil,
                isIndoor: nil,
                elevationAscendedMeters: nil,
                averageMETs: nil,
                swimmingStrokeCount: nil,
                totalFlightsClimbed: nil,
                events: nil,
                activities: nil,
                exercises: nil
            ).isSwimmingWorkout
        )
    }
}
