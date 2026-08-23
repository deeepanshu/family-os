import SwiftUI
import UIKit

struct ContentView: View {
    @ObservedObject var viewModel: HealthBootstrapViewModel

    var body: some View {
        Group {
            if !viewModel.hasAccessToken {
                SignInView(viewModel: viewModel)
            } else if viewModel.startupError != nil {
                startupErrorView
            } else if viewModel.isStartingUp {
                courtyardSplash
            } else if viewModel.needsProfileSetup {
                SetUpProfileView(viewModel: viewModel)
            } else if viewModel.shouldShowInviteAccept {
                AcceptInviteView(viewModel: viewModel)
            } else {
                AppTabsView(viewModel: viewModel)
            }
        }
        .task {
            viewModel.retryPendingHealthKitQueueWipe()
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

    private var courtyardSplash: some View {
        ZStack {
            Color("LaunchBackground")
                .ignoresSafeArea()
            Image("LaunchMark")
                .resizable()
                .scaledToFit()
                .frame(width: 320, height: 320)
                .accessibilityLabel("FamilyStack")
        }
    }

    private var startupErrorView: some View {
        VStack(spacing: 16) {
            Image(systemName: "exclamationmark.triangle")
                .font(.largeTitle)
                .foregroundStyle(.orange)
            Text("Could not start FamilyStack")
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

struct AcceptInviteView: View {
    @ObservedObject var viewModel: HealthBootstrapViewModel
    @State private var selectedLabel = CreatorRelationshipLabel.father
    @State private var isSubmitting = false

    var body: some View {
        NavigationStack {
            Form {
                Section("Join family") {
                    if let preview = viewModel.pendingInvitePreview {
                        Text("\(preview.creatorDisplayName) invited you to \(preview.familyName).")
                        Picker("\(preview.creatorDisplayName) is my", selection: $selectedLabel) {
                            ForEach(CreatorRelationshipLabel.allCases) { label in
                                Text(label.rawValue).tag(label)
                            }
                        }
                    } else {
                        Text("Loading invite…")
                    }
                    Text("Joining lets every member see everything you have already synced, including history, and everything you sync later.")
                        .font(.footnote)
                        .foregroundStyle(.secondary)
                }
                Button("Save") {
                    isSubmitting = true
                    Task {
                        await viewModel.acceptInvite(relationshipLabel: selectedLabel)
                        isSubmitting = false
                    }
                }
                .disabled(isSubmitting || viewModel.pendingInvitePreview == nil)
            }
            .navigationTitle("Join family")
            .task {
                await viewModel.loadPendingInvitePreview()
            }
        }
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
