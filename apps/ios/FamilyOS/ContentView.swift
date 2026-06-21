import SwiftUI

struct ContentView: View {
    @ObservedObject var viewModel: HealthBootstrapViewModel

    var body: some View {
        NavigationStack {
            Form {
                Section("API") {
                    TextField("Base URL", text: $viewModel.baseURL)
                        .textInputAutocapitalization(.never)
                        .keyboardType(.URL)
                    Button("Check Health API") {
                        Task { await viewModel.checkHealth() }
                    }
                }

                Section("Authentication") {
                    Text("Sign in with Apple through Supabase is configured on the backend contract. Paste a Supabase access token for local API smoke tests.")
                        .font(.footnote)
                        .foregroundStyle(.secondary)
                    SecureField("Supabase access token", text: $viewModel.accessToken)
                        .textInputAutocapitalization(.never)
                    Button("Check Protected Session") {
                        Task { await viewModel.checkSession() }
                    }
                }

                Section("Status") {
                    Text(viewModel.statusMessage)
                        .foregroundStyle(viewModel.isError ? .red : .primary)
                }
            }
            .navigationTitle("Family OS Health")
        }
    }
}

#Preview {
    ContentView(viewModel: HealthBootstrapViewModel())
}
