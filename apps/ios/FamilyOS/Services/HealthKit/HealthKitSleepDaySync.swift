import Foundation
import HealthKit

/// Sleep reads over an explicit range supplied by the run module.
/// Day key = local calendar day of sample **end** in profile `healthTimezone`.
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

        let predicate = HKQuery.predicateForSamples(withStart: start, end: end, options: .strictStartDate)
        let samples: [HKCategorySample] = try await querySamples(
            store: store,
            sampleType: sleepType,
            predicate: predicate
        )
        CrashReporting.log("healthkit_sleep_raw_sample_count=\(samples.count)")

        let timeZone = TimeZone(identifier: healthTimezone) ?? .current
        var calendar = Calendar(identifier: .gregorian)
        calendar.timeZone = timeZone

        // day -> sourceKey -> stage minutes
        var byDaySource: [String: [String: StageBucket]] = [:]
        var sourceMeta: [String: SourceMeta] = [:]

        for sample in samples {
            let day = dayString(for: sample.endDate, calendar: calendar)
            let bundleId = sample.sourceRevision.source.bundleIdentifier
            let name = sample.sourceRevision.source.name
            let sourceKey = bundleId.isEmpty ? name : bundleId
            sourceMeta[sourceKey] = SourceMeta(bundleId: bundleId, name: name)

            let minutes = max(0, Int((sample.endDate.timeIntervalSince(sample.startDate) / 60.0).rounded()))
            guard minutes > 0 else { continue }

            var dayMap = byDaySource[day] ?? [:]
            var bucket = dayMap[sourceKey] ?? StageBucket()
            switch sample.value {
            case HKCategoryValueSleepAnalysis.asleepCore.rawValue:
                bucket.core += minutes
            case HKCategoryValueSleepAnalysis.asleepDeep.rawValue:
                bucket.deep += minutes
            case HKCategoryValueSleepAnalysis.asleepREM.rawValue:
                bucket.rem += minutes
            case HKCategoryValueSleepAnalysis.asleepUnspecified.rawValue:
                // Includes deprecated `.asleep` (same raw value).
                bucket.unspecified += minutes
            case HKCategoryValueSleepAnalysis.awake.rawValue:
                bucket.awake += minutes
            case HKCategoryValueSleepAnalysis.inBed.rawValue:
                bucket.inBed += minutes
            default:
                // Unknown stage — treat as unspecified asleep so total still accounts for it.
                bucket.unspecified += minutes
            }
            dayMap[sourceKey] = bucket
            byDaySource[day] = dayMap
        }

        var results: [SleepDaySample] = []
        for day in byDaySource.keys.sorted() {
            guard let dayMap = byDaySource[day], !dayMap.isEmpty else { continue }
            let preferredKey = pickPreferredSource(keys: Array(dayMap.keys), meta: sourceMeta)
            guard let bucket = dayMap[preferredKey] else { continue }

            let total = bucket.core + bucket.deep + bucket.rem + bucket.unspecified
            let clampedTotal = min(1440, max(0, total))
            results.append(
                SleepDaySample(
                    sleepDay: day,
                    totalMinutes: clampedTotal,
                    coreMinutes: min(1440, max(0, bucket.core)),
                    deepMinutes: min(1440, max(0, bucket.deep)),
                    remMinutes: min(1440, max(0, bucket.rem)),
                    unspecifiedAsleepMinutes: min(1440, max(0, bucket.unspecified)),
                    awakeMinutes: min(1440, max(0, bucket.awake)),
                    inBedMinutes: min(1440, max(0, bucket.inBed))
                )
            )
        }

        CrashReporting.log("healthkit_sleep_day_count=\(results.count)")
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
        var core = 0
        var deep = 0
        var rem = 0
        var unspecified = 0
        var awake = 0
        var inBed = 0
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
