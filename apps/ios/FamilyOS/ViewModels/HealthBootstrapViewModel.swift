import AuthenticationServices
import Combine
import Foundation

@MainActor
final class HealthBootstrapViewModel: ObservableObject {
    @Published var baseURL = "https://api.deepanshujain.com/health/v1"
    @Published var supabaseURL = ""
    @Published var supabaseAnonKey = ""
    @Published var accessToken = ""
    @Published private(set) var signedInUserEmail: String?
    @Published private(set) var signedInUserId: String?
    @Published var familyName = ""
    @Published var inviteToken = ""
    @Published var profileName = ""
    @Published var profileRelationship = ""
    @Published var selectedProfileId = ""
    @Published var systolic = "120"
    @Published var diastolic = "80"
    @Published var pulse = ""
    @Published var glucoseValue = "100"
    @Published var glucoseContext = "fasting"
    @Published private(set) var lastCreatedInviteToken: String?
    @Published private(set) var currentFamilyName: String?
    @Published private(set) var currentFamilyRole: String?
    @Published private(set) var profiles: [HealthProfile] = []
    @Published private(set) var bloodPressureReadings: [BloodPressureReading] = []
    @Published private(set) var bloodGlucoseReadings: [BloodGlucoseReading] = []
    @Published private(set) var notificationRouteMessage: String?
    @Published private(set) var statusMessage = "Online-only Phase 1 bootstrap is ready."
    @Published private(set) var isError = false

    private let client = HealthAPIClient()
    private let authClient = SupabaseAuthClient()
    private let keychain = KeychainStore()
    private var currentAppleNonce: AppleSignInNonce?
    private var refreshToken: String?
    private let defaults = UserDefaults.standard
    private let appEnvironment = AppEnvironment.current

    init() {
        baseURL = defaults.string(forKey: DefaultsKey.baseURL) ?? appEnvironment.apiBaseURL
        supabaseURL = defaults.string(forKey: DefaultsKey.supabaseURL) ?? appEnvironment.supabaseURL
        supabaseAnonKey = defaults.string(forKey: DefaultsKey.supabaseAnonKey) ?? appEnvironment.supabaseAnonKey
        accessToken = (try? keychain.string(for: DefaultsKey.accessToken)) ?? ""
        refreshToken = try? keychain.string(for: DefaultsKey.refreshToken)
        signedInUserId = defaults.string(forKey: DefaultsKey.userId)
        signedInUserEmail = defaults.string(forKey: DefaultsKey.userEmail)
        if hasAccessToken {
            statusMessage = signedInUserEmail.map { "Signed in as \($0)." } ?? "Signed in."
        }
    }

    var hasAccessToken: Bool {
        !accessToken.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
    }

    var hasSupabaseConfiguration: Bool {
        !supabaseURL.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty &&
        !supabaseAnonKey.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
    }

    var signedInSummary: String {
        if let signedInUserEmail, !signedInUserEmail.isEmpty {
            return signedInUserEmail
        }
        if let signedInUserId, !signedInUserId.isEmpty {
            return signedInUserId
        }
        return hasAccessToken ? "Authenticated" : "Not signed in"
    }

    var selectedProfile: HealthProfile? {
        profiles.first { $0.id == selectedProfileId }
    }

    var hasSelectedProfile: Bool {
        !selectedProfileId.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
    }

    func saveConnectionSettings() {
        defaults.set(baseURL.trimmingCharacters(in: .whitespacesAndNewlines), forKey: DefaultsKey.baseURL)
        defaults.set(supabaseURL.trimmingCharacters(in: .whitespacesAndNewlines), forKey: DefaultsKey.supabaseURL)
        defaults.set(supabaseAnonKey.trimmingCharacters(in: .whitespacesAndNewlines), forKey: DefaultsKey.supabaseAnonKey)
        statusMessage = "Saved connection settings."
        isError = false
    }

    func prepareAppleSignInRequest(_ request: ASAuthorizationAppleIDRequest) {
        do {
            let nonce = try authClient.makeAppleNonce()
            currentAppleNonce = nonce
            request.requestedScopes = [.fullName, .email]
            request.nonce = nonce.sha256
        } catch {
            isError = true
            statusMessage = error.localizedDescription
        }
    }

