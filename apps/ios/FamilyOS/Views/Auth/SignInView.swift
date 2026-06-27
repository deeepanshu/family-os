import AuthenticationServices
import SwiftUI

struct SignInView: View {
    @ObservedObject var viewModel: HealthBootstrapViewModel

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
                        if viewModel.usesLocalDevSignIn {
                            Button {
                                Task { await viewModel.useLocalDevToken() }
                            } label: {
                                Text("Continue")
                                    .font(.headline)
                                    .foregroundStyle(.white)
                                    .frame(maxWidth: .infinity)
                                    .frame(height: 52)
                                    .background(Color.black)
                                    .clipShape(RoundedRectangle(cornerRadius: 8, style: .continuous))
                            }
                            .buttonStyle(.plain)
                        } else {
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
                    }

                    Spacer(minLength: 20)
                }
                .padding(24)
            }
            .background(Color(.systemGroupedBackground))
        }
    }
}
