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
    @Published var enabledMetrics: Set<HealthKitSyncMetric> = Set(HealthKitSyncMetric.allCases)
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
        enabledMetrics = Set(HealthKitSyncMetric.allCases)
        confirmTimezoneChange = false
        backgroundSyncAlertsEnabled = false
    }

    func apply(status: HealthKitSyncStatus) {
        self.status = status
        linkedProfileId = status.personId
        consentGranted = status.consentActive
        selectedTimezone = status.healthTimezone
        enabledMetrics = Set(status.enabledMetrics.isEmpty ? HealthKitSyncMetric.allCases : status.enabledMetrics)
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
