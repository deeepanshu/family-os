import SwiftUI

struct ProfileView: View {
    @ObservedObject var viewModel: HealthBootstrapViewModel

    var body: some View {
        NavigationStack {
            Form {
                Section("Current Profile") {
                    ProfilePicker(viewModel: viewModel)
                    if let selected = viewModel.selectedProfile {
                        LabeledContent("Name", value: selected.displayName)
                        if let relationship = selected.relationshipLabel {
                            LabeledContent("Relationship", value: relationship)
                        }
                    } else {
                        Text("Create or choose the health profile you usually record for.")
                            .foregroundStyle(.secondary)
                    }
                }

                Section("Create Profile") {
                    TextField("Name", text: $viewModel.profiles.profileName)
                    TextField("Relationship", text: $viewModel.profiles.profileRelationship)
                    Button("Save Profile") {
                        Task { await viewModel.createProfile() }
                    }
                }

                Section("Account") {
                    LabeledContent("Signed in", value: viewModel.signedInSummary)
                    Button("Sign Out", role: .destructive) {
                        viewModel.signOut()
                    }
                }

                Section("Status") {
                    StatusText(viewModel: viewModel)
                }
            }
            .navigationTitle("Profile")
            .task {
                await viewModel.loadProfiles()
            }
        }
    }
}
