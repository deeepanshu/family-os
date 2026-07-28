import SwiftUI

struct HealthKitSyncView: View {
    @ObservedObject var viewModel: HealthBootstrapViewModel

    var body: some View {
        Section("Health Data") {
            Toggle(isOn: $viewModel.healthKit.consentGranted) {
                Text("Upload HealthKit data")
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

            Button("Save changes") {
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

            Button(viewModel.healthKit.isSyncing ? "Syncing..." : "Sync now") {
                Task { await viewModel.syncHealthKitNow() }
            }
            .disabled(syncDisabled)

            if viewModel.healthKit.isAutomaticallySyncing {
                HStack {
                    ProgressView()
                    Text("Resuming sync")
                }
            }

            if !viewModel.healthKit.metricRows.isEmpty {
                Text("Sync status")
                    .font(.subheadline.weight(.semibold))
                    .foregroundStyle(.secondary)

                ForEach(viewModel.healthKit.metricRows) { metric in
                    metricStatusRow(metric)
                }
            }

            Text("Sync diagnostics")
                .font(.subheadline.weight(.semibold))
                .foregroundStyle(.secondary)

            LabeledContent("Queued locally", value: "\(viewModel.healthKit.outboxDiagnostics.pendingEventCount)")
            LabeledContent("Uploading", value: "\(viewModel.healthKit.outboxDiagnostics.inFlightEventCount)")
            LabeledContent("Local failures", value: "\(viewModel.healthKit.outboxDiagnostics.failedEventCount)")
            Toggle("Background sync alerts", isOn: backgroundSyncAlertsBinding)

            ForEach(viewModel.healthKit.outboxDiagnostics.recentTraceEntries.prefix(8)) { entry in
                HStack {
                    Text(entry.origin.displayName)
                    Spacer()
                    Text(entry.phase.displayName)
                        .foregroundStyle(.secondary)
                    if entry.eventCount > 0 {
                        Text("\(entry.eventCount)")
                            .foregroundStyle(.secondary)
                    }
                    Text(entry.timestamp, style: .time)
                        .foregroundStyle(.secondary)
                }
                .font(.caption)
            }

            ForEach(viewModel.healthKit.outboxDiagnostics.backfills) { backfill in
                VStack(alignment: .leading, spacing: 4) {
                    Text("\(displayName(for: backfill.groupKey)) backfill")
                    LabeledContent("Expected", value: "\(backfill.expectedEventCount)")
                    LabeledContent("Acknowledged", value: "\(backfill.acknowledgedEventCount)")
                    LabeledContent("Queued", value: "\(backfill.pendingEventCount)")
                    if backfill.inFlightEventCount > 0 {
                        LabeledContent("Uploading", value: "\(backfill.inFlightEventCount)")
                    }
                    if backfill.failedEventCount > 0 {
                        LabeledContent("Failed", value: "\(backfill.failedEventCount)")
                    }
                }
            }
        }
        .task {
            while !Task.isCancelled {
                viewModel.refreshHealthKitOutboxDiagnostics()
                try? await Task.sleep(nanoseconds: 1_000_000_000)
            }
        }
    }

    private var syncDisabled: Bool {
        !viewModel.healthKit.isAvailable
            || viewModel.selfProfile == nil
            || viewModel.healthKit.isSyncing
            || viewModel.healthKit.isAutomaticallySyncing
    }

    private var backgroundSyncAlertsBinding: Binding<Bool> {
        Binding(
            get: { viewModel.healthKit.backgroundSyncAlertsEnabled },
            set: { enabled in
                Task {
                    await viewModel.healthKit.setBackgroundSyncAlertsEnabled(enabled)
                }
            }
        )
    }

    @ViewBuilder
    private func metricStatusRow(_ metric: HealthKitMetricState) -> some View {
        VStack(alignment: .leading, spacing: 4) {
            LabeledContent(metric.metric.displayName, value: metric.status.displayName)
            if let detail = metricStatusDetail(metric) {
                Text(detail)
                    .font(.caption2)
                    .foregroundStyle(.secondary)
            }
        }
    }

    private func metricStatusDetail(_ metric: HealthKitMetricState) -> String? {
        if let code = metric.lastErrorCode {
            return "Status: \(code)"
        }
        if let last = metric.lastSuccessfulAt {
            return "Last synced: \(last)"
        }
        return nil
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

    private func displayName(for groupKey: String) -> String {
        HealthKitSyncMetric(rawValue: groupKey)?.displayName ?? groupKey.capitalized
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
