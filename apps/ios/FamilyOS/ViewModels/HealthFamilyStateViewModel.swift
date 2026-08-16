import Foundation

@MainActor
final class HealthFamilyViewModel: ObservableObject {
    @Published var familyName = ""
    @Published var inviteToken = ""
    @Published var lastCreatedInviteToken: String?
    @Published var lastCreatedInviteURL: String?
    @Published var currentFamilyName: String?
    @Published var currentFamilyRole: FamilyRole?
    @Published var familyKind: FamilyKind?
    @Published var createdByUserId: String?
    @Published var signedInUserId: String?
    @Published var creatorDisplayName: String?
    @Published var creatorRelationshipLabel: CreatorRelationshipLabel?
    @Published var members: [FamilyMember] = []

    var isPersonalWorkspace: Bool {
        familyKind == .personal
    }

    var isManager: Bool {
        currentFamilyRole == .manager
    }

    var isCreator: Bool {
        guard let createdByUserId, let signedInUserId else { return false }
        return createdByUserId == signedInUserId
    }

    var canManageFamily: Bool {
        currentFamilyName != nil && isCreator
    }

    var canLeaveFamily: Bool {
        currentFamilyName != nil && !isCreator
    }

    func clear() {
        familyName = ""
        inviteToken = ""
        lastCreatedInviteToken = nil
        lastCreatedInviteURL = nil
        currentFamilyName = nil
        currentFamilyRole = nil
        familyKind = nil
        createdByUserId = nil
        creatorDisplayName = nil
        creatorRelationshipLabel = nil
        members = []
    }
}
