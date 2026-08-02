import SwiftUI

struct HealthKitSyncView: View {
    @ObservedObject var viewModel: HealthBootstrapViewModel
    @State private var isSavingSettings = false

    var body: some View {
        Section("Health Data") {
            Text("Milestone 1: enable Vitals (blood pressure) and Sync now. Other groups are listed for consent but only BP uploads today.")
                .font(.caption)
                .foregroundStyle(.secondary)

            Toggle(isOn: $viewModel.healthKit.consentGranted) {
                Text("Upload HealthKit data")
            }
            .disabled(viewModel.selfProfile == nil)

            if viewModel.healthKit.consentGranted {
                // Surface BP clearly; API group remains "vitals".
                ForEach(milestoneToggleGroups) { metric in
                    Toggle(isOn: binding(for: metric)) {
                        metricToggleLabel(metric)
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

    /// Groups shown in Settings for milestone 1 (avoid dumping nutrition matrix).
    private var milestoneToggleGroups: [HealthKitSyncMetric] {
        [.vitals, .activity, .sleep, .body, .workouts]
    }

    @ViewBuilder
    private func metricToggleLabel(_ metric: HealthKitSyncMetric) -> some View {
        VStack(alignment: .leading, spacing: 4) {
            Text(toggleTitle(for: metric))
            if metric == .vitals {
                Text("Blood pressure")
                    .font(.caption2)
                    .foregroundStyle(.secondary)
            }
            if let state = metricState(for: metric) {
                Text(state.status.displayName)
                    .font(.caption2)
                    .foregroundStyle(.secondary)
            }
        }
    }

    private func toggleTitle(for metric: HealthKitSyncMetric) -> String {
        switch metric {
        case .vitals:
            return "Vitals (blood pressure)"
        default:
            return metric.displayName
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
                } else {
                    viewModel.healthKit.enabledMetrics.remove(metric)
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
