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
        viewModel.healthKit.linkedProfileId = otherProfile.id
        viewModel.healthKit.isAvailable = true
        await viewModel.syncHealthKitNow()
        XCTAssertTrue(viewModel.isError)
        XCTAssertEqual(viewModel.statusMessage, "HealthKit sync must target your own profile.")
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
        authClient: SupabaseAuthClient(),
        keychain: KeychainStore(),
        defaults: UserDefaults(suiteName: nil)!
    )
    return HealthBootstrapViewModel(dependencies: dependencies)
}
