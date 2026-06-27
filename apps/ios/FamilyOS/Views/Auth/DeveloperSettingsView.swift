import SwiftUI

#if DEBUG
struct DeveloperSettingsView: View {
    @ObservedObject var viewModel: HealthBootstrapViewModel
    @Environment(\.dismiss) private var dismiss

    var body: some View {
        NavigationStack {
            Form {
                Section("Connection") {
                    TextField("Supabase URL", text: $viewModel.connection.supabaseURL)
                        .textInputAutocapitalization(.never)
                        .keyboardType(.URL)
                    SecureField("Supabase anon key", text: $viewModel.connection.supabaseAnonKey)
                        .textInputAutocapitalization(.never)
                    TextField("API base URL", text: $viewModel.connection.baseURL)
                        .textInputAutocapitalization(.never)
                        .keyboardType(.URL)
                    Button("Save Connection") {
                        viewModel.saveConnectionSettings()
                    }
                }

                Section("Manual Token") {
                    SecureField("Supabase access token", text: $viewModel.auth.accessToken)
                        .textInputAutocapitalization(.never)
                    Button("Use Manual Token") {
                        viewModel.useManualAccessToken()
                    }
                }

                Section("Status") {
                    StatusText(viewModel: viewModel)
                }
            }
            .navigationTitle("Developer")
            .toolbar {
                ToolbarItem(placement: .confirmationAction) {
                    Button("Done") { dismiss() }
                }
            }
        }
    }
}
#endif
