import SwiftUI

struct ProfileView: View {
    @ObservedObject var viewModel: HealthBootstrapViewModel

    private var healthKit: HealthKitSyncStateViewModel { viewModel.healthKit }

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

                HealthKitSettingsSections(viewModel: viewModel)

                Section {
                    Button("Sign Out", role: .destructive) {
                        viewModel.signOut()
                    }
                }
            }
            .scrollContentBackground(.hidden)
            .background(Color(.systemGroupedBackground))
            .safeAreaInset(edge: .top, spacing: 0) {
                Text("Profile")
                    .font(.largeTitle.weight(.bold))
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .padding(.horizontal, 16)
                    .padding(.top, 8)
                    .padding(.bottom, 6)
                    .background(Color(.systemGroupedBackground))
            }
            .navigationBarTitleDisplayMode(.inline)
            .toolbar(.hidden, for: .navigationBar)
            .safeAreaInset(edge: .top, spacing: 0) {
                if let banner = healthKit.progressBanner {
                    HealthKitSyncProgressBanner(title: banner.title, detail: banner.detail)
                        .transition(.move(edge: .top).combined(with: .opacity))
                }
            }
            .animation(.easeInOut(duration: 0.2), value: healthKit.progressBanner)
            .task {
                await viewModel.loadHealthKitStatus()
            }
        }
    }
}
