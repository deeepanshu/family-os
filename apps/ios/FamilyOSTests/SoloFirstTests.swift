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
