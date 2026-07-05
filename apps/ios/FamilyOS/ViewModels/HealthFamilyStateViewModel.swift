import Foundation

@MainActor
final class HealthFamilyViewModel: ObservableObject {
    @Published var familyName = ""
    @Published var inviteToken = ""
    @Published var lastCreatedInviteToken: String?
    @Published var currentFamilyName: String?
    @Published var currentFamilyRole: FamilyRole?
    @Published var familyKind: FamilyKind?
    @Published var members: [FamilyMember] = []

    var isPersonalWorkspace: Bool {
        familyKind == .personal
    }

    var isManager: Bool {
        currentFamilyRole == .manager
    }

    func clear() {
        familyName = ""
        inviteToken = ""
        lastCreatedInviteToken = nil
        currentFamilyName = nil
        currentFamilyRole = nil
        familyKind = nil
        members = []
    }
}
