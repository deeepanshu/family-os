import SwiftUI

struct FamilyView: View {
    @ObservedObject var viewModel: HealthBootstrapViewModel

    var body: some View {
        NavigationStack {
            List {
                if viewModel.family.isPersonalWorkspace {
                    personalWorkspaceSection
                } else {
                    familyWorkspaceSection
                }

                Section("Health Profiles") {
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

                if viewModel.family.isManager {
                    Section("Add another health profile") {
                        TextField("Name", text: $viewModel.profiles.profileName)
                        TextField("Relationship", text: $viewModel.profiles.profileRelationship)
                        Button("Save Profile") {
                            Task { await viewModel.createProfile() }
                        }
                        .disabled(viewModel.profiles.profileName.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
                    }

                    Section("Invite family") {
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

    private var personalWorkspaceSection: some View {
        Section("Family") {
            Text("You are using Family OS for yourself")
                .foregroundStyle(.secondary)
            if let familyName = viewModel.family.currentFamilyName {
                LabeledContent("Workspace", value: familyName)
            }
        }
    }

    private func memberIdentity(_ member: FamilyMember) -> String {
        if let displayName = member.displayName, !displayName.isEmpty {
            return displayName
        }
        if let email = member.email, !email.isEmpty {
            return email
        }
        return "Member"
    }

    private var familyWorkspaceSection: some View {
        Group {
            Section("Family") {
                if let familyName = viewModel.family.currentFamilyName {
                    LabeledContent("Name", value: familyName)
                    LabeledContent("Your role", value: viewModel.family.currentFamilyRole?.displayName ?? "Member")
                } else {
                    TextField("Family name", text: $viewModel.family.familyName)
                    Button("Create Family") {
                        Task { await viewModel.createFamily() }
                    }
                }
            }

                Section("Members") {
                    if viewModel.family.members.isEmpty {
                        EmptyRow("No members yet.")
                    } else {
                        ForEach(viewModel.family.members) { member in
                            HStack {
                                Text(memberIdentity(member))
                                Spacer()
                                Text(member.membership.role.displayName)
                                    .foregroundStyle(.secondary)
                            }
                        }
                    }
                }
        }
    }
}
