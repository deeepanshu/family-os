import SwiftUI

struct HomeView: View {
    @ObservedObject var viewModel: HealthBootstrapViewModel
    @State private var activeLog: LogKind?

    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(alignment: .leading, spacing: 24) {
                    VStack(alignment: .leading, spacing: 8) {
                        Text("Today")
                            .font(.largeTitle.bold())
                        Text(homeSubtitle)
                            .foregroundStyle(.secondary)
                    }

                    VStack(spacing: 14) {
                        PrimaryActionButton(
                            title: "Record Blood Sugar",
                            subtitle: "Blood sugar reading",
                            systemImage: "drop.fill",
                            tint: .blue
                        ) {
                            activeLog = .bloodSugar
                        }
                    }

                    Text("Blood pressure is imported from Apple Health when HealthKit sync is enabled.")
                        .font(.footnote)
                        .foregroundStyle(.secondary)

                    LatestReadingsSummary(viewModel: viewModel)
                    StatusText(viewModel: viewModel)
                }
                .padding()
            }
            .background(Color(.systemGroupedBackground))
            .navigationTitle("Health")
            .task {
                await viewModel.loadCurrentFamily()
                await viewModel.loadProfiles()
            }
            .sheet(item: $activeLog) { kind in
                LogReadingSheet(kind: kind, viewModel: viewModel)
            }
        }
    }

    private var homeSubtitle: String {
        if let profile = viewModel.selectedProfile {
            return "Logging for \(profile.displayName)"
        }
        if viewModel.profiles.profiles.isEmpty {
            return "Create a profile before recording readings."
        }
        return "Choose a profile before recording readings."
    }
}
