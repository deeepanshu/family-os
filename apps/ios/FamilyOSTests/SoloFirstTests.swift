import HealthKit
import XCTest
@testable import FamilyOS

@MainActor
final class SoloFirstTests: XCTestCase {
    func testHandleInviteURLStoresToken() {
        let viewModel = HealthBootstrapViewModel()
        let url = URL(string: "familyos://invite/abc123")!
        XCTAssertTrue(viewModel.handleInviteURL(url))
        XCTAssertEqual(viewModel.pendingInviteToken, "abc123")
    }

    func testHandleInviteURLWithQueryToken() {
        let viewModel = HealthBootstrapViewModel()
        let url = URL(string: "familyos://open?invite=xyz789")!
        XCTAssertTrue(viewModel.handleInviteURL(url))
        XCTAssertEqual(viewModel.pendingInviteToken, "xyz789")
    }

    func testPersonalWorkspaceFlag() {
        let viewModel = HealthBootstrapViewModel()
        viewModel.family.familyKind = .personal
        XCTAssertTrue(viewModel.family.isPersonalWorkspace)
        viewModel.family.familyKind = .family
        XCTAssertFalse(viewModel.family.isPersonalWorkspace)
    }

    func testSelfProfileReturnsSelfRelationship() {
        let viewModel = HealthBootstrapViewModel()
        viewModel.auth.signedInUserId = "user-1"
        let selfProfile = makeProfile(
            id: "p1",
            linkedUserId: "user-1",
            displayName: "Me",
            relationshipLabel: "Self"
        )
        let otherProfile = makeProfile(
            id: "p2",
            linkedUserId: nil,
            displayName: "Mom",
            relationshipLabel: "Mother"
        )
        viewModel.profiles.profiles = [selfProfile, otherProfile]
        XCTAssertEqual(viewModel.selfProfile?.id, "p1")
    }

    func testApplyBootstrapRoutesToProfileSetupWhenNoSelfProfile() {
        let viewModel = HealthBootstrapViewModel()
        let profile = makeProfile(id: "p1", linkedUserId: nil, displayName: "Mom", relationshipLabel: "Mother")
        let response = makeBootstrapResponse(
            familyId: "f1",
            kind: .personal,
            membershipUserId: "user-1",
            membershipRole: .manager,
            profiles: [profile],
            selfProfile: nil,
            needsProfileSetup: true
        )
        viewModel.applyBootstrap(response)
        XCTAssertTrue(viewModel.needsProfileSetup)
        XCTAssertEqual(viewModel.profiles.selectedProfileId, profile.id)
        XCTAssertNil(viewModel.healthKit.linkedProfileId)
    }

    func testApplyBootstrapSelectsSelfProfileAsDefault() {
        let viewModel = HealthBootstrapViewModel()
        viewModel.auth.signedInUserId = "user-1"
        let selfProfile = makeProfile(id: "p1", linkedUserId: "user-1", displayName: "Me", relationshipLabel: "Self")
        let otherProfile = makeProfile(id: "p2", linkedUserId: nil, displayName: "Mom", relationshipLabel: "Mother")
        let response = makeBootstrapResponse(
            familyId: "f1",
            kind: .personal,
            membershipUserId: "user-1",
            membershipRole: .manager,
            profiles: [selfProfile, otherProfile],
            selfProfile: selfProfile,
            needsProfileSetup: false
        )
        viewModel.applyBootstrap(response)
        XCTAssertFalse(viewModel.needsProfileSetup)
        XCTAssertEqual(viewModel.profiles.selectedProfileId, selfProfile.id)
        XCTAssertEqual(viewModel.healthKit.linkedProfileId, selfProfile.id)
    }

    func testApplyBootstrapSelectsOnlyProfileWhenNoSelfProfile() {
        let viewModel = HealthBootstrapViewModel()
        let profile = makeProfile(id: "p1", linkedUserId: nil, displayName: "Mom", relationshipLabel: "Mother")
        let response = makeBootstrapResponse(
            familyId: "f1",
            kind: .personal,
            membershipUserId: "user-1",
            membershipRole: .manager,
            profiles: [profile],
            selfProfile: nil,
            needsProfileSetup: true
        )
        viewModel.applyBootstrap(response)
        XCTAssertEqual(viewModel.profiles.selectedProfileId, profile.id)
    }

