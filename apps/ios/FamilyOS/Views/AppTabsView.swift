import SwiftUI

struct AppTabsView: View {
    @ObservedObject var viewModel: HealthBootstrapViewModel

    var body: some View {
        TabView {
            HistoryView(viewModel: viewModel)
                .tabItem { Label("Health", systemImage: "heart.fill") }

            FamilyView(viewModel: viewModel)
                .tabItem { Label(viewModel.family.canManageFamily ? "Manage Family" : "Family", systemImage: "house") }

            ProfileView(viewModel: viewModel)
                .tabItem { Label("Profile", systemImage: "person.crop.circle") }
        }
    }
}
