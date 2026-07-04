import SwiftUI

struct ProfilePicker: View {
    @ObservedObject var viewModel: HealthBootstrapViewModel

    var body: some View {
        if viewModel.profiles.profiles.isEmpty {
            Text("Create a profile first.")
                .foregroundStyle(.secondary)
        } else if viewModel.profiles.profiles.count > 1 {
            Picker("Profile", selection: $viewModel.profiles.selectedProfileId) {
                Text("Choose profile").tag("")
                ForEach(viewModel.profiles.profiles) { profile in
                    Text(profile.displayName).tag(profile.id)
                }
            }
        } else if let profile = viewModel.profiles.profiles.first {
            LabeledContent("Profile", value: profile.displayName)
        }
    }
}
