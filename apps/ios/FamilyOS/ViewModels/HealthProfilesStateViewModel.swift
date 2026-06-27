import Foundation

@MainActor
final class HealthProfilesViewModel: ObservableObject {
    @Published var profileName = ""
    @Published var profileRelationship = ""
    @Published var selectedProfileId = ""
    @Published var profiles: [HealthProfile] = []

    var selectedProfile: HealthProfile? {
        profiles.first { $0.id == selectedProfileId }
    }

    var hasSelectedProfile: Bool {
        !selectedProfileId.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
    }

    func clear() {
        profileName = ""
        profileRelationship = ""
        selectedProfileId = ""
        profiles = []
    }
}
