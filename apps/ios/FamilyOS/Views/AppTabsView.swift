import SwiftUI

struct AppTabsView: View {
    @ObservedObject var viewModel: HealthBootstrapViewModel

    var body: some View {
        TabView {
            FamilyView(viewModel: viewModel)
                .tabItem { Label("Family", systemImage: "person.3") }

            ProfileView(viewModel: viewModel)
                .tabItem { Label("Profile", systemImage: "person.crop.circle") }
        }
    }
}
