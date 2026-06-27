import AuthenticationServices
import SwiftUI

struct ContentView: View {
    @ObservedObject var viewModel: HealthBootstrapViewModel

    var body: some View {
        if viewModel.hasAccessToken {
            AppTabsView(viewModel: viewModel)
        } else {
            SignInView(viewModel: viewModel)
        }
    }
}

private struct SignInView: View {
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

                        if !viewModel.hasSupabaseConfiguration {
                            Text("Sign in will be available after app configuration is set.")
                                .font(.footnote)
                                .foregroundStyle(.secondary)
                                .frame(maxWidth: .infinity, alignment: .leading)
                        }
                    }

                    StatusText(viewModel: viewModel)
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

#if DEBUG
private struct DeveloperSettingsView: View {
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

private struct AppTabsView: View {
    @ObservedObject var viewModel: HealthBootstrapViewModel

    var body: some View {
        TabView {
            HomeView(viewModel: viewModel)
                .tabItem { Label("Home", systemImage: "house") }

            ProfileView(viewModel: viewModel)
                .tabItem { Label("Profile", systemImage: "person.crop.circle") }

            HistoryView(viewModel: viewModel)
                .tabItem { Label("History", systemImage: "clock") }

            FamilyView(viewModel: viewModel)
                .tabItem { Label("Family", systemImage: "person.3") }
        }
    }
}

private struct HomeView: View {
    @ObservedObject var viewModel: HealthBootstrapViewModel
    @State private var activeLog: LogKind?

    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(alignment: .leading, spacing: 24) {
                    VStack(alignment: .leading, spacing: 8) {
                        Text("Today")
                            .font(.largeTitle.bold())
                        Text(homeSubtitle)
                            .foregroundStyle(.secondary)
                    }

                    VStack(spacing: 14) {
                        PrimaryActionButton(
                            title: "Record BP",
                            subtitle: "Blood pressure and pulse",
                            systemImage: "heart.text.square.fill",
                            tint: .red
                        ) {
                            activeLog = .bloodPressure
                        }

                        PrimaryActionButton(
                            title: "Record Diabetes",
                            subtitle: "Blood sugar reading",
                            systemImage: "drop.fill",
                            tint: .blue
                        ) {
                            activeLog = .bloodSugar
                        }
                    }

                    LatestReadingsSummary(viewModel: viewModel)
                    StatusText(viewModel: viewModel)
                }
                .padding()
            }
            .background(Color(.systemGroupedBackground))
            .navigationTitle("Home")
            .task {
                await viewModel.loadCurrentFamily()
                await viewModel.loadProfiles()
            }
            .sheet(item: $activeLog) { kind in
                LogReadingSheet(kind: kind, viewModel: viewModel)
            }
        }
    }

    private var homeSubtitle: String {
        if let profile = viewModel.selectedProfile {
            return "Logging for \(profile.displayName)"
        }
        if viewModel.profiles.profiles.isEmpty {
            return "Create a profile before recording readings."
        }
        return "Choose a profile before recording readings."
    }
}

private struct ProfileView: View {
    @ObservedObject var viewModel: HealthBootstrapViewModel

    var body: some View {
        NavigationStack {
            Form {
                Section("Current Profile") {
                    ProfilePicker(viewModel: viewModel)
                    if let selected = viewModel.selectedProfile {
                        LabeledContent("Name", value: selected.displayName)
                        if let relationship = selected.relationshipLabel {
                            LabeledContent("Relationship", value: relationship)
                        }
                    } else {
                        Text("Create or choose the health profile you usually record for.")
                            .foregroundStyle(.secondary)
                    }
                }

                Section("Create Profile") {
                    TextField("Name", text: $viewModel.profiles.profileName)
                    TextField("Relationship", text: $viewModel.profiles.profileRelationship)
                    Button("Save Profile") {
                        Task { await viewModel.createProfile() }
                    }
                }

                Section("Account") {
                    LabeledContent("Signed in", value: viewModel.signedInSummary)
                    Button("Sign Out", role: .destructive) {
                        viewModel.signOut()
                    }
                }

                Section("Status") {
                    StatusText(viewModel: viewModel)
                }
            }
            .navigationTitle("Profile")
            .task {
                await viewModel.loadProfiles()
            }
        }
    }
}

private struct HistoryView: View {
    @ObservedObject var viewModel: HealthBootstrapViewModel

