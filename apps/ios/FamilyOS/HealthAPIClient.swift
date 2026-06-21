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

struct HealthProfile: Decodable, Identifiable {
    let id: String
    let displayName: String
    let relationshipLabel: String?
}

struct BloodPressureReading: Decodable, Identifiable {
    let id: String
    let systolic: Int
    let diastolic: Int
    let pulse: Int?
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
        guard let url = endpointURL(baseURL: baseURL, path: "families") else {
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
        return try await post(
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

    func listProfiles(baseURL: String, accessToken: String) async throws -> [HealthProfile] {
        try await get(path: "people", baseURL: baseURL, accessToken: accessToken)
    }

    func createProfile(
        baseURL: String,
        accessToken: String,
        displayName: String,
        relationshipLabel: String
    ) async throws -> HealthProfile {
        var body = ["displayName": displayName]
        if !relationshipLabel.isEmpty {
            body["relationshipLabel"] = relationshipLabel
        }
        return try await post(
            path: "people",
            baseURL: baseURL,
            accessToken: accessToken,
            body: body
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
        var body: [String: AnyEncodable] = [
            "personId": AnyEncodable(personId),
            "systolic": AnyEncodable(systolic),
            "diastolic": AnyEncodable(diastolic),
            "measuredAt": AnyEncodable(ISO8601DateFormatter().string(from: Date()))
        ]
        if let pulse {
            body["pulse"] = AnyEncodable(pulse)
        }
        return try await post(path: "readings/blood-pressure", baseURL: baseURL, accessToken: accessToken, body: body)
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
        guard let url = endpointURL(baseURL: baseURL, path: path) else {
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

    private func endpointURL(baseURL: String, path: String) -> URL? {
        let trimmedBase = baseURL.trimmingCharacters(in: CharacterSet(charactersIn: "/"))
        let trimmedPath = path.trimmingCharacters(in: CharacterSet(charactersIn: "/"))
        return URL(string: "\(trimmedBase)/\(trimmedPath)")
    }
}

struct AnyEncodable: Encodable {
    private let encodeValue: (Encoder) throws -> Void

    init<T: Encodable>(_ value: T) {
        self.encodeValue = value.encode
    }

    func encode(to encoder: Encoder) throws {
        try encodeValue(encoder)
    }
}