    func testProfilePickerStateHidesPickerForSingleProfile() {
        let viewModel = HealthBootstrapViewModel()
        viewModel.auth.signedInUserId = "user-1"
        let profile = makeProfile(id: "p1", linkedUserId: "user-1", displayName: "Me", relationshipLabel: "Self")
        viewModel.profiles.profiles = [profile]
        viewModel.profiles.selectedProfileId = profile.id
        XCTAssertEqual(viewModel.profiles.profiles.count, 1)
        XCTAssertEqual(viewModel.selectedProfile?.id, profile.id)
    }

    func testProfilePickerStateShowsPickerForMultipleProfiles() {
        let viewModel = HealthBootstrapViewModel()
        viewModel.auth.signedInUserId = "user-1"
        let selfProfile = makeProfile(id: "p1", linkedUserId: "user-1", displayName: "Me", relationshipLabel: "Self")
        let otherProfile = makeProfile(id: "p2", linkedUserId: nil, displayName: "Mom", relationshipLabel: "Mother")
        viewModel.profiles.profiles = [selfProfile, otherProfile]
        viewModel.profiles.selectedProfileId = selfProfile.id
        XCTAssertGreaterThan(viewModel.profiles.profiles.count, 1)
        XCTAssertEqual(viewModel.selectedProfile?.id, selfProfile.id)
    }

    func testHealthKitSyncRejectsWhenLinkedProfileIsNotSelf() async {
        let viewModel = HealthBootstrapViewModel()
        viewModel.auth.signedInUserId = "user-1"
        let selfProfile = makeProfile(id: "p1", linkedUserId: "user-1", displayName: "Me", relationshipLabel: "Self")
        let otherProfile = makeProfile(id: "p2", linkedUserId: nil, displayName: "Mom", relationshipLabel: "Mother")
        viewModel.profiles.profiles = [selfProfile, otherProfile]
        // Self profile exists, but linked HealthKit target is someone else.
        viewModel.healthKit.linkedProfileId = otherProfile.id
        viewModel.healthKit.isAvailable = true
        viewModel.healthKit.consentGranted = true
        viewModel.healthKit.enabledMetrics = [.vitals]
        await viewModel.syncHealthKitNow()
        XCTAssertTrue(viewModel.isError)
        XCTAssertEqual(viewModel.statusMessage, "HealthKit sync must target your own profile.")
    }

    func testHealthKitMetricDisplayNames() {
        XCTAssertEqual(HealthKitSyncMetric.activity.displayName, "Activity")
        XCTAssertEqual(HealthKitSyncMetric.sleep.displayName, "Sleep")
        XCTAssertEqual(HealthKitSyncMetric.vitals.displayName, "Vitals")
        // Legacy alias still points at vitals.
        XCTAssertEqual(HealthKitSyncMetric.bloodPressure, HealthKitSyncMetric.vitals)
    }

    func testConnectionMigratesRetiredPublicAPIURL() {
        let suiteName = "HealthConnectionMigrationTests-\(UUID().uuidString)"
        let defaults = UserDefaults(suiteName: suiteName)!
        defer { defaults.removePersistentDomain(forName: suiteName) }
        defaults.set("https://api.deepanshujain.me/health/v1", forKey: DefaultsKey.baseURL)

        let environment = AppEnvironment(
            name: .release,
            apiBaseURL: "https://familyos.deepanshujain.me/health/api/v1",
            supabaseURL: ""
        )
        let connection = HealthConnectionViewModel(defaults: defaults, environment: environment)

        XCTAssertEqual(connection.baseURL, environment.apiBaseURL)
        XCTAssertEqual(defaults.string(forKey: DefaultsKey.baseURL), environment.apiBaseURL)
    }

    func testConnectionPreservesCustomAPIURL() {
        let suiteName = "HealthConnectionCustomURLTests-\(UUID().uuidString)"
        let defaults = UserDefaults(suiteName: suiteName)!
        defer { defaults.removePersistentDomain(forName: suiteName) }
        let customURL = "https://staging.example.com/health/api/v1"
        defaults.set(customURL, forKey: DefaultsKey.baseURL)

        let environment = AppEnvironment(name: .release, apiBaseURL: "https://familyos.deepanshujain.me/health/api/v1", supabaseURL: "")
        let connection = HealthConnectionViewModel(defaults: defaults, environment: environment)

        XCTAssertEqual(connection.baseURL, customURL)
    }