    var body: some View {
        NavigationStack {
            List {
                Section {
                    ProfilePicker(viewModel: viewModel)
                    Button("Refresh") {
                        Task { await refreshHistory() }
                    }
                }

                Section("Blood Pressure") {
                    if viewModel.readings.bloodPressureReadings.isEmpty {
                        EmptyRow("No blood pressure readings yet.")
                    } else {
                        ForEach(viewModel.readings.bloodPressureReadings) { reading in
                            ReadingRow(
                                title: "\(reading.systolic)/\(reading.diastolic) mmHg",
                                detail: reading.pulse.map { "Pulse \($0)" } ?? "Pulse not recorded"
                            )
                        }
                    }
                }

                Section("Diabetes") {
                    if viewModel.readings.bloodGlucoseReadings.isEmpty {
                        EmptyRow("No blood sugar readings yet.")
                    } else {
                        ForEach(viewModel.readings.bloodGlucoseReadings) { reading in
                            ReadingRow(
                                title: "\(String(format: "%.0f", reading.value)) mg/dL",
                                detail: reading.context.replacingOccurrences(of: "_", with: " ").capitalized
                            )
                        }
                    }
                }
            }
            .navigationTitle("History")
            .task {
                await viewModel.loadProfiles()
                await refreshHistory()
            }
        }
    }

    private func refreshHistory() async {
        guard viewModel.hasSelectedProfile else { return }
        await viewModel.loadBloodPressure()
        await viewModel.loadBloodGlucose()
    }
}

private struct FamilyView: View {
    @ObservedObject var viewModel: HealthBootstrapViewModel

    var body: some View {
        NavigationStack {
            List {
                Section("Family") {
                    if let familyName = viewModel.family.currentFamilyName {
                        LabeledContent("Name", value: familyName)
                        LabeledContent("Your role", value: viewModel.family.currentFamilyRole ?? "Member")
                    } else {
                        TextField("Family name", text: $viewModel.family.familyName)
                        Button("Create Family") {
                            Task { await viewModel.createFamily() }
                        }
                    }
                }

                Section("Invites") {
                    Button("Create Invite") {
                        Task { await viewModel.createInvite() }
                    }
                    if let token = viewModel.family.lastCreatedInviteToken {
                        Text(token)
                            .font(.footnote.monospaced())
                            .textSelection(.enabled)
                    }

                    TextField("Invite token", text: $viewModel.family.inviteToken)
                        .textInputAutocapitalization(.never)
                    Button("Join Family") {
                        Task { await viewModel.acceptInvite() }
                    }
                }

                Section("Family Profiles") {
                    if viewModel.profiles.profiles.isEmpty {
                        EmptyRow("No profiles yet.")
                    } else {
                        ForEach(viewModel.profiles.profiles) { profile in
                            Button {
                                viewModel.profiles.selectedProfileId = profile.id
                            } label: {
                                HStack {
                                    ProfileRow(profile: profile)
                                    Spacer()
                                    if viewModel.profiles.selectedProfileId == profile.id {
                                        Image(systemName: "checkmark.circle.fill")
                                            .foregroundStyle(.blue)
                                    }
                                }
                            }
                            .buttonStyle(.plain)
                        }
                    }
                }

                Section("Connection") {
                    Button("Refresh Family") {
                        Task {
                            await viewModel.loadCurrentFamily()
                            await viewModel.loadProfiles()
                        }
                    }
                    StatusText(viewModel: viewModel)
                }
            }
            .navigationTitle("Family")
            .task {
                await viewModel.loadCurrentFamily()
                await viewModel.loadProfiles()
            }
        }
    }
}

private struct LogReadingSheet: View {
    let kind: LogKind
    @ObservedObject var viewModel: HealthBootstrapViewModel
    @Environment(\.dismiss) private var dismiss

    var body: some View {
        NavigationStack {
            Form {
                Section("Profile") {
                    ProfilePicker(viewModel: viewModel)
                }

                switch kind {
                case .bloodPressure:
                    Section("Blood Pressure") {
                        TextField("Systolic", text: $viewModel.readings.systolic)
                            .keyboardType(.numberPad)
                        TextField("Diastolic", text: $viewModel.readings.diastolic)
                            .keyboardType(.numberPad)
                        TextField("Pulse (optional)", text: $viewModel.readings.pulse)
                            .keyboardType(.numberPad)
                    }
                case .bloodSugar:
                    Section("Diabetes") {
                        TextField("Blood sugar mg/dL", text: $viewModel.readings.glucoseValue)
                            .keyboardType(.decimalPad)
                        Picker("Context", selection: $viewModel.readings.glucoseContext) {
                            Text("Fasting").tag("fasting")
                            Text("Before meal").tag("before_meal")
                            Text("After meal").tag("after_meal")
                            Text("Bedtime").tag("bedtime")
                            Text("Random").tag("random")
                        }
                    }
                }

                Section("Status") {
                    StatusText(viewModel: viewModel)
                }
            }
            .navigationTitle(kind.title)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Cancel") { dismiss() }
                }
                ToolbarItem(placement: .confirmationAction) {
                    Button("Save") {
                        Task {
                            switch kind {
                            case .bloodPressure:
                                await viewModel.createBloodPressure()
                            case .bloodSugar:
                                await viewModel.createBloodGlucose()
                            }
                            if !viewModel.isError {
                                dismiss()
                            }
                        }
                    }
                }
            }
        }
    }
}

