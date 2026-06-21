import Foundation

struct APIEnvelope<T: Decodable>: Decodable {
    let data: T
}

struct HealthcheckResponse: Decodable {
    let service: String
    let status: String
}

struct SessionResponse: Decodable {
    let userId: String
}

struct FamilyResponse: Decodable {
    let family: Family
    let membership: FamilyMembership
}

struct Family: Decodable {
    let id: String
    let name: String
}

struct FamilyMembership: Decodable {
    let role: String
    let status: String
}

struct CreateInviteResponse: Decodable {
    let token: String
}

enum HealthAPIError: LocalizedError {
    case invalidURL
    case missingToken
    case badStatus(Int)

    var errorDescription: String? {
        switch self {
        case .invalidURL:
            return "The Health API base URL is invalid."
        case .missingToken:
            return "Paste a Supabase access token first."
        case .badStatus(let status):
            return "Health API returned HTTP \(status)."
        }
    }
}

struct HealthAPIClient {
    func healthcheck(baseURL: String) async throws -> HealthcheckResponse {
        try await get(path: "healthcheck", baseURL: baseURL, accessToken: nil)
    }

    func session(baseURL: String, accessToken: String) async throws -> SessionResponse {
        guard !accessToken.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else {
            throw HealthAPIError.missingToken
        }
        return try await get(path: "me", baseURL: baseURL, accessToken: accessToken)
    }

    func currentFamily(baseURL: String, accessToken: String) async throws -> FamilyResponse? {
        guard !accessToken.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else {
            throw HealthAPIError.missingToken
        }
        return try await get(path: "families/current", baseURL: baseURL, accessToken: accessToken)
    }

    func createFamily(baseURL: String, accessToken: String, name: String) async throws -> FamilyResponse {
        guard !accessToken.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else {
            throw HealthAPIError.missingToken
        }
        guard let url = URL(string: baseURL)?.appending(path: "families") else {
            throw HealthAPIError.invalidURL
        }

        var request = URLRequest(url: url)
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "content-type")
        request.setValue("application/json", forHTTPHeaderField: "accept")
        request.setValue("Bearer \(accessToken)", forHTTPHeaderField: "authorization")
        request.httpBody = try JSONEncoder().encode(["name": name])

        let (data, response) = try await URLSession.shared.data(for: request)
        guard let http = response as? HTTPURLResponse else {
            throw HealthAPIError.badStatus(-1)
        }
        guard (200..<300).contains(http.statusCode) else {
            throw HealthAPIError.badStatus(http.statusCode)
        }

        return try JSONDecoder().decode(APIEnvelope<FamilyResponse>.self, from: data).data
    }

    func createInvite(baseURL: String, accessToken: String) async throws -> CreateInviteResponse {
        try await post(
            path: "invites",
            baseURL: baseURL,
            accessToken: accessToken,
            body: ["role": "member"]
        )
    }

    func acceptInvite(baseURL: String, accessToken: String, token: String) async throws -> FamilyResponse {
        guard !token.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else {
            throw HealthAPIError.invalidURL
        }
        let encodedToken = token.addingPercentEncoding(withAllowedCharacters: .urlPathAllowed) ?? token
        return try await post(
            path: "invites/\(encodedToken)/accept",
            baseURL: baseURL,
            accessToken: accessToken,
            body: [String: String]()
        )
    }

    private func post<T: Decodable, Body: Encodable>(
        path: String,
        baseURL: String,
        accessToken: String,
        body: Body
    ) async throws -> T {
        guard !accessToken.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else {
            throw HealthAPIError.missingToken
        }
        guard let url = URL(string: baseURL)?.appending(path: path) else {
            throw HealthAPIError.invalidURL
        }

        var request = URLRequest(url: url)
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "content-type")
        request.setValue("application/json", forHTTPHeaderField: "accept")
        request.setValue("Bearer \(accessToken)", forHTTPHeaderField: "authorization")
        request.httpBody = try JSONEncoder().encode(body)

        let (data, response) = try await URLSession.shared.data(for: request)
        guard let http = response as? HTTPURLResponse else {
            throw HealthAPIError.badStatus(-1)
        }
        guard (200..<300).contains(http.statusCode) else {
            throw HealthAPIError.badStatus(http.statusCode)
        }

        return try JSONDecoder().decode(APIEnvelope<T>.self, from: data).data
    }

    private func get<T: Decodable>(path: String, baseURL: String, accessToken: String?) async throws -> T {
        guard let url = URL(string: baseURL)?.appending(path: path) else {
            throw HealthAPIError.invalidURL
        }

        var request = URLRequest(url: url)
        request.httpMethod = "GET"
        request.setValue("application/json", forHTTPHeaderField: "accept")
        if let accessToken {
            request.setValue("Bearer \(accessToken)", forHTTPHeaderField: "authorization")
        }

        let (data, response) = try await URLSession.shared.data(for: request)
        guard let http = response as? HTTPURLResponse else {
            throw HealthAPIError.badStatus(-1)
        }
        guard (200..<300).contains(http.statusCode) else {
            throw HealthAPIError.badStatus(http.statusCode)
        }

        return try JSONDecoder().decode(APIEnvelope<T>.self, from: data).data
    }
}
