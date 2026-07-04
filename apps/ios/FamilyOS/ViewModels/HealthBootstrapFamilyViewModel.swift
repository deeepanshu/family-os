import Foundation

extension HealthBootstrapViewModel {
    func loadCurrentFamily() async {
        await request {
            let response = try await client.currentFamily(baseURL: connection.baseURL, accessToken: auth.accessToken)
            family.currentFamilyName = response?.family.name
            family.familyKind = response?.family.kind
            family.currentFamilyRole = response?.membership.role
            guard let response else {
                return "No active family yet. Create one to continue."
            }
            return "Current family: \(response.family.name)."
        }
    }

    func createFamily() async {
        await request {
            let trimmedName = family.familyName.trimmingCharacters(in: .whitespacesAndNewlines)
            let response = try await client.createFamily(baseURL: connection.baseURL, accessToken: auth.accessToken, name: trimmedName)
            family.currentFamilyName = response.family.name
            family.familyKind = response.family.kind
            family.currentFamilyRole = response.membership.role
            return "Created \(response.family.name); you are \(response.membership.role.displayName)."
        }
    }

    func createInvite() async {
        await request {
            let response = try await client.createInvite(baseURL: connection.baseURL, accessToken: auth.accessToken)
            family.lastCreatedInviteToken = response.token
            return "Created invite token: \(response.token)"
        }
    }

    func acceptInvite() async {
        await request {
            let response = try await client.acceptInvite(
                baseURL: connection.baseURL,
                accessToken: auth.accessToken,
                token: family.inviteToken.trimmingCharacters(in: .whitespacesAndNewlines)
            )
            family.currentFamilyName = response.family.name
            family.familyKind = response.family.kind
            family.currentFamilyRole = response.membership.role
            return "Joined \(response.family.name) as \(response.membership.role.displayName)."
        }
    }

    func acceptInvite(token: String) async {
        await request {
            let response = try await client.acceptInvite(
                baseURL: connection.baseURL,
                accessToken: auth.accessToken,
                token: token
            )
            family.currentFamilyName = response.family.name
            family.familyKind = response.family.kind
            family.currentFamilyRole = response.membership.role
            return "Joined \(response.family.name) as \(response.membership.role.displayName)."
        }
    }
}
