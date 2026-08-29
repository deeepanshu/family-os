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
        case .vitals: return "Blood pressure, heart rate & blood glucose"
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
    /// True while any local foreground/background run holds the process gate.
    @Published var localRunInProgress = false
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
        localRunInProgress = false
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
        if !localRunInProgress {
            for group in status.groups where group.status == .syncing || group.status == .backfilling {
                CrashReporting.log("healthkit_status_stale_inflight group=\(group.group.rawValue)")
            }
        }
    }

    func applyRunActivity(_ snapshot: HealthKitRunActivity.Snapshot) {
        localRunInProgress = snapshot.isRunning
        if snapshot.isRunning, let metric = snapshot.metric {
            let kind = snapshot.kind ?? .sync
            let stage = snapshot.stage ?? .preparing
            if activeRun?.metric != metric || activeRun?.kind != kind {
                activeRun = HealthKitActiveRun(metric: metric, kind: kind, stage: stage)
            } else {
                activeRun?.stage = stage
            }
        } else if !snapshot.isRunning {
            activeRun = nil
        }
    }

    var metricRows: [HealthKitMetricState] {
        status?.metrics ?? []
    }

    func metricState(for metric: HealthKitSyncMetric) -> HealthKitMetricState? {
        metricRows.first { $0.metric == metric }
    }

    /// True while a save or any run is active; every conflicting control locks.
    var isBusy: Bool {
        isSavingSettings || activeRun != nil || localRunInProgress
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

enum HealthKitMetricCaption {
    enum Tone: Equatable {
        case secondary
        case warning
        case error
    }

    static let lastSyncedFormatter: DateFormatter = {
        let formatter = DateFormatter()
        formatter.dateStyle = .medium
        formatter.timeStyle = .short
        return formatter
    }()

    static func text(
        metric: HealthKitSyncMetric,
        enabled: Bool,
        activeRun: HealthKitActiveRun?,
        localRunInProgress: Bool,
        sessionError: String?,
        state: HealthKitMetricState?
    ) -> String {
        if let active = activeRun, active.metric == metric {
            return active.stage.displayText
        }
        guard enabled else { return "Disabled" }
        if let error = sessionError, !error.isEmpty {
            return "Failed: \(error)"
        }
        guard let state else { return "Not started" }
        if state.status == .syncing || state.status == .backfilling {
            if localRunInProgress {
                return "Waiting…"
            }
            return state.needsImport
                ? "Interrupted - try Import history again."
                : "Interrupted - try Sync or Import history again."
        }
        if state.needsImport {
            return "Not started"
        }
        if state.status == .error {
            if let code = state.lastErrorCode, !code.isEmpty {
                return "Failed (\(code))"
            }
            return "Failed"
        }
        if let last = state.lastSuccessfulAt,
           let date = HealthKitRunEngine.parseISODate(last) {
            return "Ready - Last synced \(lastSyncedFormatter.string(from: date))"
        }
        return "Ready"
    }

    static func tone(
        metric: HealthKitSyncMetric,
        enabled: Bool,
        activeRun: HealthKitActiveRun?,
        localRunInProgress: Bool,
        sessionError: String?,
        state: HealthKitMetricState?
    ) -> Tone {
        if activeRun?.metric == metric {
            return .secondary
        }
        if sessionError != nil {
            return .error
        }
        guard enabled else { return .secondary }
        guard let state else { return .secondary }
        switch state.status {
        case .syncing, .backfilling:
            return localRunInProgress ? .secondary : .warning
        case .error:
            return .error
        case .ready, .neverSynced, .disabled:
            return .secondary
        }
    }
}
