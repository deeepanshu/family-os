import SwiftUI

struct HealthKitSyncView: View {
    @ObservedObject var viewModel: HealthBootstrapViewModel

    var body: some View {
        Section("HealthKit Sync") {
            LabeledContent("Availability", value: viewModel.healthKit.isAvailable ? "Available" : "Unavailable")

            if let profile = viewModel.selfProfile {
                LabeledContent("Linked profile", value: profile.displayName)
            } else {
                Text("Create your profile to enable HealthKit sync.")
                    .foregroundStyle(.secondary)
            }

            Toggle(isOn: $viewModel.healthKit.consentGranted) {
                VStack(alignment: .leading, spacing: 4) {
                    Text("Upload HealthKit data")
                    Text("Steps, sleep, and blood pressure you enable are uploaded to your Family OS account for health history and MCP access you authorize. Turn off to withdraw consent.")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                }
            }
            .disabled(viewModel.selfProfile == nil)

            if viewModel.healthKit.consentGranted {
                ForEach(HealthKitSyncMetric.allCases) { metric in
                    Toggle(metric.displayName, isOn: binding(for: metric))
                }

                Picker("Health timezone", selection: $viewModel.healthKit.selectedTimezone) {
                    ForEach(commonTimezones, id: \.self) { zone in
                        Text(zone).tag(zone)
                    }
                }

                if let current = viewModel.healthKit.status?.healthTimezone,
                   current != viewModel.healthKit.selectedTimezone {
                    Toggle("I understand this repairs the latest 90 days", isOn: $viewModel.healthKit.confirmTimezoneChange)
                }
            }

            Button("Save HealthKit Settings") {
                Task {
                    if let current = viewModel.healthKit.status?.healthTimezone,
                       current != viewModel.healthKit.selectedTimezone {
                        await viewModel.changeHealthTimezone()
                    } else {
                        await viewModel.saveHealthKitSettings()
                    }
                }
            }
            .disabled(viewModel.selfProfile == nil)

            Button(viewModel.healthKit.isSyncing ? "Syncing..." : "Sync HealthKit Now") {
                Task { await viewModel.syncHealthKitNow() }
            }
            .disabled(
                !viewModel.healthKit.isAvailable
                    || viewModel.selfProfile == nil
                    || viewModel.healthKit.isSyncing
            )

            Text("Background delivery is best effort. iOS may delay updates. Opening the app resumes pending work.")
                .font(.caption)
                .foregroundStyle(.secondary)

            ForEach(viewModel.healthKit.metricRows) { metric in
                VStack(alignment: .leading, spacing: 4) {
                    LabeledContent(metric.metric.displayName, value: metric.status.displayName)
                    if let last = metric.lastSuccessfulAt {
                        Text("Last success: \(last)")
                            .font(.caption2)
                            .foregroundStyle(.secondary)
                    }
                    if let code = metric.lastErrorCode {
                        Text("Status: \(code)")
                            .font(.caption2)
                            .foregroundStyle(.secondary)
                    }
                }
            }
        }
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
        zones = Array(Set(zones)).sorted()
        return zones
    }
}
