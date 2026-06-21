import SwiftUI

@main
struct FamilyOSApp: App {
    @StateObject private var viewModel = HealthBootstrapViewModel()

    var body: some Scene {
        WindowGroup {
            ContentView(viewModel: viewModel)
        }
    }
}
