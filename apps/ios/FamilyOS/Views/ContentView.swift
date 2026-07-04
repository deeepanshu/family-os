import SwiftUI

struct ContentView: View {
    @ObservedObject var viewModel: HealthBootstrapViewModel

    var body: some View {
        Group {
            if !viewModel.hasAccessToken {
                SignInView(viewModel: viewModel)
            } else if viewModel.isStartingUp {
                startupLoadingView
            } else if viewModel.startupError != nil {
                startupErrorView
            } else if viewModel.needsProfileSetup {
                SetUpProfileView(viewModel: viewModel)
            } else {
                AppTabsView(viewModel: viewModel)
            }
        }
        .task {
            if viewModel.hasAccessToken {
                await viewModel.startup()
            }
        }
    }

    private var startupLoadingView: some View {
        VStack(spacing: 16) {
            ProgressView()
            Text("Starting Family OS...")
                .foregroundStyle(.secondary)
        }
    }

    private var startupErrorView: some View {
        VStack(spacing: 16) {
            Image(systemName: "exclamationmark.triangle")
                .font(.largeTitle)
                .foregroundStyle(.orange)
            Text("Could not start Family OS")
                .font(.headline)
            Text(viewModel.statusMessage)
                .foregroundStyle(.secondary)
                .multilineTextAlignment(.center)
            Button("Try Again") {
                Task { await viewModel.startup() }
            }
            .buttonStyle(.borderedProminent)
        }
        .padding()
    }
}

struct SetUpProfileView: View {
    @ObservedObject var viewModel: HealthBootstrapViewModel
    @State private var name = ""
    @State private var isSubmitting = false

    var body: some View {
        NavigationStack {
            Form {
                Section("Set up your profile") {
                    TextField("Name", text: $name)
                        .textContentType(.name)
                }

                Section {
                    Button {
                        Task {
                            isSubmitting = true
                            defer { isSubmitting = false }
                            await viewModel.createSelfProfile(displayName: name)
                        }
                    } label: {
                        HStack {
                            Spacer()
                            Text(isSubmitting ? "Saving..." : "Continue")
                            Spacer()
                        }
                    }
                    .disabled(name.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || isSubmitting)
                }
            }
            .navigationTitle("Set up your profile")
            .navigationBarTitleDisplayMode(.large)
        }
    }
}

#Preview {
    ContentView(viewModel: HealthBootstrapViewModel())
}