    func testLocalEnvironmentIgnoresStickyBaseURLAndSupabase() {
        let suiteName = "HealthConnectionLocalSticky-\(UUID().uuidString)"
        let defaults = UserDefaults(suiteName: suiteName)!
        defer { defaults.removePersistentDomain(forName: suiteName) }
        defaults.set("http://localhost:3001/health/api/v1", forKey: DefaultsKey.baseURL)
        defaults.set("https://real-project.supabase.co", forKey: DefaultsKey.supabaseURL)
        defaults.set("real-anon-key", forKey: DefaultsKey.supabaseAnonKey)

        let environment = AppEnvironment(
            name: .local,
            apiBaseURL: "http://192.168.1.64:3001/health/api/v1",
            supabaseURL: "https://your-project.supabase.co",
            supabaseAnonKey: "your-supabase-anon-key"
        )
        let connection = HealthConnectionViewModel(defaults: defaults, environment: environment)

        XCTAssertEqual(connection.baseURL, environment.apiBaseURL)
        XCTAssertEqual(connection.supabaseURL, environment.supabaseURL)
        XCTAssertEqual(connection.supabaseAnonKey, environment.supabaseAnonKey)
        XCTAssertEqual(defaults.string(forKey: DefaultsKey.baseURL), environment.apiBaseURL)
    }

    func testConnectionMigratesLocalhostSavedURLOnRelease() {
        let suiteName = "HealthConnectionLocalhostMigration-\(UUID().uuidString)"
        let defaults = UserDefaults(suiteName: suiteName)!
        defer { defaults.removePersistentDomain(forName: suiteName) }
        defaults.set("http://localhost:3001/health/api/v1", forKey: DefaultsKey.baseURL)

        let environment = AppEnvironment(
            name: .release,
            apiBaseURL: "https://familyos.deepanshujain.me/health/api/v1",
            supabaseURL: ""
        )
        let connection = HealthConnectionViewModel(defaults: defaults, environment: environment)

        XCTAssertEqual(connection.baseURL, environment.apiBaseURL)
    }

    func testAccessTokenExpiryRequiresRefreshForExpiredToken() {
        let expiredToken = "eyJhbGciOiJub25lIn0.eyJleHAiOjF9.signature"
        XCTAssertTrue(AccessTokenExpiry.requiresRefresh(expiredToken, now: Date(timeIntervalSince1970: 2)))
    }

    func testAccessTokenExpiryKeepsLocalDevelopmentToken() {
        XCTAssertFalse(AccessTokenExpiry.requiresRefresh("dev-token"))
    }

    func testHealthKitVitalsAuthTypesAreBPThenPulseNotCorrelation() {
        let bp = HealthKitClient.bloodPressureReadTypes()
        let pulse = HealthKitClient.pulseReadTypes()
        let combined = HealthKitClient.readTypes(for: [.vitals])

        let systolic = HKObjectType.quantityType(forIdentifier: .bloodPressureSystolic)
        let diastolic = HKObjectType.quantityType(forIdentifier: .bloodPressureDiastolic)
        let heartRate = HKObjectType.quantityType(forIdentifier: .heartRate)
        let correlation = HKObjectType.correlationType(forIdentifier: .bloodPressure)

        XCTAssertEqual(bp.count, 2)
        XCTAssertEqual(pulse.count, 1)
        XCTAssertEqual(combined, bp.union(pulse))
        if let systolic { XCTAssertTrue(bp.contains(systolic)) }
        if let diastolic { XCTAssertTrue(bp.contains(diastolic)) }
        if let heartRate {
            XCTAssertFalse(bp.contains(heartRate))
            XCTAssertTrue(pulse.contains(heartRate))
        }
        if let correlation {
            XCTAssertFalse(bp.contains(correlation))
            XCTAssertFalse(combined.contains(correlation))
        }

        let bpIds = HealthKitClient.typeIds(bp)
        XCTAssertTrue(bpIds.contains("BloodPressureSystolic"))
        XCTAssertTrue(bpIds.contains("BloodPressureDiastolic"))
        XCTAssertFalse(bpIds.contains("HeartRate"))
    }

    func testHealthKitSleepAuthTypesIncludeSleepAnalysis() {
        let sleep = HealthKitClient.sleepReadTypes()
        let combined = HealthKitClient.readTypes(for: [.sleep])
        let both = HealthKitClient.readTypes(for: [.vitals, .sleep])

        let sleepType = HKObjectType.categoryType(forIdentifier: .sleepAnalysis)
        XCTAssertEqual(sleep.count, 1)
        XCTAssertEqual(combined, sleep)
        if let sleepType {
            XCTAssertTrue(sleep.contains(sleepType))
            XCTAssertTrue(both.contains(sleepType))
        }
        // Sleep set must not require BP correlation for auth.
        let correlation = HKObjectType.correlationType(forIdentifier: .bloodPressure)
        if let correlation {
            XCTAssertFalse(sleep.contains(correlation))
        }
        let ids = HealthKitClient.typeIds(sleep)
        XCTAssertTrue(ids.contains("SleepAnalysis"))
    }

