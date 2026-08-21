import Foundation
import HealthKit

/// Sleep reads over an explicit range supplied by the run module.
/// Day key = local calendar day of the **session end** (wake) in `healthTimezone`.
/// Same-source samples within `sessionGap` are one night; pre-midnight stages
/// stay with that night instead of becoming yesterday's leftover minutes.
///
/// Incremental sync windows are ~24h and use the sample start. Overnight
/// sessions start the previous evening, so a naive `strictStartDate` query
/// drops the night and upserts only leftover morning stages (tens of minutes).
/// Query overlapping samples with a lead-in, and only emit days whose bedtime
/// cannot have been clipped by the query start.
enum HealthKitSleepDaySync {
    struct SleepDaySample: Sendable {
        let sleepDay: String // YYYY-MM-DD
        let totalMinutes: Int
        let coreMinutes: Int
        let deepMinutes: Int
        let remMinutes: Int
        let unspecifiedAsleepMinutes: Int
        let awakeMinutes: Int
        let inBedMinutes: Int
    }

    static func naturalKey(for sample: SleepDaySample) -> String {
        "sleep_day:\(sample.sleepDay)"
    }

    /// Sessions that end in the server window can start the previous evening.
    static let overnightLookback: TimeInterval = 48 * 60 * 60
    /// Do not emit a sleep day unless the query started at least this far
    /// before that local midnight — otherwise the night may be truncated.
    static let completeNightLeadIn: TimeInterval = 12 * 60 * 60
    /// Watch treats nearby stages as one night. Gaps longer than this are a nap.
    static let sessionGap: TimeInterval = 3 * 60 * 60

    struct SleepInterval: Sendable, Equatable {
        let start: Date
        let end: Date
        let value: Int
        let sourceBundleId: String
        let sourceName: String
    }

    static func fetchSleepDays(
        from start: Date,
        through end: Date,
        healthTimezone: String,
        store: HKHealthStore = HKHealthStore()
    ) async throws -> [SleepDaySample] {
        #if DEBUG
        if ProcessInfo.processInfo.arguments.contains("-FamilyOSLocalSmoke") {
            CrashReporting.log("healthkit_sleep_fetch_skipped_for_local_smoke")
            return []
        }
        #endif

        guard let sleepType = HKObjectType.categoryType(forIdentifier: .sleepAnalysis) else {
            return []
        }

        let queryStart = start.addingTimeInterval(-overnightLookback)
        let predicate = HKQuery.predicateForSamples(withStart: queryStart, end: end, options: [])
        let samples: [HKCategorySample] = try await querySamples(
            store: store,
            sampleType: sleepType,
            predicate: predicate
        )
        CrashReporting.log("healthkit_sleep_raw_sample_count=\(samples.count)")

        let intervals = samples.map { sample in
            SleepInterval(
                start: sample.startDate,
                end: sample.endDate,
                value: sample.value,
                sourceBundleId: sample.sourceRevision.source.bundleIdentifier,
                sourceName: sample.sourceRevision.source.name
            )
        }
        let results = aggregateSleepDays(
            intervals: intervals,
            healthTimezone: healthTimezone,
            queryStart: queryStart,
            rangeEnd: end
        )
        CrashReporting.log("healthkit_sleep_day_count=\(results.count)")
        return results
    }