    func handleAppleSignInCompletion(_ result: Result<ASAuthorization, Error>) async {
        switch result {
        case .success(let authorization):
            await signInWithApple(authorization)
        case .failure(let error):
            isError = true
            statusMessage = error.localizedDescription
        }
    }

    func refreshSupabaseSession() async {
        await request {
            guard let refreshToken else {
                return "No refresh token is available. Sign in again."
            }
            let session = try await authClient.refreshSession(
                supabaseURL: supabaseURL,
                anonKey: supabaseAnonKey,
                refreshToken: refreshToken
            )
            try storeSession(session)
            return "Refreshed Supabase session for \(signedInSummary)."
        }
    }

    func useManualAccessToken() {
        let trimmed = accessToken.trimmingCharacters(in: .whitespacesAndNewlines)
        accessToken = trimmed
        do {
            try keychain.set(trimmed, for: DefaultsKey.accessToken)
        } catch {
            isError = true
            statusMessage = error.localizedDescription
            return
        }
        keychain.remove(DefaultsKey.refreshToken)
        defaults.removeObject(forKey: DefaultsKey.userId)
        defaults.removeObject(forKey: DefaultsKey.userEmail)
        refreshToken = nil
        signedInUserId = nil
        signedInUserEmail = nil
        isError = trimmed.isEmpty
        statusMessage = trimmed.isEmpty ? "Paste a Supabase access token first." : "Using manual access token."
    }

    func signOut() {
        accessToken = ""
        refreshToken = nil
        signedInUserId = nil
        signedInUserEmail = nil
        currentFamilyName = nil
        currentFamilyRole = nil
        profiles = []
        bloodPressureReadings = []
        bloodGlucoseReadings = []
        lastCreatedInviteToken = nil
        keychain.remove(DefaultsKey.accessToken)
        keychain.remove(DefaultsKey.refreshToken)
        defaults.removeObject(forKey: DefaultsKey.userId)
        defaults.removeObject(forKey: DefaultsKey.userEmail)
        statusMessage = "Signed out."
        isError = false
    }

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

    func loadProfiles() async {
        await request {
            profiles = try await client.listProfiles(baseURL: baseURL, accessToken: accessToken)
            return "Loaded \(profiles.count) health profiles."
        }
    }

    func createBloodPressure() async {
        await request {
            guard !selectedProfileId.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else {
                return "Choose a profile first."
            }
            guard let systolicValue = Int(systolic), let diastolicValue = Int(diastolic) else {
                return "Enter numeric systolic and diastolic values."
            }
            guard (50...260).contains(systolicValue), (30...180).contains(diastolicValue) else {
                return "BP must be systolic 50-260 and diastolic 30-180."
            }
            let trimmedPulse = pulse.trimmingCharacters(in: .whitespacesAndNewlines)
            let pulseValue: Int?
            if trimmedPulse.isEmpty {
                pulseValue = nil
            } else if let parsedPulse = Int(trimmedPulse), (30...220).contains(parsedPulse) {
                pulseValue = parsedPulse
            } else {
                return "Pulse must be a number from 30-220."
            }
            let reading = try await client.createBloodPressure(
                baseURL: baseURL,
                accessToken: accessToken,
                personId: selectedProfileId,
                systolic: systolicValue,
                diastolic: diastolicValue,
                pulse: pulseValue
            )
            bloodPressureReadings.insert(reading, at: 0)
            return "Logged BP \(reading.systolic)/\(reading.diastolic)."
        }
    }

    func loadBloodPressure() async {
        await request {
            bloodPressureReadings = try await client.listBloodPressure(
                baseURL: baseURL,
                accessToken: accessToken,
                personId: selectedProfileId
            )
            return "Loaded \(bloodPressureReadings.count) BP readings."
        }
    }

