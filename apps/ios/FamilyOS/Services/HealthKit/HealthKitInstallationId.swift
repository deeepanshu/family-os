import Foundation

/// Stable installation id for HealthKit settings fencing (Keychain only).
///
/// Intentionally tiny. The old UserDefaults + SQLite dual ledger is gone.
enum HealthKitInstallationId {
    private static let keychainKey = "healthkit.installationId"

    static func current(using keychain: KeychainStore = KeychainStore()) throws -> String {
        if let existing = try keychain.string(for: keychainKey), !existing.isEmpty {
            return existing
        }
        let created = UUID().uuidString.lowercased()
        try keychain.set(created, for: keychainKey)
        return created
    }

    static func existing(using keychain: KeychainStore = KeychainStore()) -> String? {
        guard let value = try? keychain.string(for: keychainKey), !value.isEmpty else {
            return nil
        }
        return value
    }

    static func clear(using keychain: KeychainStore = KeychainStore()) {
        keychain.remove(keychainKey)
    }
}
