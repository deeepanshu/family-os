import SwiftUI

struct HealthKitSyncView: View {
    @ObservedObject var viewModel: HealthBootstrapViewModel
    @State private var isSavingSettings = false

    var body: some View {
        Section("Health Data") {
            Toggle(isOn: $viewModel.healthKit.consentGranted) {
                Text("Upload HealthKit data")
            }
            .disabled(viewModel.selfProfile == nil)
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
                ForEach(
                    Array(HealthKitSyncStateViewModel.syncableMetrics).sorted { $0.rawValue < $1.rawValue }
                ) { metric in
                    Toggle(isOn: binding(for: metric)) {
                        metricLabel(metric)
                    }
                }

                Picker("Health timezone", selection: $viewModel.healthKit.selectedTimezone) {
                    ForEach(commonTimezones, id: \.self) { zone in
                        Text(zone).tag(zone)
                    }
                }

                if let current = viewModel.healthKit.status?.healthTimezone,
                   current != viewModel.healthKit.selectedTimezone {
                    Toggle("I understand this will require a re-import later", isOn: $viewModel.healthKit.confirmTimezoneChange)
                }
            }

            Button(isSavingSettings ? "Saving..." : "Save changes") {
                Task {
                    isSavingSettings = true
                    defer { isSavingSettings = false }
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
            .disabled(viewModel.selfProfile == nil || isSavingSettings)

            Button(viewModel.healthKit.isSyncing ? "Syncing..." : "Sync now") {
                Task { await viewModel.syncHealthKitNow() }
            }
            .disabled(
                viewModel.selfProfile == nil
                    || viewModel.healthKit.isSyncing
                    || !viewModel.healthKit.consentGranted
                    || viewModel.healthKit.enabledMetrics
                        .intersection(HealthKitSyncStateViewModel.implementedSyncMetrics)
                        .isEmpty
            )
        }
    }

    @ViewBuilder
    private func metricLabel(_ metric: HealthKitSyncMetric) -> some View {
        VStack(alignment: .leading, spacing: 4) {
            Text(title(for: metric))
            if let state = metricState(for: metric) {
                Text(statusCaption(for: state))
                    .font(.caption2)
                    .foregroundStyle(statusColor(for: state.status))
            }
        }
    }

    private func statusCaption(for state: HealthKitMetricState) -> String {
        switch state.status {
        case .error:
            if let code = state.lastErrorCode, !code.isEmpty {
                return "Failed (\(code))"
            }
            return "Failed"
        default:
            return state.status.displayName
        }
    }

    private func statusColor(for status: HealthKitMetricSyncStatus) -> Color {
        switch status {
        case .ready:
            return .secondary
        case .syncing, .backfilling:
            return .orange
        case .error:
            return .red
        case .neverSynced, .disabled:
            return .secondary
        }
    }

    private func title(for metric: HealthKitSyncMetric) -> String {
        switch metric {
        case .vitals: return "Blood pressure"
        case .sleep: return "Sleep"
        case .workouts: return "Workouts"
        default: return metric.displayName
        }
    }

    private func metricState(for metric: HealthKitSyncMetric) -> HealthKitMetricState? {
        viewModel.healthKit.metricRows.first { $0.metric == metric }
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
