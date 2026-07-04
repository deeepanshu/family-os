import SwiftUI

struct ProfileView: View {
    @ObservedObject var viewModel: HealthBootstrapViewModel

    var body: some View {
        NavigationStack {
            Form {
                Section("Your profile") {
                    if let selfProfile = viewModel.selfProfile {
                        LabeledContent("Name", value: selfProfile.displayName)
                        if let relationship = selfProfile.relationshipLabel {
                            LabeledContent("Relationship", value: relationship)
                        }
                    } else {
                        Text("Finish setting up your profile to record readings and sync HealthKit.")
                            .foregroundStyle(.secondary)
                    }
                }

                Section("Account") {
                    LabeledContent("Signed in", value: viewModel.signedInSummary)
                    Button("Sign Out", role: .destructive) {
                        viewModel.signOut()
                    }
                }

                HealthKitSyncView(viewModel: viewModel)

                Section("Status") {
                    StatusText(viewModel: viewModel)
                }
            }
            .navigationTitle("Profile")
            .task {
                await viewModel.loadHealthKitStatus()
            }
        }
    }
}