    func createBloodGlucose() async {
        await request {
            guard !selectedProfileId.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else {
                return "Choose a profile first."
            }
            guard let value = Double(glucoseValue), (20...700).contains(value) else {
                return "Sugar must be 20-700 mg/dL."
            }
            let reading = try await client.createBloodGlucose(
                baseURL: baseURL,
                accessToken: accessToken,
                personId: selectedProfileId,
                value: value,
                context: glucoseContext
            )
            bloodGlucoseReadings.insert(reading, at: 0)
            return "Logged sugar \(reading.value) mg/dL."
        }
    }

    func loadBloodGlucose() async {
        await request {
            bloodGlucoseReadings = try await client.listBloodGlucose(
                baseURL: baseURL,
                accessToken: accessToken,
                personId: selectedProfileId
            )
            return "Loaded \(bloodGlucoseReadings.count) sugar readings."
        }
    }

    func handleNotification(userInfo: [AnyHashable: Any]) {
        let action = userInfo["action"] as? String
        if let subjectPersonId = userInfo["subject_person_id"] as? String,
           !subjectPersonId.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
            selectedProfileId = subjectPersonId
        }
        switch action {
        case "open_add_blood_glucose":
            notificationRouteMessage = "Opened sugar logging from reminder."
            statusMessage = notificationRouteMessage ?? statusMessage
        case "open_add_blood_pressure":
            notificationRouteMessage = "Opened BP logging from reminder."
            statusMessage = notificationRouteMessage ?? statusMessage
        case "open_reminder":
            notificationRouteMessage = "Opened reminder details."
            statusMessage = notificationRouteMessage ?? statusMessage
        default:
            notificationRouteMessage = "Opened Family OS notification."
            statusMessage = notificationRouteMessage ?? statusMessage
        }
    }

    func createProfile() async {
        await request {
            let profile = try await client.createProfile(
                baseURL: baseURL,
                accessToken: accessToken,
                displayName: profileName.trimmingCharacters(in: .whitespacesAndNewlines),
                relationshipLabel: profileRelationship.trimmingCharacters(in: .whitespacesAndNewlines)
            )
            profiles.append(profile)
            selectedProfileId = profile.id
            profileName = ""
            profileRelationship = ""
            return "Created profile for \(profile.displayName)."
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

    private func signInWithApple(_ authorization: ASAuthorization) async {
        await request {
            guard let currentAppleNonce else {
                return "Apple sign-in nonce was missing. Try again."
            }
            let session = try await authClient.exchangeAppleCredential(
                supabaseURL: supabaseURL,
                anonKey: supabaseAnonKey,
                authorization: authorization,
                rawNonce: currentAppleNonce.raw
            )
            try storeSession(session)
            self.currentAppleNonce = nil
            return "Signed in with Apple as \(signedInSummary)."
        }
        if hasAccessToken {
            await loadCurrentFamily()
            await loadProfiles()
        }
    }

    private func storeSession(_ session: SupabaseSession) throws {
        accessToken = session.accessToken
        refreshToken = session.refreshToken
        signedInUserId = session.user?.id
        signedInUserEmail = session.user?.email
        try keychain.set(accessToken, for: DefaultsKey.accessToken)
        if let refreshToken {
            try keychain.set(refreshToken, for: DefaultsKey.refreshToken)
        } else {
            keychain.remove(DefaultsKey.refreshToken)
        }
        if let signedInUserId {
            defaults.set(signedInUserId, forKey: DefaultsKey.userId)
        } else {
            defaults.removeObject(forKey: DefaultsKey.userId)
        }
        if let signedInUserEmail {
            defaults.set(signedInUserEmail, forKey: DefaultsKey.userEmail)
        } else {
            defaults.removeObject(forKey: DefaultsKey.userEmail)
        }
        saveConnectionSettings()
    }
}

private enum DefaultsKey {
    static let baseURL = "familyOS.baseURL"
    static let supabaseURL = "familyOS.supabaseURL"
    static let supabaseAnonKey = "familyOS.supabaseAnonKey"
    static let accessToken = "familyOS.accessToken"
    static let refreshToken = "familyOS.refreshToken"
    static let userId = "familyOS.userId"
    static let userEmail = "familyOS.userEmail"
}
