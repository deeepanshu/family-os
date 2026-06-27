import AuthenticationServices
import SwiftUI

struct SignInView: View {
    @ObservedObject var viewModel: HealthBootstrapViewModel
    @State private var showDeveloperSettings = false

    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(alignment: .leading, spacing: 30) {
                    VStack(alignment: .leading, spacing: 12) {
                        Text("Family OS")
                            .font(.largeTitle.bold())
                        Text("Track family health privately, starting with blood pressure and blood sugar.")
                            .font(.body)
                            .foregroundStyle(.secondary)
                    }
                    .padding(.top, 40)

                    VStack(spacing: 14) {
                        SignInWithAppleButton(.continue) { request in
                            viewModel.prepareAppleSignInRequest(request)
                        } onCompletion: { result in
                            Task { await viewModel.handleAppleSignInCompletion(result) }
                        }
                        .signInWithAppleButtonStyle(.black)
                        .frame(height: 52)
                        .clipShape(RoundedRectangle(cornerRadius: 8, style: .continuous))
                        .disabled(!viewModel.hasSupabaseConfiguration)
                    }

                    Spacer(minLength: 20)
                }
                .padding(24)
            }
            .background(Color(.systemGroupedBackground))
            #if DEBUG
            .toolbar {
                ToolbarItem(placement: .topBarTrailing) {
                    Button {
                        showDeveloperSettings = true
                    } label: {
                        Image(systemName: "gearshape")
                    }
                    .accessibilityLabel("Developer Settings")
                }
            }
            .sheet(isPresented: $showDeveloperSettings) {
                DeveloperSettingsView(viewModel: viewModel)
            }
            #endif
        }
    }
}
