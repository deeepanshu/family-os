import SwiftUI

struct AppTabsView: View {
    @ObservedObject var viewModel: HealthBootstrapViewModel

    var body: some View {
        TabView {
            HealthKitSyncView(viewModel: viewModel)
                .tabItem { Label("Health Data", systemImage: "heart.fill") }

            ProfileView(viewModel: viewModel)
                .tabItem { Label("Profile", systemImage: "person.crop.circle") }
        }
    }
}