    /// Aggregates stage minutes per wake day, preferring Apple/Watch.
    /// Same-source samples separated by at most `sessionGap` form one session
    /// attributed to the local day the session ends. Days whose local midnight
    /// is less than `completeNightLeadIn` after `queryStart` are omitted so a
    /// clipped query cannot overwrite a full night.
    static func aggregateSleepDays(
        intervals: [SleepInterval],
        healthTimezone: String,
        queryStart: Date,
        rangeEnd: Date
    ) -> [SleepDaySample] {
        let timeZone = TimeZone(identifier: healthTimezone) ?? .current
        var calendar = Calendar(identifier: .gregorian)
        calendar.timeZone = timeZone
        let minCompleteDayStart = queryStart.addingTimeInterval(completeNightLeadIn)

        var bySource: [String: [SleepInterval]] = [:]
        var sourceMeta: [String: SourceMeta] = [:]
        for interval in intervals {
            guard interval.end > queryStart, interval.start < rangeEnd else { continue }
            let key = sourceKey(for: interval)
            sourceMeta[key] = SourceMeta(bundleId: interval.sourceBundleId, name: interval.sourceName)
            bySource[key, default: []].append(interval)
        }

        var byDaySource: [String: [String: StageBucket]] = [:]
        for (key, sourceIntervals) in bySource {
            for session in clusteredSessions(sourceIntervals) {
                guard session.end > queryStart, session.start < rangeEnd else { continue }
                let dayStart = calendar.startOfDay(for: session.end)
                guard dayStart >= minCompleteDayStart else { continue }
                let day = dayString(for: session.end, calendar: calendar)
                var dayMap = byDaySource[day] ?? [:]
                var bucket = dayMap[key] ?? StageBucket()
                bucket.add(session.bucket)
                dayMap[key] = bucket
                byDaySource[day] = dayMap
            }
        }

        var results: [SleepDaySample] = []
        for day in byDaySource.keys.sorted() {
            guard let dayMap = byDaySource[day], !dayMap.isEmpty else { continue }
            let preferredKey = pickPreferredSource(keys: Array(dayMap.keys), meta: sourceMeta)
            guard let bucket = dayMap[preferredKey] else { continue }
            results.append(bucket.clampedSample(sleepDay: day))
        }
        return results
    }

    static func enqueueSamples(_ samples: [SleepDaySample], into syncStore: HealthKitSyncStore) throws {
        let encoder = JSONEncoder()
        var ops: [PendingOpRecord] = []
        ops.reserveCapacity(samples.count)
        for sample in samples {
            let payload = HealthKitOpPayloadWire.sleepDay(
                sleepDay: sample.sleepDay,
                totalMinutes: sample.totalMinutes,
                coreMinutes: sample.coreMinutes,
                deepMinutes: sample.deepMinutes,
                remMinutes: sample.remMinutes,
                unspecifiedAsleepMinutes: sample.unspecifiedAsleepMinutes,
                awakeMinutes: sample.awakeMinutes,
                inBedMinutes: sample.inBedMinutes
            )
            let data = try encoder.encode(payload)
            let json = String(data: data, encoding: .utf8)
            ops.append(
                PendingOpRecord(
                    opId: UUID().uuidString.lowercased(),
                    naturalKey: "sleep_day:\(sample.sleepDay)",
                    groupKey: "sleep",
                    scopeKey: "sleep",
                    op: "upsert",
                    payloadJSON: json
                )
            )
        }
        try syncStore.enqueue(ops: ops)
    }

    // MARK: - Private

    private struct SourceMeta {
        let bundleId: String
        let name: String
    }

    private struct StageBucket {
        var core: TimeInterval = 0
        var deep: TimeInterval = 0
        var rem: TimeInterval = 0
        var unspecified: TimeInterval = 0
        var awake: TimeInterval = 0
        var inBed: TimeInterval = 0

        mutating func add(_ other: StageBucket) {
            core += other.core
            deep += other.deep
            rem += other.rem
            unspecified += other.unspecified
            awake += other.awake
            inBed += other.inBed
        }

        mutating func add(_ interval: SleepInterval, duration: TimeInterval) {
            switch interval.value {
            case HKCategoryValueSleepAnalysis.asleepCore.rawValue:
                core += duration
            case HKCategoryValueSleepAnalysis.asleepDeep.rawValue:
                deep += duration
            case HKCategoryValueSleepAnalysis.asleepREM.rawValue:
                rem += duration
            case HKCategoryValueSleepAnalysis.asleepUnspecified.rawValue:
                unspecified += duration
            case HKCategoryValueSleepAnalysis.awake.rawValue:
                awake += duration
            case HKCategoryValueSleepAnalysis.inBed.rawValue:
                inBed += duration
            default:
                unspecified += duration
            }
        }

