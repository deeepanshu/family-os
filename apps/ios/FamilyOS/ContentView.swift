import SwiftUI

struct ContentView: View {
    @ObservedObject var viewModel: HealthBootstrapViewModel

    var body: some View {
        TabView {
            DashboardView(viewModel: viewModel)
                .tabItem { Label("Home", systemImage: "heart.text.square") }

            LogHealthView(viewModel: viewModel)
                .tabItem { Label("Log", systemImage: "plus.circle") }

            HistoryView(viewModel: viewModel)
                .tabItem { Label("History", systemImage: "clock") }

            FamilyView(viewModel: viewModel)
                .tabItem { Label("Family", systemImage: "person.3") }

            SettingsView(viewModel: viewModel)
                .tabItem { Label("Settings", systemImage: "gearshape") }
        }
    }
}

private struct DashboardView: View {
    @ObservedObject var viewModel: HealthBootstrapViewModel

    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(alignment: .leading, spacing: 20) {
                    familySummary
                    profileSummary
                    latestReadings
                    statusCard
                }
                .padding()
            }
            .navigationTitle("Family OS Health")
        }
    }

    private var familySummary: some View {
        Card {
            VStack(alignment: .leading, spacing: 8) {
                Text(viewModel.currentFamilyName ?? "Set up your family")
                    .font(.title2.bold())
                Text(viewModel.currentFamilyRole.map { "Your role: \($0.capitalized)" } ?? "Create or join a family to start tracking health.")
                    .foregroundStyle(.secondary)
            }
        }
    }

    private var profileSummary: some View {
        Card {
            VStack(alignment: .leading, spacing: 12) {
                HStack {
                    Text("Profiles")
                        .font(.headline)
                    Spacer()
                    Text("\(viewModel.profiles.count)")
                        .foregroundStyle(.secondary)
                }

                if viewModel.profiles.isEmpty {
                    Text("No health profiles yet.")
                        .foregroundStyle(.secondary)
                } else {
                    ForEach(viewModel.profiles.prefix(3)) { profile in
                        ProfileRow(profile: profile)
                    }
                }
            }
        }
    }

    private var latestReadings: some View {
        HStack(spacing: 12) {
            MetricTile(
                title: "Blood Pressure",
                value: viewModel.bloodPressureReadings.first.map { "\($0.systolic)/\($0.diastolic)" } ?? "--",
                detail: "mmHg"
            )
            MetricTile(
                title: "Blood Sugar",
                value: viewModel.bloodGlucoseReadings.first.map { String(format: "%.0f", $0.value) } ?? "--",
                detail: "mg/dL"
            )
        }
    }

    private var statusCard: some View {
        Card {
            VStack(alignment: .leading, spacing: 8) {
                Text("Status")
                    .font(.headline)
                if let route = viewModel.notificationRouteMessage {
                    Text(route)
                        .foregroundStyle(.blue)
                }
                Text(viewModel.statusMessage)
                    .foregroundStyle(viewModel.isError ? .red : .secondary)
            }
        }
    }
}

private struct LogHealthView: View {
    @ObservedObject var viewModel: HealthBootstrapViewModel

    var body: some View {
        NavigationStack {
            Form {
                Section("Who is this for?") {
                    ProfilePicker(viewModel: viewModel)
                }

                Section("Blood Pressure") {
                    TextField("Systolic", text: $viewModel.systolic)
                        .keyboardType(.numberPad)
                    TextField("Diastolic", text: $viewModel.diastolic)
                        .keyboardType(.numberPad)
                    TextField("Pulse (optional)", text: $viewModel.pulse)
                        .keyboardType(.numberPad)
                    Button("Save Blood Pressure") {
                        Task { await viewModel.createBloodPressure() }
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
                    Button("Save Blood Sugar") {
                        Task { await viewModel.createBloodGlucose() }
                    }
                }
            }
            .navigationTitle("Log Health")
            .task {
                if viewModel.hasAccessToken {
                    await viewModel.loadProfiles()
                }
            }
        }
    }
}

private struct HistoryView: View {
    @ObservedObject var viewModel: HealthBootstrapViewModel

