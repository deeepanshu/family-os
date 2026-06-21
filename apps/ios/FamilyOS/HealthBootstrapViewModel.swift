import Foundation
import Combine

@MainActor
final class HealthBootstrapViewModel: ObservableObject {
    @Published var baseURL = "https://api.deepanshujain.com/health/v1"
    @Published var accessToken = ""
    @Published var familyName = ""
    @Published var inviteToken = ""
    @Published private(set) var lastCreatedInviteToken: String?
    @Published private(set) var currentFamilyName: String?
    @Published private(set) var currentFamilyRole: String?
    @Published private(set) var statusMessage = "Online-only Phase 1 bootstrap is ready."
    @Published private(set) var isError = false

    private let client = HealthAPIClient()

    func checkHealth() async {
        await request {
            let response = try await client.healthcheck(baseURL: baseURL)
            return "\(response.service) is \(response.status)."
        }
    }

    func checkSession() async {
        await request {
            let response = try await client.session(baseURL: baseURL, accessToken: accessToken)
            return "Authenticated as \(response.userId)."
        }
    }

    func loadCurrentFamily() async {
        await request {
            let response = try await client.currentFamily(baseURL: baseURL, accessToken: accessToken)
            currentFamilyName = response?.family.name
            currentFamilyRole = response?.membership.role
            guard let response else {
                return "No active family yet. Create one to continue."
            }
            return "Current family: \(response.family.name)."
        }
    }

    func createFamily() async {
        await request {
            let trimmedName = familyName.trimmingCharacters(in: .whitespacesAndNewlines)
            let response = try await client.createFamily(baseURL: baseURL, accessToken: accessToken, name: trimmedName)
            currentFamilyName = response.family.name
            currentFamilyRole = response.membership.role
            return "Created \(response.family.name); you are \(response.membership.role)."
        }
    }

    func createInvite() async {
        await request {
            let response = try await client.createInvite(baseURL: baseURL, accessToken: accessToken)
            lastCreatedInviteToken = response.token
            return "Created invite token: \(response.token)"
        }
    }

    func acceptInvite() async {
        await request {
            let response = try await client.acceptInvite(
                baseURL: baseURL,
                accessToken: accessToken,
                token: inviteToken.trimmingCharacters(in: .whitespacesAndNewlines)
            )
            currentFamilyName = response.family.name
            currentFamilyRole = response.membership.role
            return "Joined \(response.family.name) as \(response.membership.role)."
        }
    }

    private func request(_ action: () async throws -> String) async {
        isError = false
        statusMessage = "Contacting Health API..."
        do {
            statusMessage = try await action()
        } catch {
            isError = true
            statusMessage = error.localizedDescription
        }
    }
}