    func testHealthKitImplementedSyncMetricsIncludeVitalsAndSleep() {
        XCTAssertEqual(
            HealthKitSyncStateViewModel.implementedSyncMetrics,
            [.vitals, .sleep]
        )
        XCTAssertTrue(HealthKitSyncStateViewModel.syncableMetrics.contains(.workouts))
        XCTAssertFalse(HealthKitSyncStateViewModel.implementedSyncMetrics.contains(.workouts))
    }

    func testHealthKitSyncNowRequiresConsentAndImplementedMetric() async {
        let viewModel = HealthBootstrapViewModel()
        viewModel.auth.signedInUserId = "user-1"
        let selfProfile = makeProfile(id: "p1", linkedUserId: "user-1", displayName: "Me", relationshipLabel: "Self")
        viewModel.profiles.profiles = [selfProfile]
        viewModel.healthKit.linkedProfileId = selfProfile.id
        viewModel.healthKit.isAvailable = true
        viewModel.healthKit.consentGranted = false
        await viewModel.syncHealthKitNow()
        XCTAssertTrue(viewModel.isError)
        XCTAssertTrue(viewModel.statusMessage.lowercased().contains("consent"))
    }

    func testHealthKitSyncNowAllowsSleepOnly() async {
        // Guard path: sleep-only enabled should not fail for "vitals consent" specifically.
        let viewModel = HealthBootstrapViewModel()
        viewModel.auth.signedInUserId = "user-1"
        let selfProfile = makeProfile(id: "p1", linkedUserId: "user-1", displayName: "Me", relationshipLabel: "Self")
        viewModel.profiles.profiles = [selfProfile]
        viewModel.healthKit.linkedProfileId = selfProfile.id
        viewModel.healthKit.isAvailable = true
        viewModel.healthKit.consentGranted = true
        viewModel.healthKit.enabledMetrics = [.sleep]
        // Will fail later on network/settings, but must pass the consent/metric gate.
        await viewModel.syncHealthKitNow()
        XCTAssertFalse(viewModel.statusMessage.lowercased().contains("vitals consent"))
        XCTAssertNotEqual(
            viewModel.statusMessage,
            "Enable HealthKit consent and at least one supported metric before syncing."
        )
    }

    func testStartupRefreshesExpiredSessionBeforeBootstrap() async {
        let viewModel = makeViewModelWithMock([
            "/auth/v1/token": """
            {"access_token":"fresh-token","refresh_token":"fresh-refresh-token","user":{"id":"user-1","email":"test@example.com"}}
            """,
            "/bootstrap": """
            {"data":{"family":{"id":"f1","name":"My Health","kind":"personal"},"membership":{"id":"m1","userId":"user-1","role":"manager","status":"active"},"profiles":[],"selfProfile":null,"needsProfileSetup":true}}
            """
        ])
        viewModel.auth.accessToken = "eyJhbGciOiJub25lIn0.eyJleHAiOjF9.signature"
        viewModel.auth.refreshToken = "expired-session-refresh-token"

        await viewModel.startup()

        XCTAssertEqual(viewModel.auth.accessToken, "fresh-token")
        XCTAssertEqual(viewModel.auth.refreshToken, "fresh-refresh-token")
        XCTAssertEqual(viewModel.family.currentFamilyName, "My Health")
        XCTAssertFalse(viewModel.isError)
    }

    func testStartupAcceptsPendingInviteBeforeBootstrap() async throws {
        let viewModel = makeViewModelWithMock([
            "/invites/invite-token/accept": """
            {"data":{"family":{"id":"f2","name":"Jain Family","kind":"family"},"membership":{"id":"m2","userId":"user-1","role":"member","status":"active"}}}
            """,
            "/bootstrap": """
            {"data":{"family":{"id":"f2","name":"Jain Family","kind":"family"},"membership":{"id":"m2","userId":"user-1","role":"member","status":"active"},"profiles":[],"selfProfile":null,"needsProfileSetup":true}}
            """
        ])
        viewModel.auth.accessToken = "token"
        viewModel.auth.signedInUserId = "user-1"
        viewModel.pendingInviteToken = "invite-token"

        await viewModel.startup()

        XCTAssertNil(viewModel.pendingInviteToken)
        XCTAssertFalse(viewModel.isStartingUp)
        XCTAssertEqual(viewModel.family.currentFamilyName, "Jain Family")
        XCTAssertTrue(viewModel.needsProfileSetup)
    }

