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

                Section("Family") {
                    if let familyName = viewModel.currentFamilyName {
                        LabeledContent("Current family", value: familyName)
                        LabeledContent("Role", value: viewModel.currentFamilyRole ?? "unknown")
                        Button("Create Member Invite") {
                            Task { await viewModel.createInvite() }
                        }
                        if let token = viewModel.lastCreatedInviteToken {
                            Text(token)
                                .font(.footnote.monospaced())
                                .textSelection(.enabled)
                        }
                    } else {
                        TextField("Family name", text: $viewModel.familyName)
                        Button("Create Family") {
                            Task { await viewModel.createFamily() }
                        }
                        TextField("Invite token", text: $viewModel.inviteToken)
                            .textInputAutocapitalization(.never)
                        Button("Accept Invite") {
                            Task { await viewModel.acceptInvite() }
                        }
                    }
                    Button("Load Current Family") {
                        Task { await viewModel.loadCurrentFamily() }
                    }
                }

                Section("Health Profiles") {
                    if viewModel.currentFamilyName == nil {
                        Text("Create or join a family before managing profiles.")
                            .foregroundStyle(.secondary)
                    } else {
                        TextField("Profile name", text: $viewModel.profileName)
                        TextField("Relationship", text: $viewModel.profileRelationship)
                        Button("Create Profile") {
                            Task { await viewModel.createProfile() }
                        }
                        Button("Load Profiles") {
                            Task { await viewModel.loadProfiles() }
                        }
                        ForEach(viewModel.profiles) { profile in
                            VStack(alignment: .leading) {
                                Text(profile.displayName)
                                if let relationship = profile.relationshipLabel {
                                    Text(relationship)
                                        .font(.footnote)
                                        .foregroundStyle(.secondary)
                                }
                            }
                        }
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
