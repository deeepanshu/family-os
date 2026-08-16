import SwiftUI

struct AppTabsView: View {
    @ObservedObject var viewModel: HealthBootstrapViewModel

    var body: some View {
        TabView {
            HealthKitSyncView(viewModel: viewModel)
                .tabItem { Label("Health Data", systemImage: "heart.fill") }

            HistoryView(viewModel: viewModel)
                .tabItem { Label("History", systemImage: "clock") }

            FamilyView(viewModel: viewModel)
                .tabItem { Label(viewModel.family.canManageFamily ? "Manage Family" : "Family", systemImage: "house") }

            ProfileView(viewModel: viewModel)
                .tabItem { Label("Profile", systemImage: "person.crop.circle") }
        }
    }
}