    func testCreateSelfProfileSetsLinkedProfileIdToSelf() async throws {
        let profile = makeProfile(id: "p1", linkedUserId: "user-1", displayName: "Me", relationshipLabel: "Self")
        let viewModel = makeViewModelWithMock([
            "/me/profile": """
            {"data":{"id":"p1","linkedUserId":"user-1","displayName":"Me","relationshipLabel":"Self"}}
            """
        ])
        viewModel.auth.accessToken = "token"
        viewModel.auth.signedInUserId = "user-1"
        viewModel.family.currentFamilyName = "My Health"

        await viewModel.createSelfProfile(displayName: "Me")

        XCTAssertFalse(viewModel.needsProfileSetup)
        XCTAssertEqual(viewModel.profiles.selectedProfileId, profile.id)
        XCTAssertEqual(viewModel.healthKit.linkedProfileId, profile.id)
        XCTAssertEqual(viewModel.selfProfile?.id, profile.id)
    }
}

private func makeProfile(
    id: String,
    linkedUserId: String?,
    displayName: String,
    relationshipLabel: String?
) -> HealthProfile {
    let json = """
    {
        "id": "\(id)",
        "linkedUserId": \(linkedUserId.map { "\"\($0)\"" } ?? "null"),
        "displayName": "\(displayName)",
        "relationshipLabel": \(relationshipLabel.map { "\"\($0)\"" } ?? "null")
    }
    """.data(using: .utf8)!
    return try! JSONDecoder().decode(HealthProfile.self, from: json)
}

private func makeMembership(id: String, userId: String, role: FamilyRole, status: MembershipStatus) -> FamilyMembership {
    let json = """
    {
        "id": "\(id)",
        "userId": "\(userId)",
        "role": "\(role.rawValue)",
        "status": "\(status.rawValue)"
    }
    """.data(using: .utf8)!
    return try! JSONDecoder().decode(FamilyMembership.self, from: json)
}

private func makeBootstrapResponse(
    familyId: String,
    kind: FamilyKind,
    membershipUserId: String,
    membershipRole: FamilyRole,
    profiles: [HealthProfile],
    selfProfile: HealthProfile?,
    needsProfileSetup: Bool
) -> BootstrapResponse {
    let family = Family(id: familyId, name: "Test Family", kind: kind)
    let membership = makeMembership(id: "m1", userId: membershipUserId, role: membershipRole, status: .active)
    return BootstrapResponse(
        family: family,
        membership: membership,
        profiles: profiles,
        selfProfile: selfProfile,
        needsProfileSetup: needsProfileSetup
    )
}

private final class MockURLProtocol: URLProtocol {
    nonisolated(unsafe) static var handlers: [String: Data] = [:]

    override class func canInit(with request: URLRequest) -> Bool {
        true
    }

    override class func canonicalRequest(for request: URLRequest) -> URLRequest {
        request
    }

    override func startLoading() {
        guard let url = request.url else {
            client?.urlProtocol(self, didFailWithError: URLError(.badURL))
            return
        }
        let path = url.path
        guard let data = MockURLProtocol.handlers[path] else {
            client?.urlProtocol(self, didFailWithError: URLError(.notConnectedToInternet))
            return
        }
        let urlResponse = HTTPURLResponse(url: url, statusCode: 200, httpVersion: nil, headerFields: ["Content-Type": "application/json"])!
        client?.urlProtocol(self, didReceive: urlResponse, cacheStoragePolicy: .notAllowed)
        client?.urlProtocol(self, didLoad: data)
        client?.urlProtocolDidFinishLoading(self)
    }

    override func stopLoading() {}
}

@MainActor
private func makeViewModelWithMock(_ handlers: [String: String]) -> HealthBootstrapViewModel {
    MockURLProtocol.handlers = handlers.reduce(into: [:]) { result, entry in
        result[entry.key] = entry.value.data(using: .utf8)
    }
    let config = URLSessionConfiguration.ephemeral
    config.protocolClasses = [MockURLProtocol.self]
    let session = URLSession(configuration: config)
    let dependencies = HealthBootstrapDependencies(
        environment: AppEnvironment(name: .local, apiBaseURL: "https://test.example.com", supabaseURL: "https://test.supabase.co"),
        healthClient: HealthAPIClient(session: session),
        healthKitClient: HealthKitClient(),
        authClient: SupabaseAuthClient(session: session),
        keychain: KeychainStore(),
        defaults: UserDefaults(suiteName: nil)!
    )
    return HealthBootstrapViewModel(dependencies: dependencies)
}
