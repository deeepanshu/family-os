import Combine
import Foundation

@MainActor
final class HealthBootstrapViewModel: ObservableObject {
    var connection: HealthConnectionViewModel
    var auth: HealthAuthViewModel
    var family: HealthFamilyViewModel
    var profiles: HealthProfilesViewModel
    var readings: HealthReadingsViewModel

    @Published var statusMessage = "Online-only Phase 1 bootstrap is ready."
    @Published var isError = false

    let client = HealthAPIClient()
    let authClient = SupabaseAuthClient()
    let keychain = KeychainStore()
    let defaults = UserDefaults.standard

    private var cancellables: Set<AnyCancellable> = []

    init() {
        let environment = AppEnvironment.current
        connection = HealthConnectionViewModel(defaults: defaults, environment: environment)
        auth = HealthAuthViewModel(defaults: defaults, keychain: keychain)
        family = HealthFamilyViewModel()
        profiles = HealthProfilesViewModel()
        readings = HealthReadingsViewModel()

        republishChanges(from: connection)
        republishChanges(from: auth)
        republishChanges(from: family)
        republishChanges(from: profiles)
        republishChanges(from: readings)

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
        statusMessage = "Signed out."
        isError = false
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
}
