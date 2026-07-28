import SwiftUI
import UIKit

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
        .overlay(alignment: .bottom) {
            if let feedback = viewModel.actionFeedback, !feedback.isError {
                ActionFeedbackToast(message: feedback.message)
                    .padding(.horizontal, 20)
                    .padding(.bottom, 16)
                    .transition(.move(edge: .bottom).combined(with: .opacity))
            }
        }
        .animation(.easeInOut(duration: 0.2), value: viewModel.actionFeedback?.id)
        .alert("Action couldn't be completed", isPresented: actionFailurePresented) {
            Button("OK", role: .cancel) {
                viewModel.dismissActionFeedback()
            }
        } message: {
            Text(viewModel.actionFeedback?.message ?? "")
        }
        .onChange(of: viewModel.actionFeedback?.id) { _, id in
            guard let id, let feedback = viewModel.actionFeedback else { return }
            UINotificationFeedbackGenerator().notificationOccurred(feedback.isError ? .error : .success)
            guard !feedback.isError else { return }
            Task {
                try? await Task.sleep(nanoseconds: 3_000_000_000)
                guard viewModel.actionFeedback?.id == id else { return }
                viewModel.dismissActionFeedback()
            }
        }
    }

    private var actionFailurePresented: Binding<Bool> {
        Binding(
            get: { viewModel.actionFeedback?.isError == true },
            set: { isPresented in
                if !isPresented {
                    viewModel.dismissActionFeedback()
                }
            }
        )
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

private struct ActionFeedbackToast: View {
    let message: String

    var body: some View {
        HStack(spacing: 8) {
            Image(systemName: "checkmark.circle.fill")
                .foregroundStyle(.green)
            Text(message)
                .font(.footnote)
                .multilineTextAlignment(.leading)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(12)
        .background(.regularMaterial)
        .clipShape(RoundedRectangle(cornerRadius: 8))
        .shadow(color: .black.opacity(0.12), radius: 8, y: 3)
        .accessibilityElement(children: .combine)
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
