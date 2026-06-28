import Foundation

enum HealthAPIError: LocalizedError {
    case invalidURL
    case missingToken
    case badStatus(Int, String?)

    var errorDescription: String? {
        switch self {
        case .invalidURL:
            return "The Health API base URL is invalid."
        case .missingToken:
            return "Paste a Supabase access token first."
        case .badStatus(let status, let message):
            return message.map { "Health API returned HTTP \(status): \($0)" } ?? "Health API returned HTTP \(status)."
        }
    }
}

struct HealthAPIClient {
    let session: URLSession

    init(session: URLSession = .shared) {
        self.session = session
    }

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
        guard let url = endpointURL(baseURL: baseURL, path: "families") else {
            throw HealthAPIError.invalidURL
        }

        var request = URLRequest(url: url)
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "content-type")
        request.setValue("application/json", forHTTPHeaderField: "accept")
        request.setValue("Bearer \(accessToken)", forHTTPHeaderField: "authorization")
        request.httpBody = try JSONEncoder().encode(CreateFamilyRequest(name: name))

        return try await decodeEnvelope(FamilyResponse.self, from: request)
    }

    func createInvite(baseURL: String, accessToken: String) async throws -> CreateInviteResponse {
        return try await post(
            path: "invites",
            baseURL: baseURL,
            accessToken: accessToken,
            body: CreateInviteRequest(role: .member)
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
            body: EmptyRequest()
        )
    }

    func listProfiles(baseURL: String, accessToken: String) async throws -> [HealthProfile] {
        try await get(path: "people", baseURL: baseURL, accessToken: accessToken)
    }

    func createProfile(
        baseURL: String,
        accessToken: String,
        displayName: String,
        relationshipLabel: String
    ) async throws -> HealthProfile {
        return try await post(
            path: "people",
            baseURL: baseURL,
            accessToken: accessToken,
            body: CreateProfileRequest(
                displayName: displayName,
                relationshipLabel: relationshipLabel.isEmpty ? nil : relationshipLabel
            )
        )
    }

    func listBloodPressure(baseURL: String, accessToken: String, personId: String) async throws -> [BloodPressureReading] {
        let encodedPersonId = personId.addingPercentEncoding(withAllowedCharacters: .urlQueryAllowed) ?? personId
        return try await get(path: "readings/blood-pressure?personId=\(encodedPersonId)", baseURL: baseURL, accessToken: accessToken)
    }

    func createBloodPressure(
        baseURL: String,
        accessToken: String,
        personId: String,
        systolic: Int,
        diastolic: Int,
        pulse: Int?
    ) async throws -> BloodPressureReading {
        let body = CreateBloodPressureRequest(
            personId: personId,
            systolic: systolic,
            diastolic: diastolic,
            pulse: pulse,
            measuredAt: ISO8601DateFormatter().string(from: Date())
        )
        return try await post(path: "readings/blood-pressure", baseURL: baseURL, accessToken: accessToken, body: body)
    }

    func listBloodGlucose(baseURL: String, accessToken: String, personId: String) async throws -> [BloodGlucoseReading] {
        let encodedPersonId = personId.addingPercentEncoding(withAllowedCharacters: .urlQueryAllowed) ?? personId
        return try await get(path: "readings/blood-glucose?personId=\(encodedPersonId)", baseURL: baseURL, accessToken: accessToken)
    }

    func createBloodGlucose(
        baseURL: String,
        accessToken: String,
        personId: String,
        value: Double,
        context: GlucoseContext
    ) async throws -> BloodGlucoseReading {
        let body = CreateBloodGlucoseRequest(
            personId: personId,
            value: value,
            context: context,
            measuredAt: ISO8601DateFormatter().string(from: Date())
        )
        return try await post(path: "readings/blood-glucose", baseURL: baseURL, accessToken: accessToken, body: body)
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
        guard let url = endpointURL(baseURL: baseURL, path: path) else {
            throw HealthAPIError.invalidURL
        }

        var request = URLRequest(url: url)
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "content-type")
        request.setValue("application/json", forHTTPHeaderField: "accept")
        request.setValue("Bearer \(accessToken)", forHTTPHeaderField: "authorization")
        request.httpBody = try JSONEncoder().encode(body)

        return try await decodeEnvelope(T.self, from: request)
    }

    private func get<T: Decodable>(path: String, baseURL: String, accessToken: String?) async throws -> T {
        guard let url = endpointURL(baseURL: baseURL, path: path) else {
            throw HealthAPIError.invalidURL
        }

        var request = URLRequest(url: url)
        request.httpMethod = "GET"
        request.setValue("application/json", forHTTPHeaderField: "accept")
        if let accessToken {
            request.setValue("Bearer \(accessToken)", forHTTPHeaderField: "authorization")
        }

        return try await decodeEnvelope(T.self, from: request)
    }

    private func decodeEnvelope<T: Decodable>(_ type: T.Type, from request: URLRequest) async throws -> T {
        let (data, response) = try await session.data(for: request)
        guard let http = response as? HTTPURLResponse else {
            throw HealthAPIError.badStatus(-1, nil)
        }
        guard (200..<300).contains(http.statusCode) else {
            let error = try? JSONDecoder().decode(APIErrorEnvelope.self, from: data)
            throw HealthAPIError.badStatus(http.statusCode, error?.error.message)
        }

        return try JSONDecoder().decode(APIEnvelope<T>.self, from: data).data
    }

    private func endpointURL(baseURL: String, path: String) -> URL? {
        let trimmedBase = baseURL.trimmingCharacters(in: CharacterSet(charactersIn: "/"))
        let trimmedPath = path.trimmingCharacters(in: CharacterSet(charactersIn: "/"))
        return URL(string: "\(trimmedBase)/\(trimmedPath)")
    }
}

private struct APIErrorEnvelope: Decodable {
    let error: APIErrorBody
}

private struct APIErrorBody: Decodable {
    let message: String
}

private struct EmptyRequest: Encodable {}

private struct CreateFamilyRequest: Encodable {
    let name: String
}

private struct CreateInviteRequest: Encodable {
    let role: FamilyRole
}

private struct CreateProfileRequest: Encodable {
    let displayName: String
    let relationshipLabel: String?
}

private struct CreateBloodPressureRequest: Encodable {
    let personId: String
    let systolic: Int
    let diastolic: Int
    let pulse: Int?
    let measuredAt: String
}

private struct CreateBloodGlucoseRequest: Encodable {
    let personId: String
    let value: Double
    let unit = "mg/dL"
    let context: GlucoseContext
    let measuredAt: String
}
