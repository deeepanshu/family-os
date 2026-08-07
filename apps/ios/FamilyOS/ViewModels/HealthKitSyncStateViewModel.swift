import Foundation

@MainActor
final class HealthKitSyncStateViewModel: ObservableObject {
    @Published var status: HealthKitSyncStatus?
    @Published var isAvailable = false
    @Published var isSyncing = false
    @Published var isAutomaticallySyncing = false
    @Published var linkedProfileId: String?
    @Published var consentGranted = false
    @Published var selectedTimezone = TimeZone.current.identifier
    /// Only groups the app can actually request + sync (milestone 1: BP under vitals).
    static let syncableMetrics: Set<HealthKitSyncMetric> = [.vitals]

    @Published var enabledMetrics: Set<HealthKitSyncMetric> = []
    @Published var confirmTimezoneChange = false
    @Published var backgroundSyncAlertsEnabled = false

    func clear() {
        status = nil
        isAvailable = false
        isSyncing = false
        isAutomaticallySyncing = false
        linkedProfileId = nil
        consentGranted = false
        selectedTimezone = TimeZone.current.identifier
        enabledMetrics = []
        confirmTimezoneChange = false
        backgroundSyncAlertsEnabled = false
    }

    func apply(status: HealthKitSyncStatus) {
        self.status = status
        linkedProfileId = status.personId
        consentGranted = status.consentActive
        selectedTimezone = status.healthTimezone
        // Never re-enable cosmetic groups from the API; only keep syncable ones.
        let fromServer = Set(status.enabledMetrics).intersection(Self.syncableMetrics)
        if status.consentActive {
            enabledMetrics = fromServer.isEmpty ? Self.syncableMetrics : fromServer
        } else {
            enabledMetrics = []
        }
    }

    var metricRows: [HealthKitMetricState] {
        status?.metrics ?? []
    }

    @discardableResult
    func setBackgroundSyncAlertsEnabled(_ enabled: Bool) async -> Bool {
        backgroundSyncAlertsEnabled = false
        return false
    }
}
