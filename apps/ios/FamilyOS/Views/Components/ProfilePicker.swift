import SwiftUI

struct ProfilePicker: View {
    @ObservedObject var viewModel: HealthBootstrapViewModel

    var body: some View {
        if viewModel.profiles.profiles.isEmpty {
            Text("Create a profile first.")
                .foregroundStyle(.secondary)
        } else {
            Picker("Profile", selection: $viewModel.profiles.selectedProfileId) {
                Text("Choose profile").tag("")
                ForEach(viewModel.profiles.profiles) { profile in
                    Text(profile.displayName).tag(profile.id)
                }
            }
        }
    }
}
