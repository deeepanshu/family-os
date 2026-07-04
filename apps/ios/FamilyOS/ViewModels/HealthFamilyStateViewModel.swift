import Foundation

@MainActor
final class HealthFamilyViewModel: ObservableObject {
    @Published var familyName = ""
    @Published var inviteToken = ""
    @Published var lastCreatedInviteToken: String?
    @Published var currentFamilyName: String?
    @Published var currentFamilyRole: FamilyRole?
    @Published var familyKind: FamilyKind?

    var isPersonalWorkspace: Bool {
        familyKind == .personal
    }

    func clear() {
        familyName = ""
        inviteToken = ""
        lastCreatedInviteToken = nil
        currentFamilyName = nil
        currentFamilyRole = nil
        familyKind = nil
    }
}
