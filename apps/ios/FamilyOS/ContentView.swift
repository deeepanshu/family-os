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

                Section("Blood Pressure") {
                    TextField("Profile ID", text: $viewModel.selectedProfileId)
                        .textInputAutocapitalization(.never)
                    TextField("Systolic", text: $viewModel.systolic)
                        .keyboardType(.numberPad)
                    TextField("Diastolic", text: $viewModel.diastolic)
                        .keyboardType(.numberPad)
                    TextField("Pulse", text: $viewModel.pulse)
                        .keyboardType(.numberPad)
                    Button("Log Blood Pressure") {
                        Task { await viewModel.createBloodPressure() }
                    }
                    Button("Load BP History") {
                        Task { await viewModel.loadBloodPressure() }
                    }
                    ForEach(viewModel.bloodPressureReadings) { reading in
                        Text("\(reading.systolic)/\(reading.diastolic)")
                    }
                }

                Section("Blood Sugar") {
                    TextField("Glucose mg/dL", text: $viewModel.glucoseValue)
                        .keyboardType(.decimalPad)
                    Picker("Context", selection: $viewModel.glucoseContext) {
                        Text("Fasting").tag("fasting")
                        Text("Before meal").tag("before_meal")
                        Text("After meal").tag("after_meal")
                        Text("Bedtime").tag("bedtime")
                        Text("Random").tag("random")
                    }
                    Button("Log Blood Sugar") {
                        Task { await viewModel.createBloodGlucose() }
                    }
                    Button("Load Sugar History") {
                        Task { await viewModel.loadBloodGlucose() }
                    }
                    ForEach(viewModel.bloodGlucoseReadings) { reading in
                        Text("\(reading.value, specifier: "%.0f") mg/dL \(reading.context)")
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
