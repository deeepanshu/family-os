import SwiftUI

struct ProfileView: View {
    @ObservedObject var viewModel: HealthBootstrapViewModel
    @State private var confirmDeleteAccount = false

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

                Section("Legal") {
                    Link("Privacy Policy", destination: legalURL("/privacy"))
                    Link("Terms of Use", destination: legalURL("/terms"))
                    Link("Account deletion", destination: legalURL("/account-deletion"))
                }

                Section {
                    Button("Sign Out", role: .destructive) {
                        viewModel.signOut()
                    }
                    .disabled(viewModel.isDeletingAccount)
                }

                Section {
                    if viewModel.isDeletingAccount {
                        HStack {
                            ProgressView()
                            Text("Deleting account…")
                                .foregroundStyle(.secondary)
                        }
                    } else {
                        Button("Delete account", role: .destructive) {
                            confirmDeleteAccount = true
                        }
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
            .confirmationDialog("Delete account?", isPresented: $confirmDeleteAccount, titleVisibility: .visible) {
                Button("Delete account", role: .destructive) {
                    Task { await viewModel.deleteAccount() }
                }
            } message: {
                Text("This permanently deletes your FamilyStack account and the health data stored on our servers. Apple Health on this iPhone is not removed. This cannot be undone.")
            }
            .task {
                await viewModel.loadHealthKitStatus()
            }
        }
    }

    private func legalURL(_ path: String) -> URL {
        FamilyOSPublicSite.url(path: path, apiBaseURL: viewModel.connection.baseURL)
    }
}
