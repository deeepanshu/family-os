import Foundation
import Combine

@MainActor
final class HealthBootstrapViewModel: ObservableObject {
    @Published var baseURL = "https://api.deepanshujain.com/health/v1"
    @Published var accessToken = ""
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
