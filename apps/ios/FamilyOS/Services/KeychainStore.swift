import Foundation
import Security

enum KeychainStoreError: LocalizedError {
    case unexpectedStatus(OSStatus)

    var errorDescription: String? {
        switch self {
        case .unexpectedStatus(let status):
            return "Keychain operation failed with status \(status)."
        }
    }
}

/// Keychain wrapper with a UserDefaults fallback for unsigned / entitlement-limited
/// simulator builds (status -34018 `errSecMissingEntitlement`).
///
/// Production signed builds use Keychain only. Fallback is intentionally not a second
/// HealthKit authority — only tokens / installation id storage for local smoke.
struct KeychainStore {
    private let service = "com.deepanshujain.familyos"
    private let defaults = UserDefaults.standard
    private let fallbackPrefix = "familyOS.keychainFallback."

    /// errSecMissingEntitlement — common when CODE_SIGNING_ALLOWED=NO on simulator.
    private static let missingEntitlement: OSStatus = -34018

    func string(for key: String) throws -> String? {
        var query = baseQuery(for: key)
        query[kSecMatchLimit as String] = kSecMatchLimitOne
        query[kSecReturnData as String] = true

        var item: CFTypeRef?
        let status = SecItemCopyMatching(query as CFDictionary, &item)
        if status == errSecItemNotFound {
            return fallbackString(for: key)
        }
        if shouldUseFallback(status) {
            CrashReporting.log("keychain_read_fallback status=\(status) key=\(sanitizedKey(key))")
            return fallbackString(for: key)
        }
        guard status == errSecSuccess else {
            throw KeychainStoreError.unexpectedStatus(status)
        }
        guard let data = item as? Data else {
            return nil
        }
        return String(data: data, encoding: .utf8)
    }

    func set(_ value: String, for key: String) throws {
        let data = Data(value.utf8)
        var query = baseQuery(for: key)
        let attributes: [String: Any] = [kSecValueData as String: data]
        let status = SecItemUpdate(query as CFDictionary, attributes as CFDictionary)

        if status == errSecItemNotFound {
            query[kSecValueData as String] = data
            query[kSecAttrAccessible as String] = kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly
            let addStatus = SecItemAdd(query as CFDictionary, nil)
            if addStatus == errSecSuccess {
                clearFallback(for: key)
                return
            }
            if shouldUseFallback(addStatus) {
                writeFallback(value, for: key)
                CrashReporting.log("keychain_write_fallback status=\(addStatus) key=\(sanitizedKey(key))")
                return
            }
            throw KeychainStoreError.unexpectedStatus(addStatus)
        }

        if status == errSecSuccess {
            clearFallback(for: key)
            return
        }
        if shouldUseFallback(status) {
            writeFallback(value, for: key)
            CrashReporting.log("keychain_update_fallback status=\(status) key=\(sanitizedKey(key))")
            return
        }
        throw KeychainStoreError.unexpectedStatus(status)
    }

    func remove(_ key: String) {
        let query = baseQuery(for: key)
        SecItemDelete(query as CFDictionary)
        clearFallback(for: key)
    }

    private func baseQuery(for key: String) -> [String: Any] {
        [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: key
        ]
    }

    private func shouldUseFallback(_ status: OSStatus) -> Bool {
        status == Self.missingEntitlement
            || status == errSecInteractionNotAllowed
            || status == errSecNotAvailable
    }

    private func fallbackKey(_ key: String) -> String {
        fallbackPrefix + key
    }

    private func fallbackString(for key: String) -> String? {
        defaults.string(forKey: fallbackKey(key))
    }

    private func writeFallback(_ value: String, for key: String) {
        defaults.set(value, forKey: fallbackKey(key))
    }

    private func clearFallback(for key: String) {
        defaults.removeObject(forKey: fallbackKey(key))
    }

    /// Never put secrets into Crashlytics; only key name shape.
    private func sanitizedKey(_ key: String) -> String {
        if key.contains("token") || key.contains("Token") {
            return "redacted_token_key"
        }
        return String(key.prefix(64))
    }
}
