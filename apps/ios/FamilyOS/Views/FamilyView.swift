import SwiftUI

struct FamilyView: View {
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