private enum LogKind: Identifiable {
    case bloodPressure
    case bloodSugar

    var id: String {
        switch self {
        case .bloodPressure:
            return "blood-pressure"
        case .bloodSugar:
            return "blood-sugar"
        }
    }

    var title: String {
        switch self {
        case .bloodPressure:
            return "Record BP"
        case .bloodSugar:
            return "Record Diabetes"
        }
    }
}

private struct LatestReadingsSummary: View {
    @ObservedObject var viewModel: HealthBootstrapViewModel

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            Text("Latest")
                .font(.headline)

            HStack(spacing: 12) {
                MetricTile(
                    title: "BP",
                    value: viewModel.readings.bloodPressureReadings.first.map { "\($0.systolic)/\($0.diastolic)" } ?? "--",
                    detail: "mmHg"
                )
                MetricTile(
                    title: "Diabetes",
                    value: viewModel.readings.bloodGlucoseReadings.first.map { String(format: "%.0f", $0.value) } ?? "--",
                    detail: "mg/dL"
                )
            }
        }
    }
}

private struct PrimaryActionButton: View {
    let title: String
    let subtitle: String
    let systemImage: String
    let tint: Color
    let action: () -> Void

    var body: some View {
        Button(action: action) {
            HStack(spacing: 14) {
                Image(systemName: systemImage)
                    .font(.title2)
                    .foregroundStyle(.white)
                    .frame(width: 46, height: 46)
                    .background(tint)
                    .clipShape(RoundedRectangle(cornerRadius: 8, style: .continuous))

                VStack(alignment: .leading, spacing: 3) {
                    Text(title)
                        .font(.headline)
                        .foregroundStyle(.primary)
                    Text(subtitle)
                        .font(.subheadline)
                        .foregroundStyle(.secondary)
                }

                Spacer()
                Image(systemName: "chevron.right")
                    .font(.footnote.weight(.semibold))
                    .foregroundStyle(.tertiary)
            }
            .padding()
            .background(Color(.secondarySystemGroupedBackground))
            .clipShape(RoundedRectangle(cornerRadius: 8, style: .continuous))
        }
        .buttonStyle(.plain)
    }
}

private struct ProfilePicker: View {
    @ObservedObject var viewModel: HealthBootstrapViewModel

    var body: some View {
        if viewModel.profiles.profiles.isEmpty {
            Text("Create a profile first.")
                .foregroundStyle(.secondary)
        } else {
            Picker("Profile", selection: $viewModel.profiles.selectedProfileId) {
                Text("Choose profile").tag("")
                ForEach(viewModel.profiles.profiles) { profile in
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
            Text(profile.relationshipLabel ?? "Family member")
                .font(.footnote)
                .foregroundStyle(.secondary)
        }
    }
}

private struct ReadingRow: View {
    let title: String
    let detail: String

    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            Text(title)
                .font(.headline)
            Text(detail)
                .font(.subheadline)
                .foregroundStyle(.secondary)
        }
        .padding(.vertical, 4)
    }
}

private struct EmptyRow: View {
    let text: String

    init(_ text: String) {
        self.text = text
    }

    var body: some View {
        Text(text)
            .foregroundStyle(.secondary)
    }
}

private struct MetricTile: View {
    let title: String
    let value: String
    let detail: String

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            Text(title)
                .font(.footnote.weight(.semibold))
                .foregroundStyle(.secondary)
            Text(value)
                .font(.title2.bold())
            Text(detail)
                .font(.footnote)
                .foregroundStyle(.secondary)
        }
        .padding()
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(Color(.secondarySystemGroupedBackground))
        .clipShape(RoundedRectangle(cornerRadius: 8, style: .continuous))
    }
}

private struct StatusText: View {
    @ObservedObject var viewModel: HealthBootstrapViewModel

    var body: some View {
        Text(viewModel.statusMessage)
            .font(.footnote)
            .foregroundStyle(viewModel.isError ? .red : .secondary)
            .frame(maxWidth: .infinity, alignment: .leading)
    }
}

#Preview {
    ContentView(viewModel: HealthBootstrapViewModel())
}
