import SwiftUI

struct ProfileView: View {
    @ObservedObject var viewModel: HealthBootstrapViewModel

    var body: some View {
        NavigationStack {
            Form {
                Section("Your profile") {
                    if let selfProfile = viewModel.selfProfile {
                        LabeledContent("Name", value: selfProfile.displayName)
                    } else {
                        Text("Finish setting up your profile to record readings and sync HealthKit.")
                            .foregroundStyle(.secondary)
                    }
                }

                Section {
                    Button("Sign Out", role: .destructive) {
                        viewModel.signOut()
                    }
                }
            }
            .navigationTitle("Profile")
        }
    }
}
