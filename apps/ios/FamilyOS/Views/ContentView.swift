import SwiftUI

struct ContentView: View {
    @ObservedObject var viewModel: HealthBootstrapViewModel

    var body: some View {
        if viewModel.hasAccessToken {
            AppTabsView(viewModel: viewModel)
        } else {
            SignInView(viewModel: viewModel)
        }
    }
}

#Preview {
    ContentView(viewModel: HealthBootstrapViewModel())
}
