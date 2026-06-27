import Foundation

@MainActor
final class HealthFamilyViewModel: ObservableObject {
    @Published var familyName = ""
    @Published var inviteToken = ""
    @Published var lastCreatedInviteToken: String?
    @Published var currentFamilyName: String?
    @Published var currentFamilyRole: String?

    func clear() {
        familyName = ""
        inviteToken = ""
        lastCreatedInviteToken = nil
        currentFamilyName = nil
        currentFamilyRole = nil
    }
}