        func clampedSample(sleepDay: String) -> SleepDaySample {
            let coreMinutes = minutes(core)
            let deepMinutes = minutes(deep)
            let remMinutes = minutes(rem)
            var unspecifiedMinutes = minutes(unspecified)
            let totalMinutes = minutes(core + deep + rem + unspecified)
            let stageSum = coreMinutes + deepMinutes + remMinutes + unspecifiedMinutes
            if totalMinutes > stageSum {
                unspecifiedMinutes += totalMinutes - stageSum
            }
            return SleepDaySample(
                sleepDay: sleepDay,
                totalMinutes: totalMinutes,
                coreMinutes: coreMinutes,
                deepMinutes: deepMinutes,
                remMinutes: remMinutes,
                unspecifiedAsleepMinutes: unspecifiedMinutes,
                awakeMinutes: minutes(awake),
                inBedMinutes: minutes(inBed)
            )
        }

        private func minutes(_ seconds: TimeInterval) -> Int {
            min(1440, max(0, Int((seconds / 60.0).rounded())))
        }
    }

    private struct SleepSession {
        var start: Date
        var end: Date
        var bucket: StageBucket
    }

    private static func sourceKey(for interval: SleepInterval) -> String {
        interval.sourceBundleId.isEmpty ? interval.sourceName : interval.sourceBundleId
    }

    private static func clusteredSessions(_ intervals: [SleepInterval]) -> [SleepSession] {
        let sorted = intervals.sorted { $0.start < $1.start }
        var sessions: [SleepSession] = []
        for interval in sorted {
            let duration = interval.end.timeIntervalSince(interval.start)
            guard duration > 0 else { continue }
            if var current = sessions.last, interval.start.timeIntervalSince(current.end) <= sessionGap {
                current.start = min(current.start, interval.start)
                current.end = max(current.end, interval.end)
                current.bucket.add(interval, duration: duration)
                sessions[sessions.count - 1] = current
            } else {
                var bucket = StageBucket()
                bucket.add(interval, duration: duration)
                sessions.append(SleepSession(start: interval.start, end: interval.end, bucket: bucket))
            }
        }
        return sessions
    }

    private static func pickPreferredSource(keys: [String], meta: [String: SourceMeta]) -> String {
        func score(_ key: String) -> (Int, String) {
            let info = meta[key]
            let bundle = (info?.bundleId ?? key).lowercased()
            let name = (info?.name ?? "").lowercased()
            var rank = 0
            if bundle.contains("com.apple.health") { rank += 100 }
            if bundle.contains("com.apple") { rank += 50 }
            if name.contains("apple") { rank += 20 }
            if bundle.contains("watch") || name.contains("watch") { rank += 10 }
            return (rank, bundle)
        }
        return keys.max { a, b in
            let sa = score(a)
            let sb = score(b)
            if sa.0 != sb.0 { return sa.0 < sb.0 }
            return sa.1 > sb.1 // lower bundle id wins ties for stability
        } ?? keys[0]
    }

    private static func dayString(for date: Date, calendar: Calendar) -> String {
        let parts = calendar.dateComponents([.year, .month, .day], from: date)
        let y = parts.year ?? 1970
        let m = parts.month ?? 1
        let d = parts.day ?? 1
        return String(format: "%04d-%02d-%02d", y, m, d)
    }

    private static func querySamples<T: HKSample>(
        store: HKHealthStore,
        sampleType: HKSampleType,
        predicate: NSPredicate
    ) async throws -> [T] {
        try await withCheckedThrowingContinuation { continuation in
            let query = HKSampleQuery(
                sampleType: sampleType,
                predicate: predicate,
                limit: HKObjectQueryNoLimit,
                sortDescriptors: [NSSortDescriptor(key: HKSampleSortIdentifierEndDate, ascending: true)]
            ) { _, samples, error in
                if let error {
                    continuation.resume(throwing: error)
                    return
                }
                continuation.resume(returning: (samples as? [T]) ?? [])
            }
            store.execute(query)
        }
    }
}
