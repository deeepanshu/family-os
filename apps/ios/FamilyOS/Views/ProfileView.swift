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

                HealthKitSyncView(viewModel: viewModel)

                Section {
                    Button("Sign Out", role: .destructive) {
                        viewModel.signOut()
                    }
                }
            }
            .navigationTitle("HealthKit Sync")
            .safeAreaInset(edge: .top, spacing: 0) {
                if let banner = viewModel.healthKit.progressBanner {
                    HealthKitSyncProgressBanner(title: banner.title, detail: banner.detail)
                        .transition(.move(edge: .top).combined(with: .opacity))
                }
            }
            .animation(.easeInOut(duration: 0.2), value: viewModel.healthKit.progressBanner)
            .task {
                await viewModel.loadHealthKitStatus()
            }
        }
    }
}

/// Always-visible run feedback. Complements the in-row stage caption and must
/// not replace it (plan §5.4).
private struct HealthKitSyncProgressBanner: View {
    let title: String
    let detail: String

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            ProgressView()
                .progressViewStyle(.linear)
            Text(title)
                .font(.subheadline.weight(.semibold))
            Text(detail)
                .font(.caption)
                .foregroundStyle(.secondary)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(.horizontal, 16)
        .padding(.vertical, 10)
        .background(.bar)
        .accessibilityElement(children: .combine)
        .accessibilityIdentifier("healthkit.syncProgress")
        .accessibilityLabel("\(title). \(detail)")
    }
}
