import SwiftUI

struct FamilyView: View {
    @ObservedObject var viewModel: HealthBootstrapViewModel

    var body: some View {
        NavigationStack {
            List {
                if viewModel.family.currentFamilyName == nil {
                    createFamilySection
                } else if viewModel.family.canManageFamily {
                    manageFamilySection
                } else {
                    memberFamilySection
                }
            }
            .navigationTitle(viewModel.family.canManageFamily ? "Manage Family" : "Family")
            .task {
                await viewModel.loadCurrentFamily()
                await viewModel.loadProfiles()
                viewModel.restoreSelectedPersonOrSelf()
            }
        }
    }

    private var createFamilySection: some View {
        Section("Create a family") {
            Text("You can use Family OS alone. Create a household when you want to invite someone who has the app.")
                .foregroundStyle(.secondary)
            TextField("Family name", text: $viewModel.family.familyName)
            Button("Create Family") {
                Task { await viewModel.createFamily() }
            }
            .disabled(viewModel.family.familyName.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
        }
    }

    private var memberFamilySection: some View {
        Group {
            Section("Family") {
                if let familyName = viewModel.family.currentFamilyName {
                    LabeledContent("Name", value: familyName)
                }
                if let creator = viewModel.family.creatorDisplayName ?? creatorNameFromRoster,
                   let label = viewModel.family.creatorRelationshipLabel {
                    Text("\(creator) is my \(label)")
                }
            }
            rosterSection
            Section {
                Button("Leave family", role: .destructive) {
                    Task { await viewModel.leaveFamily() }
                }
            }
        }
    }

    private var manageFamilySection: some View {
        Group {
            Section("Family") {
                if let familyName = viewModel.family.currentFamilyName {
                    LabeledContent("Name", value: familyName)
                }
            }
            rosterSection
            Section("Invite") {
                Button("Create invite link") {
                    Task { await viewModel.createInvite() }
                }
                if let url = viewModel.family.lastCreatedInviteURL ?? viewModel.family.lastCreatedInviteToken {
                    Text(url)
                        .font(.footnote.monospaced())
                        .textSelection(.enabled)
                    Text("This link expires in one hour and works once.")
                        .font(.footnote)
                        .foregroundStyle(.secondary)
                }
            }
            if viewModel.family.members.count <= 1 {
                Section {
                    Button("Delete family", role: .destructive) {
                        Task { await viewModel.deleteFamily() }
                    }
                }
            }
        }
    }

    private var rosterSection: some View {
        Section("Members") {
            if viewModel.family.members.isEmpty {
                EmptyRow("No members yet.")
            } else {
                ForEach(viewModel.family.members) { member in
                    HStack {
                        Text(memberIdentity(member))
                        Spacer()
                        if viewModel.family.canManageFamily,
                           member.membership.userId != viewModel.auth.signedInUserId {
                            Button("Remove", role: .destructive) {
                                Task { await viewModel.removeMember(userId: member.membership.userId) }
                            }
                        }
                    }
                }
            }
        }
    }

    private var creatorNameFromRoster: String? {
        viewModel.family.members.first { $0.membership.userId == viewModel.family.createdByUserId }?.displayName
    }

    private func memberIdentity(_ member: FamilyMember) -> String {
        if let displayName = member.displayName, !displayName.isEmpty {
            return displayName
        }
        return "Member"
    }
}
