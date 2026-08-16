import SwiftUI

/// Health Data screen: per-metric Import history / Sync surface (plan §5).
///
/// Display state derives from local activity first and server history second;
/// a stale server `syncing` with no local run renders as Interrupted, never as
/// an eternal spinner (plan §5.3).
struct HealthKitSyncView: View {
    @ObservedObject var viewModel: HealthBootstrapViewModel
    @State private var repairConfirmationMetric: HealthKitSyncMetric?

    private var healthKit: HealthKitSyncStateViewModel { viewModel.healthKit }

    /// Fixed product order: Blood pressure -> Sleep -> Workouts.
    private var metrics: [HealthKitSyncMetric] { HealthKitSyncAllRunner.metricOrder }

    var body: some View {
        Form {
            Section {
                Toggle(isOn: $viewModel.healthKit.consentGranted) {
                    Text("Upload Apple Health data")
                }
                .disabled(viewModel.selfProfile == nil || healthKit.isBusy)
                .accessibilityIdentifier("healthkit.consentToggle")
                .onChange(of: viewModel.healthKit.consentGranted) { _, granted in
                    if granted {
                        // Default to BP (implemented). Sleep/workouts toggles are separate.
                        if viewModel.healthKit.enabledMetrics.isEmpty {
                            viewModel.healthKit.enabledMetrics = [.vitals]
                        }
                    } else {
                        viewModel.healthKit.enabledMetrics = []
                    }
                }

                if viewModel.healthKit.consentGranted {
                    ForEach(metrics) { metric in
                        metricRow(metric)
                    }

                    Picker("Health timezone", selection: $viewModel.healthKit.selectedTimezone) {
                        ForEach(commonTimezones, id: \.self) { zone in
                            Text(zone).tag(zone)
                        }
                    }
                    .disabled(healthKit.isBusy)
                    .accessibilityIdentifier("healthkit.timezonePicker")

                    if let current = viewModel.healthKit.status?.healthTimezone,
                       current != viewModel.healthKit.selectedTimezone {
                        Toggle("I understand this will require a re-import later", isOn: $viewModel.healthKit.confirmTimezoneChange)
                            .disabled(healthKit.isBusy)
                            .accessibilityIdentifier("healthkit.timezoneConfirm")
                    }

                    Toggle("Notify when background sync uploads", isOn: backgroundAlertsBinding)
                        .disabled(healthKit.isBusy)
                        .accessibilityIdentifier("healthkit.backgroundSyncAlerts")

                    Button(action: { Task { await viewModel.syncAllEnabledHealthMetrics() } }) {
                        HStack {
                            if healthKit.activeRun != nil {
                                ProgressView()
                                    .controlSize(.small)
                            }
                            Text("Sync all enabled")
                        }
                    }
                    .disabled(syncAllDisabled)
                    .accessibilityIdentifier("healthkit.syncAll")

                    Button(healthKit.isSavingSettings ? "Saving..." : "Save changes") {
                        Task {
                            // Only persist groups we support (BP / sleep / workouts).
                            viewModel.healthKit.enabledMetrics = viewModel.healthKit.enabledMetrics
                                .intersection(HealthKitSyncStateViewModel.syncableMetrics)
                            if viewModel.healthKit.consentGranted && viewModel.healthKit.enabledMetrics.isEmpty {
                                viewModel.healthKit.enabledMetrics = [.vitals]
                            }
                            if !viewModel.healthKit.consentGranted {
                                viewModel.healthKit.enabledMetrics = []
                            }
                            if let current = viewModel.healthKit.status?.healthTimezone,
                               current != viewModel.healthKit.selectedTimezone {
                                await viewModel.changeHealthTimezone()
                            } else {
                                await viewModel.saveHealthKitSettings()
                            }
                        }
                    }
                    .disabled(viewModel.selfProfile == nil || healthKit.isBusy)
                    .accessibilityIdentifier("healthkit.save")
                }
            }
        }
        .navigationTitle("Health Data")
        .navigationBarTitleDisplayMode(.large)
        .safeAreaInset(edge: .top, spacing: 0) {
            if let banner = healthKit.progressBanner {
                HealthKitSyncProgressBanner(title: banner.title, detail: banner.detail)
                    .transition(.move(edge: .top).combined(with: .opacity))
            }
        }
        .animation(.easeInOut(duration: 0.2), value: healthKit.progressBanner)
        .task {
            await viewModel.loadHealthKitStatus()
        }
        .alert(
            "Import history again?",
            isPresented: repairAlertPresented,
            presenting: repairConfirmationMetric
        ) { metric in
            Button("Import history", role: .destructive) {
                Task { await viewModel.repairHealthKitMetric(metric: metric) }
            }
            Button("Cancel", role: .cancel) {}
        } message: { metric in
            Text("Re-imports the last 90 days and removes Family OS items in that period that no longer exist in Apple Health.")
        }
    }

    // MARK: - Metric rows

