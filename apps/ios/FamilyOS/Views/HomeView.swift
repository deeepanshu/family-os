import SwiftUI

struct HomeView: View {
    @ObservedObject var viewModel: HealthBootstrapViewModel

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

                    Text("Health readings are imported from Apple Health when HealthKit sync is enabled.")
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
        }
    }

    private var homeSubtitle: String {
        if let profile = viewModel.selectedProfile {
            return "Viewing \(profile.displayName)"
        }
        if viewModel.profiles.profiles.isEmpty {
            return "Create a profile before syncing HealthKit."
        }
        return "Choose a profile before viewing readings."
    }
}
