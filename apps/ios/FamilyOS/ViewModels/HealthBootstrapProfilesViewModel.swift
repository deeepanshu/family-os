import Foundation

extension HealthBootstrapViewModel {
    func loadProfiles() async {
        await request {
            profiles.profiles = try await client.listProfiles(baseURL: connection.baseURL, accessToken: auth.accessToken)
            return "Loaded \(profiles.profiles.count) health profiles."
        }
    }

    func createProfile() async {
        await request {
            let profile = try await client.createProfile(
                baseURL: connection.baseURL,
                accessToken: auth.accessToken,
                displayName: profiles.profileName.trimmingCharacters(in: .whitespacesAndNewlines),
                relationshipLabel: profiles.profileRelationship.trimmingCharacters(in: .whitespacesAndNewlines)
            )
            profiles.profiles.append(profile)
            profiles.selectedProfileId = profile.id
            profiles.profileName = ""
            profiles.profileRelationship = ""
            return "Created profile for \(profile.displayName)."
        }
    }
}
