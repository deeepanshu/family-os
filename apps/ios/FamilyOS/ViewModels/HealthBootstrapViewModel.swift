import Combine
import Foundation

@MainActor
final class HealthBootstrapViewModel: ObservableObject {
    var connection: HealthConnectionViewModel
    var auth: HealthAuthViewModel
    var family: HealthFamilyViewModel
    var profiles: HealthProfilesViewModel
    var readings: HealthReadingsViewModel
    var healthKit: HealthKitSyncStateViewModel

    @Published var statusMessage = "Online-only Phase 1 bootstrap is ready."
    @Published var isError = false
    @Published var isStartingUp = false
    @Published var needsProfileSetup = false
    @Published var startupError: Error?

    let client: HealthAPIClient
    let healthKitClient: HealthKitClient
    let authClient: SupabaseAuthClient
    let keychain: KeychainStore
    let defaults: UserDefaults

    private var cancellables: Set<AnyCancellable> = []

    init(dependencies: HealthBootstrapDependencies = .live) {
        client = dependencies.healthClient
        healthKitClient = dependencies.healthKitClient
        authClient = dependencies.authClient
        keychain = dependencies.keychain
        defaults = dependencies.defaults

        connection = HealthConnectionViewModel(defaults: defaults, environment: dependencies.environment)
        auth = HealthAuthViewModel(defaults: defaults, keychain: keychain)
        family = HealthFamilyViewModel()
        profiles = HealthProfilesViewModel()
        readings = HealthReadingsViewModel()
        healthKit = HealthKitSyncStateViewModel()

        republishChanges(from: connection)
        republishChanges(from: auth)
        republishChanges(from: family)
        republishChanges(from: profiles)
        republishChanges(from: readings)
        republishChanges(from: healthKit)

        if hasAccessToken {
            statusMessage = auth.signedInUserEmail.map { "Signed in as \($0)." } ?? "Signed in."
        }
    }

    var hasAccessToken: Bool {
        !auth.accessToken.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
    }

    var hasSupabaseConfiguration: Bool {
        !connection.supabaseURL.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty &&
        !connection.supabaseAnonKey.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
    }

    var usesLocalDevSignIn: Bool {
        #if DEBUG
        connection.environmentName == .local && !hasSupabaseConfiguration
        #else
        false
        #endif
    }

    var signedInSummary: String {
        if let email = auth.signedInUserEmail, !email.isEmpty {
            return email
        }
        if let userId = auth.signedInUserId, !userId.isEmpty {
            return userId
        }
        return hasAccessToken ? "Authenticated" : "Not signed in"
    }

    var selectedProfile: HealthProfile? {
        profiles.selectedProfile
    }

    var hasSelectedProfile: Bool {
        profiles.hasSelectedProfile
    }

    func saveConnectionSettings() {
        connection.save(to: defaults)
        statusMessage = "Saved connection settings."
        isError = false
    }

    func signOut() {
        auth.clear(defaults: defaults, keychain: keychain)
        family.clear()
        profiles.clear()
        readings.clear()
        healthKit.clear()
        pendingInviteToken = nil
        needsProfileSetup = false
        startupError = nil
        statusMessage = "Signed out."
        isError = false
    }

    var pendingInviteToken: String? {
        get { defaults.string(forKey: DefaultsKey.pendingInviteToken) }
        set {
            if let newValue {
                defaults.set(newValue, forKey: DefaultsKey.pendingInviteToken)
            } else {
                defaults.removeObject(forKey: DefaultsKey.pendingInviteToken)
            }
        }
    }

    var selfProfile: HealthProfile? {
        profiles.profiles.first {
            $0.relationshipLabel == "Self" && ($0.linkedUserId == auth.signedInUserId || auth.signedInUserId == nil)
        }
    }

    func startup() async {
        guard hasAccessToken else {
            isStartingUp = false
            needsProfileSetup = false
            return
        }
        isStartingUp = true
        startupError = nil
        defer { isStartingUp = false }

        do {
            if let token = pendingInviteToken {
                _ = try await client.acceptInvite(baseURL: connection.baseURL, accessToken: auth.accessToken, token: token)
                pendingInviteToken = nil
            }

            let bootstrap = try await client.bootstrap(baseURL: connection.baseURL, accessToken: auth.accessToken)
            applyBootstrap(bootstrap)
        } catch {
            startupError = error
            statusMessage = error.localizedDescription
            isError = true
        }
    }

    func createSelfProfile(displayName: String) async {
        guard !displayName.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else {
            isError = true
            statusMessage = "Please enter your name."
            return
        }
        await request {
            let profile = try await client.createSelfProfile(
                baseURL: connection.baseURL,
                accessToken: auth.accessToken,
                displayName: displayName.trimmingCharacters(in: .whitespacesAndNewlines)
            )
            if !self.profiles.profiles.contains(where: { $0.id == profile.id }) {
                self.profiles.profiles.append(profile)
            }
            self.profiles.selectedProfileId = profile.id
            self.healthKit.linkedProfileId = profile.id
            self.needsProfileSetup = false
            return "Profile created."
        }
    }

    private func applyBootstrap(_ response: BootstrapResponse) {
        family.currentFamilyName = response.family.name
        family.familyKind = response.family.kind
        family.currentFamilyRole = response.membership.role
        profiles.profiles = response.profiles
        if let selfProfile = response.selfProfile {
            profiles.selectedProfileId = selfProfile.id
        } else if profiles.profiles.count == 1 {
            profiles.selectedProfileId = profiles.profiles[0].id
        }
        needsProfileSetup = response.needsProfileSetup
        healthKit.linkedProfileId = response.selfProfile?.id
    }

    func request(_ action: () async throws -> String) async {
        isError = false
        statusMessage = "Contacting Health API..."
        do {
            statusMessage = try await action()
        } catch {
            isError = true
            statusMessage = error.localizedDescription
        }
    }

    func storeSession(_ session: SupabaseSession) throws {
        try auth.store(session: session, defaults: defaults, keychain: keychain)
        saveConnectionSettings()
    }

    func handleInviteURL(_ url: URL) -> Bool {
        guard let components = URLComponents(url: url, resolvingAgainstBaseURL: true) else {
            return false
        }
        let pathComponents = components.path.split(separator: "/").map(String.init)
        if components.host == "invite" || pathComponents.first == "invite" {
            let token = components.host == "invite" ? pathComponents.first : pathComponents.dropFirst().first
            guard let token, !token.isEmpty else { return false }
            pendingInviteToken = token
            return true
        }
        if let queryToken = components.queryItems?.first(where: { $0.name == "invite" })?.value, !queryToken.isEmpty {
            pendingInviteToken = queryToken
            return true
        }
        return false
    }

    private func republishChanges<Object: ObservableObject>(from object: Object)
    where Object.ObjectWillChangePublisher == ObservableObjectPublisher {
        object.objectWillChange
            .sink { [weak self] _ in self?.objectWillChange.send() }
            .store(in: &cancellables)
    }
}

enum DefaultsKey {
    static let baseURL = "familyOS.baseURL"
    static let supabaseURL = "familyOS.supabaseURL"
    static let supabaseAnonKey = "familyOS.supabaseAnonKey"
    static let accessToken = "familyOS.accessToken"
    static let refreshToken = "familyOS.refreshToken"
    static let userId = "familyOS.userId"
    static let userEmail = "familyOS.userEmail"
    static let pendingInviteToken = "familyOS.pendingInviteToken"
}
