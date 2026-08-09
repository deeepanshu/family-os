import Foundation

/// A locally active run for one metric (plan §5.3: only local activity renders
/// as active progress).
struct HealthKitActiveRun: Equatable, Sendable {
    let metric: HealthKitSyncMetric
    let kind: HealthKitRunKind
    var stage: HealthKitRunStage
}

@MainActor
final class HealthKitSyncStateViewModel: ObservableObject {
    @Published var status: HealthKitSyncStatus?
    @Published var isAvailable = false
    @Published var isSyncing = false
    @Published var isAutomaticallySyncing = false
    @Published var linkedProfileId: String?
    @Published var consentGranted = false
    @Published var selectedTimezone = TimeZone.current.identifier
    /// HealthKit groups we intend to support.
    static let syncableMetrics: Set<HealthKitSyncMetric> = HealthKitSyncMetric.productMetrics
    /// Groups with a working foreground + background sync path today.
    static let implementedSyncMetrics: Set<HealthKitSyncMetric> = HealthKitSyncMetric.productMetrics

    @Published var enabledMetrics: Set<HealthKitSyncMetric> = []
    @Published var confirmTimezoneChange = false
    @Published var backgroundSyncAlertsEnabled = false

    /// Shared busy state (plan §5.5): lives in the observable feature model so
    /// every conflicting control can lock while a save or run is in flight.
    @Published var isSavingSettings = false
    /// The one locally active run (runs serialize process-wide through the gate).
    @Published var activeRun: HealthKitActiveRun?
    /// Per-metric actionable failure for the current session (plan §5.3).
    @Published var sessionErrors: [HealthKitSyncMetric: String] = [:]

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
        isSavingSettings = false
        activeRun = nil
        sessionErrors = [:]
    }

    func apply(status: HealthKitSyncStatus) {
        self.status = status
        linkedProfileId = status.personId
        consentGranted = status.consentActive
        selectedTimezone = status.healthTimezone
        // Never re-enable cosmetic groups from the API; only keep syncable ones.
        let fromServer = Set(status.enabledMetrics).intersection(Self.syncableMetrics)
        // The server's canonical enabled set is authoritative. In particular,
        // an empty enabled set must not silently turn every metric back on.
        enabledMetrics = status.consentActive ? fromServer : []
    }

    var metricRows: [HealthKitMetricState] {
        status?.metrics ?? []
    }

    func metricState(for metric: HealthKitSyncMetric) -> HealthKitMetricState? {
        metricRows.first { $0.metric == metric }
    }

    /// True while a save or any run is active; every conflicting control locks.
    var isBusy: Bool {
        isSavingSettings || activeRun != nil
    }

    func beginRun(metric: HealthKitSyncMetric, kind: HealthKitRunKind) {
        activeRun = HealthKitActiveRun(metric: metric, kind: kind, stage: .preparing)
        sessionErrors[metric] = nil
    }

    func updateActiveRunStage(_ stage: HealthKitRunStage) {
        activeRun?.stage = stage
    }

    func endRun(metric: HealthKitSyncMetric, error: String? = nil) {
        activeRun = nil
        recordRunResult(metric: metric, error: error)
    }

    /// Records a completed per-metric result without clearing the current run.
    /// Sync all uses this between metrics so every conflicting control stays
    /// locked for the entire command, not just each individual network call.
    func recordRunResult(metric: HealthKitSyncMetric, error: String? = nil) {
        if let error {
            sessionErrors[metric] = error
        } else {
            sessionErrors[metric] = nil
        }
    }

    func clearActiveRun() {
        activeRun = nil
    }

    @discardableResult
    func setBackgroundSyncAlertsEnabled(_ enabled: Bool) async -> Bool {
        backgroundSyncAlertsEnabled = false
        return false
    }
}
