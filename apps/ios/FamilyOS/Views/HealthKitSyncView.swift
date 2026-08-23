import SwiftUI

/// Apple Health upload settings. Hosted on Profile — always the signed-in self.
struct HealthKitSettingsSections: View {
    @ObservedObject var viewModel: HealthBootstrapViewModel
    @State private var repairConfirmationMetric: HealthKitSyncMetric?

    private var healthKit: HealthKitSyncStateViewModel { viewModel.healthKit }

    /// Fixed product order: Blood pressure -> Sleep -> Workouts.
    private var metrics: [HealthKitSyncMetric] { HealthKitSyncAllRunner.metricOrder }

    var body: some View {
        Section("Apple Health") {
            Toggle(isOn: $viewModel.healthKit.consentGranted) {
                Text("Upload Apple Health data")
            }
            .disabled(viewModel.selfProfile == nil || healthKit.isBusy)
            .accessibilityIdentifier("healthkit.consentToggle")
            .onChange(of: viewModel.healthKit.consentGranted) { _, granted in
                if granted {
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
            }
        }

        Section {
            Button(healthKit.isSavingSettings ? "Saving..." : "Save changes") {
                Task {
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
            Text("Re-imports the last 90 days and removes FamilyStack items in that period that no longer exist in Apple Health.")
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
        HealthKitMetricCaption.text(
            metric: metric,
            enabled: healthKit.enabledMetrics.contains(metric),
            activeRun: healthKit.activeRun,
            localRunInProgress: healthKit.localRunInProgress,
            sessionError: healthKit.sessionErrors[metric],
            state: healthKit.metricState(for: metric)
        )
    }

    private func captionColor(for metric: HealthKitSyncMetric) -> Color {
        switch HealthKitMetricCaption.tone(
            metric: metric,
            enabled: healthKit.enabledMetrics.contains(metric),
            activeRun: healthKit.activeRun,
            localRunInProgress: healthKit.localRunInProgress,
            sessionError: healthKit.sessionErrors[metric],
            state: healthKit.metricState(for: metric)
        ) {
        case .secondary:
            return .secondary
        case .warning:
            return .orange
        case .error:
            return .red
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
        case .vitals: return "Blood pressure & heart rate"
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
