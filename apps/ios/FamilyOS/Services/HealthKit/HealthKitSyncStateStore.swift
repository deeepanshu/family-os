import Foundation
import HealthKit

struct HealthKitLocalMetricState: Codable {
    var anchorData: Data?
    var pendingSync: Bool
    var repairId: String?
    /// Next chunk index to upload (0-based).
    var repairChunkIndex: Int?
    var repairExpectedChunks: Int?
    var repairRangeStart: String?
    var repairRangeEnd: String?
    /// Profile-local calendar-day bounds used only for sleep repairs.
    var repairRangeStartDay: String?
    var repairRangeEndDay: String?
    /// Stable syncId per chunk index for idempotent resume.
    var repairChunkSyncIds: [String: String]?
    var lastErrorCode: String?
    var lastSuccessfulAt: Date?
    var redactedStatus: String?
}

/// One HealthKit source object may affect many canonical buckets (e.g. multi-hour steps).
struct HealthKitLedgerEntry: Codable {
    var sourceUUID: String
    var metric: String
    /// All canonical buckets touched by this source UUID.
    var bucketKeys: [String]
    var measuredAt: Date?
    var expiresAt: Date
}

/// Persisted, device-local configuration required for non-UI background sync.
struct HealthKitLocalConfiguration: Codable {
    var userId: String
    var personId: String
    var healthTimezone: String
    var healthTimezoneVersion: Int
    var enabledMetrics: [HealthKitSyncMetric]
    var consentVersion: String?
    var installationId: String
    var updatedAt: Date
}

/// Device-local technical state. Never logs values/UUIDs/anchors/tokens.
actor HealthKitSyncStateStore {
    private let defaults = UserDefaults.standard
    private let keychain = KeychainStore()
    private let installationKey = "healthkit.installationId"
    private let configurationKey = "healthkit.localConfiguration"
    private let fileManager = FileManager.default

    func installationId() throws -> String {
        if let existing = try keychain.string(for: installationKey), !existing.isEmpty {
            return existing
        }
        let created = UUID().uuidString.lowercased()
        try keychain.set(created, for: installationKey)
        return created
    }

    func saveConfiguration(_ configuration: HealthKitLocalConfiguration) {
        if let data = try? JSONEncoder().encode(configuration) {
            defaults.set(data, forKey: configurationKey)
        }
    }

    func loadConfiguration() -> HealthKitLocalConfiguration? {
        guard let data = defaults.data(forKey: configurationKey),
              let decoded = try? JSONDecoder().decode(HealthKitLocalConfiguration.self, from: data)
        else {
            return nil
        }
        return decoded
    }

    func clearConfiguration() {
        defaults.removeObject(forKey: configurationKey)
    }

    func loadMetricState(userId: String, personId: String, metric: HealthKitSyncMetric) -> HealthKitLocalMetricState {
        let key = metricStateKey(userId: userId, personId: personId, metric: metric)
        guard let data = defaults.data(forKey: key),
              let decoded = try? JSONDecoder().decode(HealthKitLocalMetricState.self, from: data)
        else {
            return HealthKitLocalMetricState(
                anchorData: nil,
                pendingSync: false,
                repairId: nil,
                repairChunkIndex: nil,
                repairExpectedChunks: nil,
                repairRangeStart: nil,
                repairRangeEnd: nil,
                repairRangeStartDay: nil,
                repairRangeEndDay: nil,
                repairChunkSyncIds: nil,
                lastErrorCode: nil,
                lastSuccessfulAt: nil,
                redactedStatus: nil
            )
        }
        return decoded
    }

    func saveMetricState(userId: String, personId: String, metric: HealthKitSyncMetric, state: HealthKitLocalMetricState) {
        let key = metricStateKey(userId: userId, personId: personId, metric: metric)
        if let data = try? JSONEncoder().encode(state) {
            defaults.set(data, forKey: key)
        }
    }

    func loadAnchor(userId: String, personId: String, metric: HealthKitSyncMetric) -> HKQueryAnchor? {
        let state = loadMetricState(userId: userId, personId: personId, metric: metric)
        guard let data = state.anchorData else { return nil }
        return try? NSKeyedUnarchiver.unarchivedObject(ofClass: HKQueryAnchor.self, from: data)
    }

    func saveAnchor(_ anchor: HKQueryAnchor?, userId: String, personId: String, metric: HealthKitSyncMetric) {
        var state = loadMetricState(userId: userId, personId: personId, metric: metric)
        if let anchor {
            state.anchorData = try? NSKeyedArchiver.archivedData(withRootObject: anchor, requiringSecureCoding: true)
        } else {
            state.anchorData = nil
        }
        saveMetricState(userId: userId, personId: personId, metric: metric, state: state)
    }

    func clearMetric(userId: String, personId: String, metric: HealthKitSyncMetric) {
        defaults.removeObject(forKey: metricStateKey(userId: userId, personId: personId, metric: metric))
        try? fileManager.removeItem(at: ledgerURL(userId: userId, personId: personId, metric: metric))
    }

    func clearAll(userId: String, personId: String) {
        for metric in HealthKitSyncMetric.allCases {
            clearMetric(userId: userId, personId: personId, metric: metric)
        }
        clearConfiguration()
    }

    /// Ledger keyed by source UUID → multi-bucket entry.
    func loadLedger(userId: String, personId: String, metric: HealthKitSyncMetric) -> [String: HealthKitLedgerEntry] {
        let url = ledgerURL(userId: userId, personId: personId, metric: metric)
        guard let data = try? Data(contentsOf: url),
              let decoded = try? JSONDecoder().decode([String: HealthKitLedgerEntry].self, from: data)
        else {
            return [:]
        }
        let now = Date()
        return decoded.filter { $0.value.expiresAt > now }
    }

    func saveLedger(_ ledger: [String: HealthKitLedgerEntry], userId: String, personId: String, metric: HealthKitSyncMetric) {
        let url = ledgerURL(userId: userId, personId: personId, metric: metric)
        try? fileManager.createDirectory(at: url.deletingLastPathComponent(), withIntermediateDirectories: true)
        if let data = try? JSONEncoder().encode(ledger) {
            try? data.write(to: url, options: [.atomic, .completeFileProtectionUntilFirstUserAuthentication])
        }
    }

    private func metricStateKey(userId: String, personId: String, metric: HealthKitSyncMetric) -> String {
        "healthkit.metricState.\(userId).\(personId).\(metric.rawValue)"
    }

    private func ledgerURL(userId: String, personId: String, metric: HealthKitSyncMetric) -> URL {
        let base = fileManager.urls(for: .applicationSupportDirectory, in: .userDomainMask).first
            ?? fileManager.temporaryDirectory
        return base
            .appendingPathComponent("FamilyOS", isDirectory: true)
            .appendingPathComponent("HealthKitLedger", isDirectory: true)
            .appendingPathComponent("\(userId)_\(personId)_\(metric.rawValue).json")
    }
}
