import Foundation

enum HealthAPIError: LocalizedError {
    case invalidURL
    case missingToken
    case badStatus(Int, String?, code: String? = nil)

    var errorDescription: String? {
        switch self {
        case .invalidURL:
            return "The Health API base URL is invalid."
        case .missingToken:
            return "Paste a Supabase access token first."
        case .badStatus(let status, let message, _):
            return message.map { "Health API returned HTTP \(status): \($0)" } ?? "Health API returned HTTP \(status)."
        }
    }

    var errorCode: String? {
        switch self {
        case let .badStatus(_, _, code):
            return code
        default:
            return nil
        }
    }
}

struct HealthAPIClient {
    private static let healthKitEventBatchTimeout: TimeInterval = 45
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

    func bootstrap(baseURL: String, accessToken: String) async throws -> BootstrapResponse {
        guard !accessToken.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else {
            throw HealthAPIError.missingToken
        }
        return try await post(path: "bootstrap", baseURL: baseURL, accessToken: accessToken, body: EmptyRequest())
    }

    func createSelfProfile(baseURL: String, accessToken: String, displayName: String) async throws -> HealthProfile {
        guard !accessToken.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else {
            throw HealthAPIError.missingToken
        }
        return try await post(
            path: "me/profile",
            baseURL: baseURL,
            accessToken: accessToken,
            body: CreateSelfProfileRequest(displayName: displayName)
        )
    }

    func currentFamily(baseURL: String, accessToken: String) async throws -> FamilyResponse? {
        guard !accessToken.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else {
            throw HealthAPIError.missingToken
        }
        return try await get(path: "families/current", baseURL: baseURL, accessToken: accessToken)
    }

