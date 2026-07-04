import SwiftUI

struct HealthKitSyncView: View {
    @ObservedObject var viewModel: HealthBootstrapViewModel

    var body: some View {
        Section("HealthKit Sync") {
            LabeledContent("Availability", value: viewModel.healthKit.isAvailable ? "Available" : "Unavailable")

            if let linkedProfileId = viewModel.healthKit.linkedProfileId,
               let profile = viewModel.profiles.profiles.first(where: { $0.id == linkedProfileId }) {
                LabeledContent("Linked profile", value: profile.displayName)
            } else {
                Button("Link Selected Profile") {
                    Task { await viewModel.linkSelectedProfileForHealthKit() }
                }
                .disabled(!viewModel.hasSelectedProfile)
            }

            if viewModel.healthKit.enabledMetrics.isEmpty {
                Button("Enable HealthKit Categories") {
                    Task { await viewModel.enableDefaultHealthKitMetrics() }
                }
                .disabled(viewModel.healthKit.linkedProfileId == nil)
            } else {
                VStack(alignment: .leading, spacing: 6) {
                    Text("Enabled categories")
                        .font(.subheadline)
                        .foregroundStyle(.secondary)
                    Text(viewModel.healthKit.enabledMetrics.map(\.displayName).joined(separator: ", "))
                        .font(.body)
                }
            }

            Button(viewModel.healthKit.isSyncing ? "Syncing..." : "Sync HealthKit Now") {
                Task { await viewModel.syncHealthKitNow() }
            }
            .disabled(!viewModel.healthKit.isAvailable || viewModel.healthKit.linkedProfileId == nil || viewModel.healthKit.enabledMetrics.isEmpty || viewModel.healthKit.isSyncing)

            if let lastSync = viewModel.healthKit.status?.lastSync {
                LabeledContent("Last sync", value: "\(lastSync.importedCount) imported, \(lastSync.skippedCount) skipped")
            }

            ForEach(latestSummariesByMetric) { summary in
                LabeledContent(summary.metricType.displayName, value: formatted(summary))
            }
        }
    }

    private var latestSummariesByMetric: [HealthMetricDailySummary] {
        let latestByMetric = Dictionary(grouping: viewModel.healthKit.dailySummaries, by: \.metricType)
            .compactMapValues { summaries in
                summaries.max { lhs, rhs in
                    lhs.date < rhs.date
                }
            }

        return HealthKitMetricType.allCases.compactMap { latestByMetric[$0] }
    }

    private func formatted(_ summary: HealthMetricDailySummary) -> String {
        switch summary.metricType {
        case .sleep:
            let totalMinutes = Int(summary.value.rounded())
            let hours = totalMinutes / 60
            let minutes = totalMinutes % 60
            if hours > 0 && minutes > 0 {
                return "\(hours) hr \(minutes) min"
            }
            if hours > 0 {
                return "\(hours) hr"
            }
            return "\(minutes) min"
        case .steps:
            return "\(Int(summary.value.rounded()).formatted()) steps"
        case .walkingDistance:
            return "\(Int(summary.value.rounded()).formatted()) m"
        case .weight:
            return "\(String(format: "%.1f", summary.value)) \(summary.unit)"
        case .bloodPressure, .bloodGlucose:
            let value = summary.value.rounded() == summary.value ? String(Int(summary.value)) : String(format: "%.1f", summary.value)
            return "\(value) \(summary.unit)"
        }
    }
}
