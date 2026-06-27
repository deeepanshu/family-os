import Foundation

@MainActor
final class HealthAuthViewModel: ObservableObject {
    @Published var accessToken: String
    @Published var signedInUserEmail: String?
    @Published var signedInUserId: String?

    var currentAppleNonce: AppleSignInNonce?
    var refreshToken: String?

    init(defaults: UserDefaults, keychain: KeychainStore) {
        accessToken = (try? keychain.string(for: DefaultsKey.accessToken)) ?? ""
        refreshToken = try? keychain.string(for: DefaultsKey.refreshToken)
        signedInUserId = defaults.string(forKey: DefaultsKey.userId)
        signedInUserEmail = defaults.string(forKey: DefaultsKey.userEmail)
    }

    func store(session: SupabaseSession, defaults: UserDefaults, keychain: KeychainStore) throws {
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
    }

    func clear(defaults: UserDefaults, keychain: KeychainStore) {
        accessToken = ""
        refreshToken = nil
        signedInUserId = nil
        signedInUserEmail = nil
        currentAppleNonce = nil
        keychain.remove(DefaultsKey.accessToken)
        keychain.remove(DefaultsKey.refreshToken)
        defaults.removeObject(forKey: DefaultsKey.userId)
        defaults.removeObject(forKey: DefaultsKey.userEmail)
    }
}