    func listMembers(baseURL: String, accessToken: String) async throws -> [FamilyMember] {
        guard !accessToken.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else {
            throw HealthAPIError.missingToken
        }
        return try await get(path: "families/members", baseURL: baseURL, accessToken: accessToken)
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

    func healthKitSettings(baseURL: String, accessToken: String, personId: String? = nil) async throws -> HealthKitSyncStatus {
        if let personId {
            let encoded = personId.addingPercentEncoding(withAllowedCharacters: .urlQueryAllowed) ?? personId
            return try await get(path: "healthkit/settings?personId=\(encoded)", baseURL: baseURL, accessToken: accessToken)
        }
        return try await get(path: "healthkit/settings", baseURL: baseURL, accessToken: accessToken)
    }

    /// Frozen API settings write: omit `consentVersion` and empty metrics to withdraw consent.
    func putHealthKitSettings(
        baseURL: String,
        accessToken: String,
        personId: String,
        consentVersion: String?,
        enabledGroups: [HealthKitSyncMetric],
        healthTimezone: String,
        installationId: String,
        replaceActiveInstallation: Bool = false
    ) async throws -> HealthKitSyncStatus {
        try await put(
            path: "healthkit/settings",
            baseURL: baseURL,
            accessToken: accessToken,
            body: HealthKitSettingsRequest(
                personId: personId,
                consentVersion: consentVersion,
                enabledGroups: enabledGroups,
                healthTimezone: healthTimezone,
                installationId: installationId,
                replaceActiveInstallation: replaceActiveInstallation
            )
        )
    }

    func applyHealthKitEvents(
        baseURL: String,
        accessToken: String,
        installationId: String,
        personId: String,
        timezoneVersion: Int,
        events: [HealthKitWireEvent]
    ) async throws -> HealthKitEventsBatchResult {
        try await post(
            path: "healthkit/events:batch",
            baseURL: baseURL,
            accessToken: accessToken,
            body: HealthKitEventsBatchBody(
                installationId: installationId,
                personId: personId,
                timezoneVersion: timezoneVersion,
                events: events
            ),
            timeoutInterval: Self.healthKitEventBatchTimeout
        )
    }

    func createHealthKitBackfillSession(
        baseURL: String,
        accessToken: String,
        installationId: String,
        personId: String,
        metric: HealthKitSyncMetric,
        timezoneVersion: Int
    ) async throws -> HealthKitBackfillSession {
        try await post(
            path: "healthkit/sessions",
            baseURL: baseURL,
            accessToken: accessToken,
            body: HealthKitSessionBody(
                installationId: installationId,
                personId: personId,
                group: metric,
                timezoneVersion: timezoneVersion
            )
        )
    }

    func putHealthKitScopeManifest(
        baseURL: String,
        accessToken: String,
        sessionId: String,
        scopeKey: String,
        installationId: String,
        personId: String,
        timezoneVersion: Int,
        eventCount: Int,
        manifestHash: String
    ) async throws -> HealthKitScopeManifestResult {
        try await put(
            path: "healthkit/sessions/\(sessionId)/scopes/\(scopeKey)/manifest",
            baseURL: baseURL,
            accessToken: accessToken,
            body: HealthKitScopeManifestBody(
                installationId: installationId,
                personId: personId,
                timezoneVersion: timezoneVersion,
                eventCount: eventCount,
                manifestHash: manifestHash
            )
        )
    }

    func completeHealthKitBackfillSession(
        baseURL: String,
        accessToken: String,
        sessionId: String,
        installationId: String,
        personId: String,
        timezoneVersion: Int
    ) async throws -> HealthKitBackfillSessionCompleteResult {
        try await post(
            path: "healthkit/sessions/\(sessionId)/complete",
            baseURL: baseURL,
            accessToken: accessToken,
            body: HealthKitSessionActionBody(
                installationId: installationId,
                personId: personId,
                timezoneVersion: timezoneVersion
            )
        )
    }

    func abortHealthKitBackfillSession(
        baseURL: String,
        accessToken: String,
        sessionId: String,
        installationId: String,
        personId: String,
        timezoneVersion: Int,
        reason: String? = nil
    ) async throws -> HealthKitBackfillSessionAbortResult {
        try await post(
            path: "healthkit/sessions/\(sessionId)/abort",
            baseURL: baseURL,
            accessToken: accessToken,
            body: HealthKitSessionActionBody(
                installationId: installationId,
                personId: personId,
                timezoneVersion: timezoneVersion,
                reason: reason
            )
        )
    }

    func getHealthKitBackfillSession(
        baseURL: String,
        accessToken: String,
        sessionId: String
    ) async throws -> HealthKitBackfillSession {
        try await get(
            path: "healthkit/sessions/\(sessionId)",
            baseURL: baseURL,
            accessToken: accessToken
        )
    }

    private func put<T: Decodable, Body: Encodable>(
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
        request.httpMethod = "PUT"
        request.setValue("application/json", forHTTPHeaderField: "content-type")
        request.setValue("application/json", forHTTPHeaderField: "accept")
        request.setValue("Bearer \(accessToken)", forHTTPHeaderField: "authorization")
        request.httpBody = try JSONEncoder().encode(body)

        return try await decodeEnvelope(T.self, from: request)
    }

    private func post<T: Decodable, Body: Encodable>(
        path: String,
        baseURL: String,
        accessToken: String,
        body: Body,
        timeoutInterval: TimeInterval? = nil
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
        if let timeoutInterval {
            request.timeoutInterval = timeoutInterval
        }

        return try await decodeEnvelope(T.self, from: request)
    }

    private func patch<T: Decodable, Body: Encodable>(
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
        request.httpMethod = "PATCH"
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
            throw HealthAPIError.badStatus(-1, nil, code: nil)
        }
        guard (200..<300).contains(http.statusCode) else {
            #if DEBUG
            if request.url?.path.contains("/healthkit/") == true,
               let body = String(data: data, encoding: .utf8) {
                print("FamilyOS HealthKit error \(http.statusCode) \(request.httpMethod ?? "GET") \(request.url?.path ?? ""): \(body)")
            }
            #endif
            let error = try? JSONDecoder().decode(APIErrorEnvelope.self, from: data)
            throw HealthAPIError.badStatus(http.statusCode, error?.error.message, code: error?.error.code)
        }

        #if DEBUG
        if request.url?.path.contains("/healthkit/") == true,
           let body = String(data: data, encoding: .utf8) {
            print("FamilyOS HealthKit response \(request.httpMethod ?? "GET") \(request.url?.path ?? ""): \(body)")
        }
        #endif
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
    let code: String?
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

private struct CreateSelfProfileRequest: Encodable {
    let displayName: String
}

private struct HealthKitSettingsRequest: Encodable {
    let personId: String
    let consentVersion: String?
    let enabledGroups: [HealthKitSyncMetric]
    let healthTimezone: String
    let installationId: String
    let replaceActiveInstallation: Bool

    func encode(to encoder: Encoder) throws {
        var container = encoder.container(keyedBy: CodingKeys.self)
        try container.encode(personId, forKey: .personId)
        try container.encodeIfPresent(consentVersion, forKey: .consentVersion)
        try container.encode(enabledGroups, forKey: .enabledGroups)
        try container.encode(healthTimezone, forKey: .healthTimezone)
        try container.encode(installationId, forKey: .installationId)
        try container.encode(replaceActiveInstallation, forKey: .replaceActiveInstallation)
    }

    private enum CodingKeys: String, CodingKey {
        case personId
        case consentVersion
        case enabledGroups
        case healthTimezone
        case installationId
        case replaceActiveInstallation
    }
}

private struct HealthKitEventsBatchBody: Encodable {
    let installationId: String
    let personId: String
    let timezoneVersion: Int
    let events: [HealthKitWireEvent]
}

private struct HealthKitSessionBody: Encodable {
    let installationId: String
    let personId: String
    let group: HealthKitSyncMetric
    let timezoneVersion: Int
}

private struct HealthKitScopeManifestBody: Encodable {
    let installationId: String
    let personId: String
    let timezoneVersion: Int
    let eventCount: Int
    let manifestHash: String
}

private struct HealthKitSessionActionBody: Encodable {
    let installationId: String
    let personId: String
    let timezoneVersion: Int
    var reason: String? = nil
}