    @ViewBuilder
    private func metricRow(_ metric: HealthKitSyncMetric) -> some View {
        let enabled = healthKit.enabledMetrics.contains(metric)
        VStack(alignment: .leading, spacing: 6) {
            Toggle(isOn: binding(for: metric)) {
                Text(title(for: metric))
            }
            .disabled(viewModel.selfProfile == nil || healthKit.isBusy)
            .accessibilityIdentifier("healthkit.metric.\(metric.rawValue).toggle")

            HStack(alignment: .firstTextBaseline) {
                if healthKit.activeRun?.metric == metric {
                    ProgressView()
                        .controlSize(.small)
                }
                Text(caption(for: metric))
                    .font(.caption2)
                    .foregroundStyle(captionColor(for: metric))
                Spacer()
            }

            if enabled, viewModel.selfProfile != nil {
                HStack(spacing: 12) {
                    if needsImport(for: metric) {
                        Button("Import history") {
                            Task { await viewModel.importHealthKitHistory(metric: metric) }
                        }
                        // Form's automatic button style can otherwise treat the
                        // whole HStack as one row and invoke sibling actions.
                        .buttonStyle(.borderless)
                        .disabled(healthKit.isBusy)
                        .accessibilityIdentifier("healthkit.metric.\(metric.rawValue).import")
                    } else {
                        Button("Sync") {
                            Task { await viewModel.syncHealthKitMetric(metric: metric) }
                        }
                        // Keep Sync and the destructive repair control as
                        // independent hit targets inside this Form row.
                        .buttonStyle(.borderless)
                        .disabled(healthKit.isBusy)
                        .accessibilityIdentifier("healthkit.metric.\(metric.rawValue).sync")

                        Button("Import history") {
                            repairConfirmationMetric = metric
                        }
                        .buttonStyle(.borderless)
                        .disabled(healthKit.isBusy)
                        .foregroundStyle(.secondary)
                        .accessibilityIdentifier("healthkit.metric.\(metric.rawValue).repair")
                    }
                }
                .font(.callout)
            }
        }
        .padding(.vertical, 2)
    }

    // MARK: - Display state derivation (plan §5.3)

    private func needsImport(for metric: HealthKitSyncMetric) -> Bool {
        healthKit.metricState(for: metric)?.needsImport ?? true
    }

    private func caption(for metric: HealthKitSyncMetric) -> String {
        if let active = healthKit.activeRun, active.metric == metric {
            return active.stage.displayText
        }
        guard healthKit.enabledMetrics.contains(metric) else {
            return "Disabled"
        }
        if let error = healthKit.sessionErrors[metric], !error.isEmpty {
            return "Failed: \(error)"
        }
        guard let state = healthKit.metricState(for: metric) else {
            return "Not started"
        }
        // No local run: a stale server in-flight state is an interrupted run.
        if state.status == .syncing || state.status == .backfilling {
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
            return "Ready - Last synced \(Self.lastSyncedFormatter.string(from: date))"
        }
        return "Ready"
    }

    private func captionColor(for metric: HealthKitSyncMetric) -> Color {
        if healthKit.activeRun?.metric == metric {
            return .secondary
        }
        if healthKit.sessionErrors[metric] != nil {
            return .red
        }
        guard let state = healthKit.metricState(for: metric) else {
            return .secondary
        }
        switch state.status {
        case .syncing, .backfilling:
            return .orange
        case .error:
            return .red
        case .ready, .neverSynced, .disabled:
            return .secondary
        }
    }

    private var syncAllDisabled: Bool {
        viewModel.selfProfile == nil
            || healthKit.isBusy
            || !healthKit.consentGranted
            || healthKit.enabledMetrics
                .intersection(HealthKitSyncStateViewModel.implementedSyncMetrics)
                .isEmpty
    }

    private var repairAlertPresented: Binding<Bool> {
        Binding(
            get: { repairConfirmationMetric != nil },
            set: { presented in
                if !presented {
                    repairConfirmationMetric = nil
                }
            }
        )
    }

    private func title(for metric: HealthKitSyncMetric) -> String {
        switch metric {
        case .vitals: return "Blood pressure"
        case .sleep: return "Sleep"
        case .workouts: return "Workouts"
        default: return metric.displayName
        }
    }

    private var backgroundAlertsBinding: Binding<Bool> {
        Binding(
            get: { healthKit.backgroundSyncAlertsEnabled },
            set: { enabled in
                Task { await healthKit.setBackgroundSyncAlertsEnabled(enabled) }
            }
        )
    }

    private func binding(for metric: HealthKitSyncMetric) -> Binding<Bool> {
        Binding(
            get: { viewModel.healthKit.enabledMetrics.contains(metric) },
            set: { enabled in
                if enabled {
                    viewModel.healthKit.enabledMetrics.insert(metric)
                    viewModel.healthKit.consentGranted = true
                } else {
                    viewModel.healthKit.enabledMetrics.remove(metric)
                    if viewModel.healthKit.enabledMetrics.isEmpty {
                        viewModel.healthKit.consentGranted = false
                    }
                }
            }
        )
    }

    private static let lastSyncedFormatter: DateFormatter = {
        let formatter = DateFormatter()
        formatter.dateStyle = .medium
        formatter.timeStyle = .short
        return formatter
    }()

    private var commonTimezones: [String] {
        var zones = [
            TimeZone.current.identifier,
            "UTC",
            "America/Los_Angeles",
            "America/New_York",
            "Europe/London",
            "Asia/Bangkok",
            "Asia/Kolkata",
            "Asia/Tokyo",
            "Australia/Sydney"
        ]
        return Array(Set(zones)).sorted()
    }
}

/// Always-visible run feedback. Complements the in-row stage caption and must
/// not replace it (plan §5.4).
struct HealthKitSyncProgressBanner: View {
    let title: String
    let detail: String

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            ProgressView()
                .progressViewStyle(.linear)
            Text(title)
                .font(.subheadline.weight(.semibold))
            Text(detail)
                .font(.caption)
                .foregroundStyle(.secondary)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(.horizontal, 16)
        .padding(.vertical, 10)
        .background(.bar)
        .accessibilityElement(children: .combine)
        .accessibilityIdentifier("healthkit.syncProgress")
        .accessibilityLabel("\(title). \(detail)")
    }
}