    var body: some View {
        NavigationStack {
            List {
                Section("Profile") {
                    ProfilePicker(viewModel: viewModel)
                    Button("Refresh History") {
                        Task {
                            await viewModel.loadBloodPressure()
                            await viewModel.loadBloodGlucose()
                        }
                    }
                }

                Section("Blood Pressure") {
                    if viewModel.bloodPressureReadings.isEmpty {
                        Text("No BP readings loaded.")
                            .foregroundStyle(.secondary)
                    } else {
                        ForEach(viewModel.bloodPressureReadings) { reading in
                            HStack {
                                Text("\(reading.systolic)/\(reading.diastolic)")
                                    .font(.headline)
                                Spacer()
                                Text(reading.pulse.map { "Pulse \($0)" } ?? "No pulse")
                                    .foregroundStyle(.secondary)
                            }
                        }
                    }
                }

                Section("Blood Sugar") {
                    if viewModel.bloodGlucoseReadings.isEmpty {
                        Text("No sugar readings loaded.")
                            .foregroundStyle(.secondary)
                    } else {
                        ForEach(viewModel.bloodGlucoseReadings) { reading in
                            HStack {
                                Text("\(reading.value, specifier: "%.0f") mg/dL")
                                    .font(.headline)
                                Spacer()
                                Text(reading.context.replacingOccurrences(of: "_", with: " ").capitalized)
                                    .foregroundStyle(.secondary)
                            }
                        }
                    }
                }
            }
            .navigationTitle("History")
            .task {
                if viewModel.hasAccessToken {
                    await viewModel.loadProfiles()
                }
            }
        }
    }
}

private struct FamilyView: View {
    @ObservedObject var viewModel: HealthBootstrapViewModel

    var body: some View {
        NavigationStack {
            List {
                Section("Family") {
                    if let familyName = viewModel.currentFamilyName {
                        LabeledContent("Current family", value: familyName)
                        LabeledContent("Role", value: viewModel.currentFamilyRole ?? "unknown")
                        Button("Create Invite") {
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

                    Button("Refresh Family") {
                        Task { await viewModel.loadCurrentFamily() }
                    }
                }

                Section("Health Profiles") {
                    TextField("Name", text: $viewModel.profileName)
                    TextField("Relationship", text: $viewModel.profileRelationship)
                    Button("Add Profile") {
                        Task { await viewModel.createProfile() }
                    }
                    Button("Refresh Profiles") {
                        Task { await viewModel.loadProfiles() }
                    }

                    ForEach(viewModel.profiles) { profile in
                        Button {
                            viewModel.selectedProfileId = profile.id
                        } label: {
                            HStack {
                                ProfileRow(profile: profile)
                                Spacer()
                                if viewModel.selectedProfileId == profile.id {
                                    Image(systemName: "checkmark.circle.fill")
                                        .foregroundStyle(.blue)
                                }
                            }
                        }
                        .buttonStyle(.plain)
                    }
                }
            }
            .navigationTitle("Family")
            .task {
                if viewModel.hasAccessToken {
                    await viewModel.loadCurrentFamily()
                    await viewModel.loadProfiles()
                }
            }
        }
    }
}

private struct SettingsView: View {
    @ObservedObject var viewModel: HealthBootstrapViewModel

    var body: some View {
        NavigationStack {
            Form {
                Section("Connection") {
                    TextField("API base URL", text: $viewModel.baseURL)
                        .textInputAutocapitalization(.never)
                        .keyboardType(.URL)
                    Button("Check API") {
                        Task { await viewModel.checkHealth() }
                    }
                }

                Section("Local Development Auth") {
                    SecureField("Supabase access token", text: $viewModel.accessToken)
                        .textInputAutocapitalization(.never)
                    Button("Check Session") {
                        Task { await viewModel.checkSession() }
                    }
                }

                Section("Status") {
                    Text(viewModel.statusMessage)
                        .foregroundStyle(viewModel.isError ? .red : .secondary)
                }
            }
            .navigationTitle("Settings")
        }
    }
}

private struct ProfilePicker: View {
    @ObservedObject var viewModel: HealthBootstrapViewModel

    var body: some View {
        if viewModel.profiles.isEmpty {
            Text("Add a profile from the Family tab first.")
                .foregroundStyle(.secondary)
        } else {
            Picker("Profile", selection: $viewModel.selectedProfileId) {
                Text("Choose profile").tag("")
                ForEach(viewModel.profiles) { profile in
                    Text(profile.displayName).tag(profile.id)
                }
            }
        }
    }
}

private struct ProfileRow: View {
    let profile: HealthProfile

    var body: some View {
        VStack(alignment: .leading, spacing: 3) {
            Text(profile.displayName)
                .font(.body.weight(.medium))
            if let relationship = profile.relationshipLabel {
                Text(relationship)
                    .font(.footnote)
                    .foregroundStyle(.secondary)
            }
        }
    }
}

private struct MetricTile: View {
    let title: String
    let value: String
    let detail: String

    var body: some View {
        Card {
            VStack(alignment: .leading, spacing: 10) {
                Text(title)
                    .font(.footnote.weight(.semibold))
                    .foregroundStyle(.secondary)
                Text(value)
                    .font(.title.bold())
                Text(detail)
                    .font(.footnote)
                    .foregroundStyle(.secondary)
            }
            .frame(maxWidth: .infinity, alignment: .leading)
        }
    }
}

private struct Card<Content: View>: View {
    @ViewBuilder let content: Content

    var body: some View {
        content
            .padding()
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(Color(.secondarySystemGroupedBackground))
            .clipShape(RoundedRectangle(cornerRadius: 8, style: .continuous))
    }
}

#Preview {
    ContentView(viewModel: HealthBootstrapViewModel())
}
