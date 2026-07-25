import Foundation
import HealthKit

enum HealthKitSyncEngineError: LocalizedError {
    case missingSession
    case missingConfiguration
    case repairNeeded(String)

    var errorDescription: String? {
        switch self {
        case .missingSession:
            return "Sign in required for HealthKit sync."
        case .missingConfiguration:
            return "HealthKit sync is not configured."
        case .repairNeeded:
            return "A foreground HealthKit repair is required."
        }
    }
}

/// Testable non-UI engine: queries HealthKit, updates local ledger, uploads, advances anchors after ack.
actor HealthKitSyncEngine {
    private let healthKit: HealthKitClient
    private let api: HealthAPIClient
    private let stateStore: HealthKitSyncStateStore
    private let maxOperations = 500
    private let anchoredPageLimit = 1_000

    init(
        healthKit: HealthKitClient = HealthKitClient(),
        api: HealthAPIClient = HealthAPIClient(),
        stateStore: HealthKitSyncStateStore = HealthKitSyncStateStore()
    ) {
        self.healthKit = healthKit
        self.api = api
        self.stateStore = stateStore
    }

    struct SessionContext {
        var baseURL: String
        var accessToken: String
        var userId: String
        var personId: String
        var timezone: String
        var timezoneVersion: Int
        var installationId: String
        var enabledGroups: [HealthKitSyncMetric]
    }

    func enableAndRepair(context: SessionContext) async throws {
        let metricSummary = context.enabledGroups.map(\.rawValue).sorted().joined(separator: ",")
        CrashReporting.setCustomValues([
            "healthkit_stage": "sync_started",
            "healthkit_metrics": metricSummary
        ])
        CrashReporting.log("healthkit.sync_started metrics=\(metricSummary)")
        try await healthKit.requestAuthorization(for: Set(context.enabledGroups))
        try await healthKit.enableBackgroundDelivery(for: Set(context.enabledGroups))
        for metric in context.enabledGroups {
            try await processMetric(metric, context: context)
        }
        CrashReporting.setCustomValues(["healthkit_stage": "sync_completed"])
        CrashReporting.log("healthkit.sync_completed")
    }

    func processPendingWork(context: SessionContext) async throws {
        for metric in context.enabledGroups {
            try await processMetric(metric, context: context)
        }
    }

    func processMetric(_ metric: HealthKitSyncMetric, context: SessionContext) async throws {
        guard context.enabledGroups.contains(metric) else { return }
        let local = await stateStore.loadMetricState(
            userId: context.userId,
            personId: context.personId,
            metric: metric
        )
        var pending = local
        pending.pendingSync = true
        pending.redactedStatus = "pending"
        await stateStore.saveMetricState(userId: context.userId, personId: context.personId, metric: metric, state: pending)
        if local.repairId != nil {
            try await resumeRepair(metric: metric, context: context)
        } else if local.anchorData == nil {
            try await runRepair(metric: metric, context: context)
        } else {
            try await processAnchoredChanges(metric: metric, context: context)
        }
    }

    /// Incremental path for each aggregate-backed HealthKit type. Group repair
    /// establishes these anchors; an unknown deletion deliberately forces a
    /// repair instead of silently retaining stale daily data.
    func processDataMetric(_ dataMetric: HealthKitDataMetric, context: SessionContext) async throws {
        guard context.enabledGroups.contains(dataMetric.group), isIncrementalDataMetric(dataMetric) else { return }
        guard let type = dataMetric.sampleType else { return }
        guard let anchor = await stateStore.loadDataMetricAnchor(userId: context.userId, personId: context.personId, metric: dataMetric) else {
            try await runRepair(metric: dataMetric.group, context: context)
            return
        }

        var currentAnchor: HKQueryAnchor? = anchor
        var guardCount = 0
        while guardCount < 10_000 {
            guardCount += 1
            let page = try await healthKit.anchoredQuery(type: type, anchor: currentAnchor, limit: anchoredPageLimit)
            let empty = page.added.isEmpty && page.deletedObjectUUIDs.isEmpty
            if !empty {
                try await applyDataMetricPage(dataMetric, context: context, page: page)
            }
            await stateStore.saveDataMetricAnchor(page.newAnchor, userId: context.userId, personId: context.personId, metric: dataMetric)
            currentAnchor = page.newAnchor
            if empty || page.added.count + page.deletedObjectUUIDs.count < anchoredPageLimit { break }
        }
    }

    func runRepair(metric: HealthKitSyncMetric, context: SessionContext) async throws {
        let repair = try await api.createHealthKitRepair(
            baseURL: context.baseURL,
            accessToken: context.accessToken,
            installationId: context.installationId,
            personId: context.personId,
            metric: metric,
            timezoneVersion: context.timezoneVersion
        )

        let rangeStart = parseInstant(repair.rangeStart) ?? Date().addingTimeInterval(-90 * 24 * 3600)
        let rangeEnd = parseInstant(repair.rangeEnd) ?? Date()
        let operations = try await buildRepairOperations(
            metric: metric,
            rangeStart: rangeStart,
            rangeEnd: rangeEnd,
            rangeStartDay: repair.rangeStartDay,
            rangeEndDay: repair.rangeEndDay,
            context: context
        )
        let sorted = operations.sorted { $0.stableKey < $1.stableKey }
        let chunks = chunkOperations(sorted)
        let expectedChunks = chunks.count

        var syncIds: [String: String] = [:]
        for index in 0..<expectedChunks {
            syncIds[String(index)] = UUID().uuidString.lowercased()
        }

        var local = await stateStore.loadMetricState(userId: context.userId, personId: context.personId, metric: metric)
        local.repairId = repair.repairId
        local.repairChunkIndex = 0
        local.repairExpectedChunks = expectedChunks
        local.repairRangeStart = repair.rangeStart
        local.repairRangeEnd = repair.rangeEnd
        local.repairRangeStartDay = repair.rangeStartDay
        local.repairRangeEndDay = repair.rangeEndDay
        local.repairChunkSyncIds = syncIds
        local.pendingSync = true
        local.redactedStatus = "repairing"
        await stateStore.saveMetricState(userId: context.userId, personId: context.personId, metric: metric, state: local)

        try await uploadRepairChunks(
            metric: metric,
            context: context,
            repairId: repair.repairId,
            chunks: chunks,
            startIndex: 0,
            syncIds: syncIds,
            expectedChunks: expectedChunks
        )

        try await seedLedgerAfterRepair(
            metric: metric,
            rangeStart: rangeStart,
            rangeEnd: rangeEnd,
            rangeStartDay: repair.rangeStartDay,
            rangeEndDay: repair.rangeEndDay,
            context: context
        )
        // History already uploaded via repair; advance anchor through the change feed without re-uploading.
        try await establishBaselineAnchor(metric: metric, context: context)
        try await establishAdditionalBaselines(group: metric, rangeStart: rangeStart, rangeEnd: rangeEnd, context: context)

        local = await stateStore.loadMetricState(userId: context.userId, personId: context.personId, metric: metric)
        local.repairId = nil
        local.repairChunkIndex = nil
        local.repairExpectedChunks = nil
        local.repairRangeStart = nil
        local.repairRangeEnd = nil
        local.repairRangeStartDay = nil
        local.repairRangeEndDay = nil
        local.repairChunkSyncIds = nil
        local.pendingSync = false
        local.lastSuccessfulAt = Date()
        local.lastErrorCode = nil
        local.redactedStatus = "ready"
        await stateStore.saveMetricState(userId: context.userId, personId: context.personId, metric: metric, state: local)
    }

    private func resumeRepair(metric: HealthKitSyncMetric, context: SessionContext) async throws {
        var local = await stateStore.loadMetricState(userId: context.userId, personId: context.personId, metric: metric)
        guard let repairId = local.repairId,
              let expectedChunks = local.repairExpectedChunks,
              let rangeStartRaw = local.repairRangeStart,
              let rangeEndRaw = local.repairRangeEnd,
              let rangeStartDay = local.repairRangeStartDay,
              let rangeEndDay = local.repairRangeEndDay,
              let rangeStart = parseInstant(rangeStartRaw),
              let rangeEnd = parseInstant(rangeEndRaw)
        else {
            // Incomplete local progress — start a clean repair.
            try await runRepair(metric: metric, context: context)
            return
        }

        let nextIndex = local.repairChunkIndex ?? 0
        let operations = try await buildRepairOperations(
            metric: metric,
            rangeStart: rangeStart,
            rangeEnd: rangeEnd,
            rangeStartDay: rangeStartDay,
            rangeEndDay: rangeEndDay,
            context: context
        )
        let sorted = operations.sorted { $0.stableKey < $1.stableKey }
        let chunks = chunkOperations(sorted)
        // Rebuild must match expected chunk count; if HealthKit data changed mid-repair, restart.
        let rebuiltExpected = max(chunks.count, 1)
        if rebuiltExpected != expectedChunks {
            try await runRepair(metric: metric, context: context)
            return
        }

        var syncIds = local.repairChunkSyncIds ?? [:]
        for index in 0..<expectedChunks where syncIds[String(index)] == nil {
            syncIds[String(index)] = UUID().uuidString.lowercased()
        }
        local.repairChunkSyncIds = syncIds
        await stateStore.saveMetricState(userId: context.userId, personId: context.personId, metric: metric, state: local)

        try await uploadRepairChunks(
            metric: metric,
            context: context,
            repairId: repairId,
            chunks: chunks,
            startIndex: nextIndex,
            syncIds: syncIds,
            expectedChunks: expectedChunks
        )

        try await seedLedgerAfterRepair(
            metric: metric,
            rangeStart: rangeStart,
            rangeEnd: rangeEnd,
            rangeStartDay: rangeStartDay,
            rangeEndDay: rangeEndDay,
            context: context
        )
        try await establishBaselineAnchor(metric: metric, context: context)
        try await establishAdditionalBaselines(group: metric, rangeStart: rangeStart, rangeEnd: rangeEnd, context: context)

        local = await stateStore.loadMetricState(userId: context.userId, personId: context.personId, metric: metric)
        local.repairId = nil
        local.repairChunkIndex = nil
        local.repairExpectedChunks = nil
        local.repairRangeStart = nil
        local.repairRangeEnd = nil
        local.repairRangeStartDay = nil
        local.repairRangeEndDay = nil
        local.repairChunkSyncIds = nil
        local.pendingSync = false
        local.lastSuccessfulAt = Date()
        local.lastErrorCode = nil
        local.redactedStatus = "ready"
        await stateStore.saveMetricState(userId: context.userId, personId: context.personId, metric: metric, state: local)
    }

    private func uploadRepairChunks(
        metric: HealthKitSyncMetric,
        context: SessionContext,
        repairId: String,
        chunks: [[HealthKitSyncOperation]],
        startIndex: Int,
        syncIds: [String: String],
        expectedChunks: Int
    ) async throws {
        for index in startIndex..<chunks.count {
            let syncId = syncIds[String(index)] ?? UUID().uuidString.lowercased()
            _ = try await api.syncHealthKit(
                baseURL: context.baseURL,
                accessToken: context.accessToken,
                syncId: syncId,
                installationId: context.installationId,
                personId: context.personId,
                timezoneVersion: context.timezoneVersion,
                operations: chunks[index],
                repairId: repairId,
                chunkIndex: index
            )
            var local = await stateStore.loadMetricState(userId: context.userId, personId: context.personId, metric: metric)
            local.repairChunkIndex = index + 1
            await stateStore.saveMetricState(userId: context.userId, personId: context.personId, metric: metric, state: local)
        }

        _ = try await api.completeHealthKitRepair(
            baseURL: context.baseURL,
            accessToken: context.accessToken,
            repairId: repairId,
            expectedChunkCount: expectedChunks
        )
    }

    private func processAnchoredChanges(metric: HealthKitSyncMetric, context: SessionContext) async throws {
        let starting = await stateStore.loadAnchor(userId: context.userId, personId: context.personId, metric: metric)
        try await drainAnchoredFeed(metric: metric, context: context, startingAnchor: starting)
        // The primary type (steps, sleep, BP, or the first available type) is
        // anchored above. Other group members are daily aggregates, so refresh
        // their recent calendar window whenever that group receives a change.
        let rollingStart = Date().addingTimeInterval(-2 * 24 * 3600)
        let now = Date()
        let additional: [HealthKitSyncOperation]
        if metric == .sleep {
            additional = try await buildRepairOperations(
                metric: metric,
                rangeStart: rollingStart,
                rangeEnd: now,
                rangeStartDay: localDay(for: rollingStart, timeZone: context.timezone),
                rangeEndDay: localDay(for: now, timeZone: context.timezone),
                context: context
            )
        } else {
            additional = try await additionalRepairOperations(
                group: metric,
                rangeStart: rollingStart,
                rangeEnd: now,
                timeZone: context.timezone
            )
        }
        if !additional.isEmpty {
            for chunk in chunkOperations(additional.sorted { $0.stableKey < $1.stableKey }) {
                _ = try await api.syncHealthKit(
                    baseURL: context.baseURL,
                    accessToken: context.accessToken,
                    syncId: UUID().uuidString.lowercased(),
                    installationId: context.installationId,
                    personId: context.personId,
                    timezoneVersion: context.timezoneVersion,
                    operations: chunk,
                    repairId: nil,
                    chunkIndex: nil
                )
            }
        }
        var local = await stateStore.loadMetricState(userId: context.userId, personId: context.personId, metric: metric)
        local.pendingSync = false
        local.lastSuccessfulAt = Date()
        local.lastErrorCode = nil
        local.redactedStatus = "ready"
        await stateStore.saveMetricState(userId: context.userId, personId: context.personId, metric: metric, state: local)
    }

    /// Drain all anchored pages, uploading after each page, advancing the anchor only after ack.
    private func drainAnchoredFeed(
        metric: HealthKitSyncMetric,
        context: SessionContext,
        startingAnchor: HKQueryAnchor?
    ) async throws {
        let type = try healthKit.sampleType(for: metric)
        var anchor = startingAnchor
        var guardCount = 0
        while guardCount < 10_000 {
            guardCount += 1
            let page = try await healthKit.anchoredQuery(type: type, anchor: anchor, limit: anchoredPageLimit)
            let empty = page.added.isEmpty && page.deletedObjectUUIDs.isEmpty
            if !empty {
                try await applyAnchoredPage(metric: metric, context: context, page: page)
            }
            // Advance anchor only after successful upload (or empty page).
            await stateStore.saveAnchor(page.newAnchor, userId: context.userId, personId: context.personId, metric: metric)
            anchor = page.newAnchor
            if empty || (page.added.count + page.deletedObjectUUIDs.count) < anchoredPageLimit {
                break
            }
        }
    }

    /// After a completed repair, page the full change feed only to reach the terminal anchor (no re-upload).
    private func establishBaselineAnchor(metric: HealthKitSyncMetric, context: SessionContext) async throws {
        let type = try healthKit.sampleType(for: metric)
        var anchor: HKQueryAnchor?
        var guardCount = 0
        while guardCount < 10_000 {
            guardCount += 1
            let page = try await healthKit.anchoredQuery(type: type, anchor: anchor, limit: anchoredPageLimit)
            await stateStore.saveAnchor(page.newAnchor, userId: context.userId, personId: context.personId, metric: metric)
            anchor = page.newAnchor
            let pageSize = page.added.count + page.deletedObjectUUIDs.count
            if pageSize == 0 || pageSize < anchoredPageLimit {
                break
            }
        }
    }

    private func establishAdditionalBaselines(
        group: HealthKitSyncMetric,
        rangeStart: Date,
        rangeEnd: Date,
        context: SessionContext
    ) async throws {
        let expiry = Date().addingTimeInterval(90 * 24 * 3600)
        for dataMetric in HealthKitDataMetric.metrics(for: group) where isIncrementalDataMetric(dataMetric) {
            guard let type = dataMetric.sampleType else { continue }
            let samples = try await healthKit.samples(for: dataMetric, from: rangeStart, to: rangeEnd)
            var ledger: [String: HealthKitLedgerEntry] = [:]
            for sample in samples {
                let key = sample.uuid.uuidString.lowercased()
                ledger[key] = HealthKitLedgerEntry(
                    sourceUUID: key,
                    metric: dataMetric.rawValue,
                    bucketKeys: dataMetric.storage == .dailyNumeric ? [localDay(for: sample.endDate, timeZone: context.timezone)] : [key],
                    measuredAt: sample.endDate,
                    expiresAt: expiry
                )
            }
            await stateStore.saveDataMetricLedger(ledger, userId: context.userId, personId: context.personId, metric: dataMetric)

            var anchor: HKQueryAnchor?
            var guardCount = 0
            while guardCount < 10_000 {
                guardCount += 1
                let page = try await healthKit.anchoredQuery(type: type, anchor: anchor, limit: anchoredPageLimit)
                anchor = page.newAnchor
                if page.added.count + page.deletedObjectUUIDs.count < anchoredPageLimit { break }
            }
            await stateStore.saveDataMetricAnchor(anchor, userId: context.userId, personId: context.personId, metric: dataMetric)
        }
    }

    private func applyDataMetricPage(
        _ dataMetric: HealthKitDataMetric,
        context: SessionContext,
        page: HealthKitAnchoredChangePage
    ) async throws {
        var ledger = await stateStore.loadDataMetricLedger(userId: context.userId, personId: context.personId, metric: dataMetric)
        let expiry = Date().addingTimeInterval(90 * 24 * 3600)
        var operations: [HealthKitSyncOperation] = []

        switch dataMetric.storage {
        case .dailyNumeric:
            var affectedDays = Set<String>()
            for sample in page.added {
                let key = sample.uuid.uuidString.lowercased()
                let day = localDay(for: sample.endDate, timeZone: context.timezone)
                affectedDays.insert(day)
                ledger[key] = HealthKitLedgerEntry(sourceUUID: key, metric: dataMetric.rawValue, bucketKeys: [day], measuredAt: sample.endDate, expiresAt: expiry)
            }
            for deleted in page.deletedObjectUUIDs {
                let key = deleted.uuidString.lowercased()
                guard let entry = ledger.removeValue(forKey: key) else {
                    throw HealthKitSyncEngineError.repairNeeded(dataMetric.group.rawValue)
                }
                affectedDays.formUnion(entry.bucketKeys)
            }
            for day in affectedDays {
                guard let start = parseDayStart(day, timeZone: context.timezone) else { continue }
                var calendar = Calendar(identifier: .gregorian)
                calendar.timeZone = TimeZone(identifier: context.timezone) ?? TimeZone(secondsFromGMT: 0)!
                guard let end = calendar.date(byAdding: .day, value: 1, to: start) else { continue }
                let replacements = try await dailyMetricOperations(metric: dataMetric, from: start, to: end, timeZone: context.timezone)
                if replacements.isEmpty {
                    operations.append(.dailyMetricDelete(healthMetric: dataMetric, localDay: day))
                } else {
                    operations += replacements.filter { $0.stableKey.hasSuffix(":" + day) }
                }
            }
        case .bloodGlucose:
            guard let unit = dataMetric.unit else { return }
            for sample in page.added.compactMap({ $0 as? HKQuantitySample }) {
                let key = sample.uuid.uuidString.lowercased()
                ledger[key] = HealthKitLedgerEntry(sourceUUID: key, metric: dataMetric.rawValue, bucketKeys: [key], measuredAt: sample.startDate, expiresAt: expiry)
                operations.append(.bloodGlucoseUpsert(sourceSampleKey: key, measuredAtUtc: isoInstant(sample.startDate), valueMgDl: sample.quantity.doubleValue(for: unit)))
            }
            for deleted in page.deletedObjectUUIDs {
                let key = deleted.uuidString.lowercased()
                guard ledger.removeValue(forKey: key) != nil else { throw HealthKitSyncEngineError.repairNeeded(dataMetric.group.rawValue) }
                operations.append(.bloodGlucoseDelete(sourceSampleKey: key))
            }
        case .workout:
            for workout in page.added.compactMap({ $0 as? HKWorkout }) {
                let key = workout.uuid.uuidString.lowercased()
                ledger[key] = HealthKitLedgerEntry(sourceUUID: key, metric: dataMetric.rawValue, bucketKeys: [key], measuredAt: workout.startDate, expiresAt: expiry)
                operations.append(workoutUpsert(workout))
            }
            for deleted in page.deletedObjectUUIDs {
                let key = deleted.uuidString.lowercased()
                guard ledger.removeValue(forKey: key) != nil else { throw HealthKitSyncEngineError.repairNeeded(dataMetric.group.rawValue) }
                operations.append(.workoutDelete(sourceSampleKey: key))
            }
        case .hourly, .sleepDay, .bloodPressure:
            return
        }

        for chunk in chunkOperations(operations.sorted { $0.stableKey < $1.stableKey }) {
            _ = try await api.syncHealthKit(
                baseURL: context.baseURL,
                accessToken: context.accessToken,
                syncId: UUID().uuidString.lowercased(),
                installationId: context.installationId,
                personId: context.personId,
                timezoneVersion: context.timezoneVersion,
                operations: chunk,
                repairId: nil,
                chunkIndex: nil
            )
        }
        await stateStore.saveDataMetricLedger(ledger, userId: context.userId, personId: context.personId, metric: dataMetric)
    }

    private func isIncrementalDataMetric(_ dataMetric: HealthKitDataMetric) -> Bool {
        switch dataMetric.storage {
        case .dailyNumeric, .bloodGlucose, .workout:
            return true
        case .hourly, .sleepDay, .bloodPressure:
            return false
        }
    }

    private func applyAnchoredPage(
        metric: HealthKitSyncMetric,
        context: SessionContext,
        page: HealthKitAnchoredChangePage
    ) async throws {
        var ledger = await stateStore.loadLedger(userId: context.userId, personId: context.personId, metric: metric)
        var operations: [HealthKitSyncOperation] = []
        var affectedBuckets = Set<String>()
        let expiry = Date().addingTimeInterval(90 * 24 * 3600)

        switch metric {
        case .activity:
            for sample in page.added {
                guard let quantity = sample as? HKQuantitySample else { continue }
                let hours = try await healthKit.hourlyStepCounts(from: quantity.startDate, to: quantity.endDate)
                var bucketKeys: [String] = []
                for hour in hours {
                    let key = isoHour(hour.hourStartUtc)
                    bucketKeys.append(key)
                    affectedBuckets.insert(key)
                }
                if bucketKeys.isEmpty {
                    // Instantaneous sample: still map to containing UTC hour.
                    let key = isoHour(quantity.startDate)
                    bucketKeys = [key]
                    affectedBuckets.insert(key)
                }
                ledger[quantity.uuid.uuidString] = HealthKitLedgerEntry(
                    sourceUUID: quantity.uuid.uuidString,
                    metric: metric.rawValue,
                    bucketKeys: Array(Set(bucketKeys)).sorted(),
                    measuredAt: quantity.startDate,
                    expiresAt: expiry
                )
            }
            for deleted in page.deletedObjectUUIDs {
                guard let entry = ledger[deleted.uuidString] else {
                    throw HealthKitSyncEngineError.repairNeeded(metric.rawValue)
                }
                affectedBuckets.formUnion(entry.bucketKeys)
                ledger.removeValue(forKey: deleted.uuidString)
            }
            for bucket in affectedBuckets {
                guard let hourDate = parseHour(bucket) else { continue }
                let hours = try await healthKit.hourlyStepCounts(
                    from: hourDate,
                    to: hourDate.addingTimeInterval(3600)
                )
                let count = hours.first?.count ?? 0
                operations.append(.stepsHourUpsert(hourStartUtc: bucket, count: count))
            }

        case .sleep:
            for sample in page.added {
                guard let category = sample as? HKCategorySample else { continue }
                let days = healthKit.sleepDayTotals(samples: [category], timeZoneIdentifier: context.timezone)
                let bucketKeys = Array(days.keys).sorted()
                affectedBuckets.formUnion(bucketKeys)
                ledger[category.uuid.uuidString] = HealthKitLedgerEntry(
                    sourceUUID: category.uuid.uuidString,
                    metric: metric.rawValue,
                    bucketKeys: bucketKeys,
                    measuredAt: category.endDate,
                    expiresAt: expiry
                )
            }
            for deleted in page.deletedObjectUUIDs {
                guard let entry = ledger[deleted.uuidString] else {
                    throw HealthKitSyncEngineError.repairNeeded(metric.rawValue)
                }
                affectedBuckets.formUnion(entry.bucketKeys)
                ledger.removeValue(forKey: deleted.uuidString)
            }
            for day in affectedBuckets {
                let dayStart = parseDayStart(day, timeZone: context.timezone) ?? Date()
                let dayEnd = dayStart.addingTimeInterval(24 * 3600)
                let samples = try await healthKit.sleepSamples(
                    from: dayStart.addingTimeInterval(-12 * 3600),
                    to: dayEnd.addingTimeInterval(12 * 3600)
                )
                let totals = healthKit.sleepDayTotals(samples: samples, timeZoneIdentifier: context.timezone)
                operations.append(sleepUpsert(sleepDay: day, totals: totals[day] ?? HealthKitSleepDayTotals()))
            }

        case .vitals:
            for sample in page.added {
                guard let correlation = sample as? HKCorrelation,
                      let parsed = healthKit.parseBloodPressure(correlation)
                else { continue }
                let key = correlation.uuid.uuidString.lowercased()
                ledger[key] = HealthKitLedgerEntry(
                    sourceUUID: key,
                    metric: metric.rawValue,
                    bucketKeys: [key],
                    measuredAt: parsed.measuredAt,
                    expiresAt: expiry
                )
                operations.append(
                    .bloodPressureUpsert(
                        sourceSampleKey: key,
                        measuredAtUtc: isoInstant(parsed.measuredAt),
                        systolic: parsed.systolic,
                        diastolic: parsed.diastolic,
                        pulse: parsed.pulse
                    )
                )
            }
            for deleted in page.deletedObjectUUIDs {
                let key = deleted.uuidString.lowercased()
                guard ledger[key] != nil else {
                    throw HealthKitSyncEngineError.repairNeeded(metric.rawValue)
                }
                ledger.removeValue(forKey: key)
                operations.append(.bloodPressureDelete(sourceSampleKey: key))
            }
        case .body, .mobility, .workouts, .mindfulnessEnvironment, .nutrition:
            break
        }

        if !operations.isEmpty {
            let sorted = operations.sorted { $0.stableKey < $1.stableKey }
            for chunk in chunkOperations(sorted) {
                _ = try await api.syncHealthKit(
                    baseURL: context.baseURL,
                    accessToken: context.accessToken,
                    syncId: UUID().uuidString.lowercased(),
                    installationId: context.installationId,
                    personId: context.personId,
                    timezoneVersion: context.timezoneVersion,
                    operations: chunk,
                    repairId: nil,
                    chunkIndex: nil
                )
            }
        }

        await stateStore.saveLedger(ledger, userId: context.userId, personId: context.personId, metric: metric)
    }

    private func chunkOperations(_ operations: [HealthKitSyncOperation]) -> [[HealthKitSyncOperation]] {
        guard !operations.isEmpty else { return [] }
        return stride(from: 0, to: operations.count, by: maxOperations).map { start in
            let end = min(start + maxOperations, operations.count)
            return Array(operations[start..<end])
        }
    }

    private func buildRepairOperations(
        metric: HealthKitSyncMetric,
        rangeStart: Date,
        rangeEnd: Date,
        rangeStartDay: String,
        rangeEndDay: String,
        context: SessionContext
    ) async throws -> [HealthKitSyncOperation] {
        let primaryOperations: [HealthKitSyncOperation]
        switch metric {
        case .activity:
            let firstHour = firstStepHourInsideRepairRange(rangeStart)
            if firstHour > rangeEnd {
                primaryOperations = []
            } else {
                let hours = try await healthKit.hourlyStepCounts(from: firstHour, to: rangeEnd)
                primaryOperations = hours
                    .filter { $0.hourStartUtc >= firstHour && $0.hourStartUtc <= rangeEnd }
                    .map { .stepsHourUpsert(hourStartUtc: isoHour($0.hourStartUtc), count: $0.count) }
            }
        case .sleep:
            let samples = try await sleepSamplesForRepair(
                rangeStartDay: rangeStartDay,
                rangeEndDay: rangeEndDay,
                timeZone: context.timezone
            )
            var days = healthKit.sleepDayTotals(samples: samples, timeZoneIdentifier: context.timezone)
            for dataMetric in [HealthKitDataMetric.sleepingWristTemperature, .sleepBreathingDisturbanceEvents] {
                guard let unit = dataMetric.unit else { continue }
                let values = try await healthKit.quantitySamples(for: dataMetric, from: rangeStart, to: rangeEnd)
                for sample in values {
                    let day = localDay(for: sample.endDate, timeZone: context.timezone)
                    var totals = days[day, default: HealthKitSleepDayTotals()]
                    if dataMetric == .sleepingWristTemperature {
                        totals.wristTemperatureCelsius = sample.quantity.doubleValue(for: unit)
                    } else {
                        totals.breathingDisturbanceCount = (totals.breathingDisturbanceCount ?? 0) + Int(sample.quantity.doubleValue(for: unit).rounded())
                    }
                    days[day] = totals
                }
            }
            primaryOperations = days
                .filter { $0.key >= rangeStartDay && $0.key <= rangeEndDay }
                .map { sleepUpsert(sleepDay: $0.key, totals: $0.value) }
        case .vitals:
            let correlations = try await healthKit.bloodPressureCorrelations(from: rangeStart, to: rangeEnd)
            primaryOperations = correlations.compactMap { correlation in
                guard let parsed = healthKit.parseBloodPressure(correlation) else { return nil }
                return .bloodPressureUpsert(
                    sourceSampleKey: correlation.uuid.uuidString.lowercased(),
                    measuredAtUtc: isoInstant(parsed.measuredAt),
                    systolic: parsed.systolic,
                    diastolic: parsed.diastolic,
                    pulse: parsed.pulse
                )
            }
        case .body, .mobility, .workouts, .mindfulnessEnvironment, .nutrition:
            primaryOperations = []
        }
        return primaryOperations + (try await additionalRepairOperations(
            group: metric,
            rangeStart: rangeStart,
            rangeEnd: rangeEnd,
            timeZone: context.timezone
        ))
    }

    private func seedLedgerAfterRepair(
        metric: HealthKitSyncMetric,
        rangeStart: Date,
        rangeEnd: Date,
        rangeStartDay: String,
        rangeEndDay: String,
        context: SessionContext
    ) async throws {
        var ledger: [String: HealthKitLedgerEntry] = [:]
        let expiry = Date().addingTimeInterval(90 * 24 * 3600)
        switch metric {
        case .activity:
            let firstHour = firstStepHourInsideRepairRange(rangeStart)
            guard firstHour <= rangeEnd else { break }
            let samples = try await healthKit.stepQuantitySamples(from: firstHour, to: rangeEnd)
            for sample in samples {
                let hours = try await healthKit.hourlyStepCounts(from: sample.startDate, to: sample.endDate)
                let bucketKeys = hours
                    .filter { $0.hourStartUtc >= firstHour && $0.hourStartUtc <= rangeEnd }
                    .map { isoHour($0.hourStartUtc) }
                guard !bucketKeys.isEmpty else { continue }
                ledger[sample.uuid.uuidString] = HealthKitLedgerEntry(
                    sourceUUID: sample.uuid.uuidString,
                    metric: metric.rawValue,
                    bucketKeys: Array(Set(bucketKeys)).sorted(),
                    measuredAt: sample.startDate,
                    expiresAt: expiry
                )
            }
        case .sleep:
            let samples = try await sleepSamplesForRepair(
                rangeStartDay: rangeStartDay,
                rangeEndDay: rangeEndDay,
                timeZone: context.timezone
            )
            for sample in samples {
                let days = healthKit.sleepDayTotals(samples: [sample], timeZoneIdentifier: context.timezone)
                let keys = days.keys.filter { $0 >= rangeStartDay && $0 <= rangeEndDay }.sorted()
                guard !keys.isEmpty else { continue }
                ledger[sample.uuid.uuidString] = HealthKitLedgerEntry(
                    sourceUUID: sample.uuid.uuidString,
                    metric: metric.rawValue,
                    bucketKeys: keys,
                    measuredAt: sample.endDate,
                    expiresAt: expiry
                )
            }
        case .vitals:
            let correlations = try await healthKit.bloodPressureCorrelations(from: rangeStart, to: rangeEnd)
            for correlation in correlations {
                let key = correlation.uuid.uuidString.lowercased()
                ledger[key] = HealthKitLedgerEntry(
                    sourceUUID: key,
                    metric: metric.rawValue,
                    bucketKeys: [key],
                    measuredAt: correlation.startDate,
                    expiresAt: expiry
                )
            }
        case .body, .mobility, .workouts, .mindfulnessEnvironment, .nutrition:
            break
        }
        await stateStore.saveLedger(ledger, userId: context.userId, personId: context.personId, metric: metric)
    }

    private func firstStepHourInsideRepairRange(_ rangeStart: Date) -> Date {
        var calendar = Calendar(identifier: .gregorian)
        calendar.timeZone = TimeZone(secondsFromGMT: 0)!
        let hour = calendar.dateComponents([.year, .month, .day, .hour], from: rangeStart)
        guard let roundedDown = calendar.date(from: hour) else { return rangeStart }
        return roundedDown < rangeStart ? roundedDown.addingTimeInterval(3600) : roundedDown
    }

    private func sleepSamplesForRepair(
        rangeStartDay: String,
        rangeEndDay: String,
        timeZone: String
    ) async throws -> [HKCategorySample] {
        guard let start = parseDayStart(rangeStartDay, timeZone: timeZone),
              let endDayStart = parseDayStart(rangeEndDay, timeZone: timeZone),
              let zone = TimeZone(identifier: timeZone)
        else {
            throw HealthKitSyncEngineError.repairNeeded(HealthKitSyncMetric.sleep.rawValue)
        }
        var calendar = Calendar(identifier: .gregorian)
        calendar.timeZone = zone
        guard let end = calendar.date(byAdding: .day, value: 1, to: endDayStart) else {
            throw HealthKitSyncEngineError.repairNeeded(HealthKitSyncMetric.sleep.rawValue)
        }
        return try await healthKit.sleepSamples(from: start, to: end)
    }

    private func sleepUpsert(sleepDay: String, totals: HealthKitSleepDayTotals) -> HealthKitSyncOperation {
        .sleepDayUpsert(
            sleepDay: sleepDay,
            totalMinutes: totals.totalMinutes,
            coreMinutes: totals.coreMinutes,
            deepMinutes: totals.deepMinutes,
            remMinutes: totals.remMinutes,
            unspecifiedAsleepMinutes: totals.unspecifiedAsleepMinutes,
            awakeMinutes: totals.awakeMinutes,
            inBedMinutes: totals.inBedMinutes,
            wristTemperatureCelsius: totals.wristTemperatureCelsius,
            breathingDisturbanceCount: totals.breathingDisturbanceCount
        )
    }

    /// Produces canonical records for every non-specialized type in a consent group.
    /// Daily values are recomputed from HealthKit for the repair window, so multiple
    /// sources do not produce duplicate backend rows.
    private func additionalRepairOperations(
        group: HealthKitSyncMetric,
        rangeStart: Date,
        rangeEnd: Date,
        timeZone: String
    ) async throws -> [HealthKitSyncOperation] {
        var operations: [HealthKitSyncOperation] = []
        for dataMetric in HealthKitDataMetric.metrics(for: group) {
            switch dataMetric.storage {
            case .hourly, .sleepDay, .bloodPressure:
                continue
            case .dailyNumeric:
                operations += try await dailyMetricOperations(
                    metric: dataMetric,
                    from: rangeStart,
                    to: rangeEnd,
                    timeZone: timeZone
                )
            case .bloodGlucose:
                let samples = try await healthKit.quantitySamples(for: dataMetric, from: rangeStart, to: rangeEnd)
                guard let unit = dataMetric.unit else { continue }
                operations += samples.map {
                    .bloodGlucoseUpsert(
                        sourceSampleKey: $0.uuid.uuidString.lowercased(),
                        measuredAtUtc: isoInstant($0.startDate),
                        valueMgDl: $0.quantity.doubleValue(for: unit)
                    )
                }
            case .workout:
                let workouts = try await healthKit.workouts(from: rangeStart, to: rangeEnd)
                operations += workouts.map { workoutUpsert($0) }
            }
        }
        return operations
    }

    private func dailyMetricOperations(
        metric: HealthKitDataMetric,
        from start: Date,
        to end: Date,
        timeZone: String
    ) async throws -> [HealthKitSyncOperation] {
        if metric == .mindfulMinutes {
            let sessions = try await healthKit.mindfulSessions(from: start, to: end)
            let grouped = Dictionary(grouping: sessions, by: { localDay(for: $0.endDate, timeZone: timeZone) })
            return grouped.map { day, values in
                .dailyMetricUpsert(
                    healthMetric: metric,
                    localDay: day,
                    sumValue: values.reduce(0) { $0 + $1.endDate.timeIntervalSince($1.startDate) / 60 },
                    averageValue: nil,
                    minimumValue: nil,
                    maximumValue: nil,
                    latestValue: nil,
                    sampleCount: values.count
                )
            }
        }
        guard let unit = metric.unit else { return [] }
        let samples = try await healthKit.quantitySamples(for: metric, from: start, to: end)
        let grouped = Dictionary(grouping: samples, by: { localDay(for: $0.endDate, timeZone: timeZone) })
        return grouped.compactMap { day, values in
            let quantities = values.map { $0.quantity.doubleValue(for: unit) }
            guard !quantities.isEmpty else { return nil }
            switch metric.aggregation {
            case .sum:
                return .dailyMetricUpsert(healthMetric: metric, localDay: day, sumValue: quantities.reduce(0, +), averageValue: nil, minimumValue: nil, maximumValue: nil, latestValue: nil, sampleCount: quantities.count)
            case .statistics:
                guard let latest = values.max(by: { $0.endDate < $1.endDate }) else { return nil }
                return .dailyMetricUpsert(healthMetric: metric, localDay: day, sumValue: nil, averageValue: quantities.reduce(0, +) / Double(quantities.count), minimumValue: quantities.min(), maximumValue: quantities.max(), latestValue: latest.quantity.doubleValue(for: unit), sampleCount: quantities.count)
            case .latest:
                guard let latest = values.max(by: { $0.endDate < $1.endDate }) else { return nil }
                return .dailyMetricUpsert(healthMetric: metric, localDay: day, sumValue: nil, averageValue: nil, minimumValue: nil, maximumValue: nil, latestValue: latest.quantity.doubleValue(for: unit), sampleCount: quantities.count)
            }
        }
    }

    private func workoutUpsert(_ workout: HKWorkout) -> HealthKitSyncOperation {
        let distance = workout.totalDistance?.doubleValue(for: .meter())
        let activeEnergy = HKQuantityType.quantityType(forIdentifier: .activeEnergyBurned)
        let energy = activeEnergy.flatMap { workout.statistics(for: $0)?.sumQuantity()?.doubleValue(for: .kilocalorie()) }
        let heartRate = HKQuantityType.quantityType(forIdentifier: .heartRate)
        let averageHeartRate = heartRate.flatMap { workout.statistics(for: $0)?.averageQuantity()?.doubleValue(for: HKUnit.count().unitDivided(by: .minute())) }
        let maximumHeartRate = heartRate.flatMap { workout.statistics(for: $0)?.maximumQuantity()?.doubleValue(for: HKUnit.count().unitDivided(by: .minute())) }
        return .workoutUpsert(
            sourceSampleKey: workout.uuid.uuidString.lowercased(),
            workoutType: "\(workout.workoutActivityType.rawValue)",
            startedAtUtc: isoInstant(workout.startDate),
            endedAtUtc: isoInstant(workout.endDate),
            durationSeconds: max(0, Int(workout.duration.rounded())),
            activeEnergyKcal: energy,
            distanceMeters: distance,
            averageHeartRateBpm: averageHeartRate,
            maximumHeartRateBpm: maximumHeartRate
        )
    }

    private func localDay(for date: Date, timeZone: String) -> String {
        let formatter = DateFormatter()
        formatter.calendar = Calendar(identifier: .gregorian)
        formatter.locale = Locale(identifier: "en_US_POSIX")
        formatter.timeZone = TimeZone(identifier: timeZone) ?? TimeZone(secondsFromGMT: 0)
        formatter.dateFormat = "yyyy-MM-dd"
        return formatter.string(from: date)
    }

    private func isoHour(_ date: Date) -> String {
        var calendar = Calendar(identifier: .gregorian)
        calendar.timeZone = TimeZone(secondsFromGMT: 0)!
        let comps = calendar.dateComponents([.year, .month, .day, .hour], from: date)
        let hourDate = calendar.date(from: comps) ?? date
        let basic = ISO8601DateFormatter()
        basic.formatOptions = [.withInternetDateTime]
        return basic.string(from: hourDate)
    }

    private func isoInstant(_ date: Date) -> String {
        let formatter = ISO8601DateFormatter()
        formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return formatter.string(from: date)
    }

    private func parseInstant(_ value: String) -> Date? {
        let formatter = ISO8601DateFormatter()
        formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        if let date = formatter.date(from: value) { return date }
        formatter.formatOptions = [.withInternetDateTime]
        return formatter.date(from: value)
    }

    private func parseHour(_ value: String) -> Date? {
        parseInstant(value)
    }

    private func parseDayStart(_ day: String, timeZone: String) -> Date? {
        let formatter = DateFormatter()
        formatter.calendar = Calendar(identifier: .gregorian)
        formatter.locale = Locale(identifier: "en_US_POSIX")
        formatter.timeZone = TimeZone(identifier: timeZone) ?? TimeZone(secondsFromGMT: 0)
        formatter.dateFormat = "yyyy-MM-dd"
        return formatter.date(from: day)
    }
}
