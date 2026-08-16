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
                    NavigationLink {
                        HealthKitSyncView(viewModel: viewModel)
                    } label: {
                        Text("Health Data")
                    }
                    .accessibilityIdentifier("profile.healthData")
                }

                Section {
                    Button("Sign Out", role: .destructive) {
                        viewModel.signOut()
                    }
                }
            }
            .navigationTitle("Profile")
            .safeAreaInset(edge: .top, spacing: 0) {
                if let banner = viewModel.healthKit.progressBanner {
                    HealthKitSyncProgressBanner(title: banner.title, detail: banner.detail)
                        .transition(.move(edge: .top).combined(with: .opacity))
                }
            }
            .animation(.easeInOut(duration: 0.2), value: viewModel.healthKit.progressBanner)
        }
    }
}
