import SwiftUI

/// Temporary single-screen shell while nailing HealthKit BP sync.
/// Family tab and TabView are hidden; restore multi-tab layout later.
struct AppTabsView: View {
    @ObservedObject var viewModel: HealthBootstrapViewModel

    var body: some View {
        ProfileView(viewModel: viewModel)
    }
}
