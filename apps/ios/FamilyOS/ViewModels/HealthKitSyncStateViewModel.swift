import Foundation
import UserNotifications

/// A locally active run for one metric (plan §5.3: only local activity renders
/// as active progress).
struct HealthKitActiveRun: Equatable, Sendable {
    let metric: HealthKitSyncMetric
    let kind: HealthKitRunKind
    var stage: HealthKitRunStage

    var productTitle: String {
        switch metric {
        case .vitals: return "Blood pressure"
        case .sleep: return "Sleep"
        case .workouts: return "Workouts"
        case .activity: return "Activity"
        default: return metric.displayName
        }
    }

    var bannerTitle: String {
        switch kind {
        case .initialImport:
            return "Importing \(productTitle)"
        case .repairImport:
            return "Re-importing \(productTitle)"
        case .sync:
            return "Syncing \(productTitle)"
        }
    }

    var bannerDetail: String { stage.displayText }
}

/// Global progress copy for the pinned banner. In-row captions stay the
/// primary per-metric surface (plan §5.4).
struct HealthKitSyncProgressBannerState: Equatable, Sendable {
    let title: String
    let detail: String
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
    @Published var backgroundSyncAlertsEnabled = UserDefaults.standard.bool(
        forKey: DefaultsKey.healthkitBackgroundSyncAlerts
    )

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
        backgroundSyncAlertsEnabled = UserDefaults.standard.bool(
            forKey: DefaultsKey.healthkitBackgroundSyncAlerts
        )
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

    /// Pinned banner copy. Prefer the live run; fall back to settings save so
    /// the user still sees activity before HealthKit authorization starts.
    var progressBanner: HealthKitSyncProgressBannerState? {
        if let activeRun {
            return HealthKitSyncProgressBannerState(
                title: activeRun.bannerTitle,
                detail: activeRun.bannerDetail
            )
        }
        if isSavingSettings {
            return HealthKitSyncProgressBannerState(
                title: "Saving HealthKit settings",
                detail: "Updating your preferences…"
            )
        }
        return nil
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
        if enabled {
            let granted = await requestNotificationAuthorization()
            guard granted else {
                backgroundSyncAlertsEnabled = false
                UserDefaults.standard.set(false, forKey: DefaultsKey.healthkitBackgroundSyncAlerts)
                return false
            }
        }
        backgroundSyncAlertsEnabled = enabled
        UserDefaults.standard.set(enabled, forKey: DefaultsKey.healthkitBackgroundSyncAlerts)
        return enabled
    }

    private func requestNotificationAuthorization() async -> Bool {
        await withCheckedContinuation { continuation in
            UNUserNotificationCenter.current().requestAuthorization(options: [.alert, .sound]) { granted, _ in
                continuation.resume(returning: granted)
            }
        }
    }
}
