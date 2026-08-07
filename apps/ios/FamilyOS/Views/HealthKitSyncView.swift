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
                // Keep enabled set honest: consent on → vitals only; off → none.
                if granted {
                    viewModel.healthKit.enabledMetrics = [.vitals]
                } else {
                    viewModel.healthKit.enabledMetrics = []
                }
            }

            if viewModel.healthKit.consentGranted {
                Toggle(isOn: binding(for: .vitals)) {
                    VStack(alignment: .leading, spacing: 4) {
                        Text("Blood pressure")
                        Text("Requests Health permission · Sync now uploads BP only")
                            .font(.caption2)
                            .foregroundStyle(.secondary)
                        if let state = metricState(for: .vitals) {
                            Text(state.status.displayName)
                                .font(.caption2)
                                .foregroundStyle(.secondary)
                        }
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
                    // Never persist cosmetic non-BP groups from older app state.
                    if viewModel.healthKit.consentGranted {
                        viewModel.healthKit.enabledMetrics = [.vitals]
                    } else {
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
                    || !viewModel.healthKit.enabledMetrics.contains(.vitals)
            )
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
                    // Milestone 1: only vitals is implementable.
                    viewModel.healthKit.enabledMetrics = [.vitals]
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
