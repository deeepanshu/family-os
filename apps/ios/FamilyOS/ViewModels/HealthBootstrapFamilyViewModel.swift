import Foundation

extension HealthBootstrapViewModel {
    func loadCurrentFamily() async {
        await request {
            let response = try await client.currentFamily(baseURL: connection.baseURL, accessToken: auth.accessToken)
            applyFamilyResponse(response)
            guard let response else {
                return "No active family yet. Create one to continue."
            }
            return "Current family: \(response.family.name)."
        }
        if family.currentFamilyName != nil {
            await loadMembers()
        }
        restoreSelectedPersonOrSelf()
    }

    private func applyFamilyResponse(_ response: FamilyResponse?) {
        family.signedInUserId = auth.signedInUserId
        family.currentFamilyName = response?.family.name
        family.familyKind = response?.family.kind
        family.currentFamilyRole = response?.membership.role
        family.createdByUserId = response?.family.createdByUserId
        family.creatorRelationshipLabel = response?.membership.creatorRelationshipLabel
    }

    func loadMembers() async {
        await request {
            let members = try await client.listMembers(baseURL: connection.baseURL, accessToken: auth.accessToken)
            family.members = members
            return "Loaded \(members.count) member(s)."
        }
    }

    func refreshFamilyAfterInvite() async {
        await loadCurrentFamily()
    }

    func refreshFamily() async {
        await loadCurrentFamily()
        guard !isError else {
            reportActionFailure(statusMessage)
            return
        }
        await loadProfiles()
        if isError {
            reportActionFailure(statusMessage)
        } else {
            reportActionResult("Family refreshed.")
        }
    }

    func createFamily() async {
        await request(showsFeedback: true) {
            let trimmedName = family.familyName.trimmingCharacters(in: .whitespacesAndNewlines)
            let response = try await client.createFamily(baseURL: connection.baseURL, accessToken: auth.accessToken, name: trimmedName)
            applyFamilyResponse(response)
            return "Created \(response.family.name)."
        }
    }

    func createInvite() async {
        await request(showsFeedback: true) {
            let response = try await client.createInvite(baseURL: connection.baseURL, accessToken: auth.accessToken)
            family.lastCreatedInviteToken = response.token
            family.lastCreatedInviteURL = response.url
            return "Invite link ready. It expires in one hour and works once."
        }
        if family.lastCreatedInviteToken != nil {
            await refreshFamilyAfterInvite()
        }
    }

    func acceptInvite(relationshipLabel: CreatorRelationshipLabel) async {
        await request(showsFeedback: true) {
            let token = pendingInviteToken ?? family.inviteToken.trimmingCharacters(in: .whitespacesAndNewlines)
            let response = try await client.acceptInvite(
                baseURL: connection.baseURL,
                accessToken: auth.accessToken,
                token: token,
                relationshipLabel: relationshipLabel
            )
            applyFamilyResponse(response)
            pendingInviteToken = nil
            pendingInvitePreview = nil
            return "Joined \(response.family.name)."
        }
        await refreshFamily()
    }

    func leaveFamily() async {
        await request(showsFeedback: true) {
            try await client.leaveFamily(baseURL: connection.baseURL, accessToken: auth.accessToken)
            family.clear()
            family.signedInUserId = auth.signedInUserId
            return "You left the family."
        }
        await loadProfiles()
        restoreSelectedPersonOrSelf()
    }

    func removeMember(userId: String) async {
        await request(showsFeedback: true) {
            try await client.removeMember(baseURL: connection.baseURL, accessToken: auth.accessToken, userId: userId)
            return "Removed family member."
        }
        await refreshFamily()
    }

    func deleteFamily() async {
        await request(showsFeedback: true) {
            try await client.deleteFamily(baseURL: connection.baseURL, accessToken: auth.accessToken)
            family.clear()
            family.signedInUserId = auth.signedInUserId
            return "Family deleted."
        }
        await loadProfiles()
        restoreSelectedPersonOrSelf()
    }
}
