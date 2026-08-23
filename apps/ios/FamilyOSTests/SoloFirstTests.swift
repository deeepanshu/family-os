import HealthKit
import XCTest
@testable import FamilyOS

@MainActor
final class SoloFirstTests: XCTestCase {
    func testFamilyOSCustomURLSchemeIsRegistered() {
        let types = Bundle(for: HealthBootstrapViewModel.self).object(forInfoDictionaryKey: "CFBundleURLTypes") as? [[String: Any]] ?? []
        let schemes = types.flatMap { $0["CFBundleURLSchemes"] as? [String] ?? [] }
        XCTAssertTrue(schemes.contains("familyos"))
    }

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

    func testHandleHTTPSInviteURLStoresToken() {
        let viewModel = HealthBootstrapViewModel()
        let url = URL(string: "https://familyos.example.com/invite/https-token-1")!
        XCTAssertTrue(viewModel.handleInviteURL(url))
        XCTAssertEqual(viewModel.pendingInviteToken, "https-token-1")
    }

    func testApplyBootstrapRestoresLiveInviteURL() {
        let viewModel = HealthBootstrapViewModel()
        viewModel.auth.signedInUserId = "user-1"
        let selfProfile = makeProfile(id: "p1", linkedUserId: "user-1", displayName: "Me", relationshipLabel: "Self")
        var response = makeBootstrapResponse(
            familyId: "f1",
            kind: .family,
            membershipUserId: "user-1",
            membershipRole: .manager,
            profiles: [selfProfile],
            selfProfile: selfProfile,
            needsProfileSetup: false
        )
        response = BootstrapResponse(
            family: response.family,
            membership: response.membership,
            creatorDisplayName: "Me",
            liveInvite: LiveInviteSummary(
                expiresAt: "2026-08-16T12:00:00.000Z",
                status: .pending,
                token: "tok",
                url: "https://familyos.example.com/invite/tok"
            ),
            profiles: response.profiles,
            selfProfile: response.selfProfile,
            needsProfileSetup: false
        )
        viewModel.applyBootstrap(response)
        XCTAssertEqual(viewModel.family.lastCreatedInviteURL, "https://familyos.example.com/invite/tok")
        XCTAssertEqual(viewModel.family.lastCreatedInviteToken, "tok")
        XCTAssertEqual(viewModel.family.creatorDisplayName, "Me")
    }

    func testCreatorSeesManageFamilyAndMembersSeeLeave() {
        let viewModel = HealthBootstrapViewModel()
        viewModel.auth.signedInUserId = "user-1"
        viewModel.family.signedInUserId = "user-1"
        viewModel.family.createdByUserId = "user-1"
        viewModel.family.currentFamilyName = "Jain Family"
        XCTAssertTrue(viewModel.family.isCreator)
        XCTAssertTrue(viewModel.family.canManageFamily)
        XCTAssertFalse(viewModel.family.canLeaveFamily)

        viewModel.auth.signedInUserId = "user-2"
        viewModel.family.signedInUserId = "user-2"
        viewModel.family.creatorRelationshipLabel = .father
        XCTAssertFalse(viewModel.family.isCreator)
        XCTAssertFalse(viewModel.family.canManageFamily)
        XCTAssertTrue(viewModel.family.canLeaveFamily)
    }

    func testLookingAtAnotherMemberIsReadOnly() {
        let viewModel = HealthBootstrapViewModel()
        viewModel.auth.signedInUserId = "user-1"
        let selfProfile = makeProfile(id: "p1", linkedUserId: "user-1", displayName: "Me", relationshipLabel: "Self")
        let other = makeProfile(id: "p2", linkedUserId: "user-2", displayName: "Riya", relationshipLabel: "Self")
        viewModel.profiles.profiles = [selfProfile, other]
        viewModel.profiles.selectedProfileId = other.id
        viewModel.healthKit.linkedProfileId = selfProfile.id
        XCTAssertTrue(viewModel.isViewingAnotherMember)
        XCTAssertFalse(viewModel.canWriteSelectedPersonHealth)
        viewModel.profiles.selectedProfileId = selfProfile.id
        XCTAssertFalse(viewModel.isViewingAnotherMember)
        XCTAssertTrue(viewModel.canWriteSelectedPersonHealth)
    }

    func testFallsBackToSelfWhenSelectedMemberLeaves() {
        let viewModel = HealthBootstrapViewModel()
        viewModel.auth.signedInUserId = "user-1"
        let selfProfile = makeProfile(id: "p1", linkedUserId: "user-1", displayName: "Me", relationshipLabel: "Self")
        let other = makeProfile(id: "p2", linkedUserId: "user-2", displayName: "Riya", relationshipLabel: "Self")
        viewModel.profiles.profiles = [selfProfile, other]
        viewModel.profiles.selectedProfileId = other.id
        viewModel.restoreSelectedPersonOrSelf()
        XCTAssertEqual(viewModel.profiles.selectedProfileId, other.id)
        viewModel.profiles.profiles = [selfProfile]
        viewModel.restoreSelectedPersonOrSelf()
        XCTAssertEqual(viewModel.profiles.selectedProfileId, selfProfile.id)
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
        await viewModel.syncAllEnabledHealthMetrics()
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

    func testHealthKitProgressBannerUsesLiveRunCopy() {
        let healthKit = HealthKitSyncStateViewModel()
        XCTAssertNil(healthKit.progressBanner)

        healthKit.beginRun(metric: .vitals, kind: .initialImport)
        XCTAssertEqual(healthKit.progressBanner?.title, "Importing Blood pressure")
        XCTAssertEqual(healthKit.progressBanner?.detail, HealthKitRunStage.preparing.displayText)

        healthKit.updateActiveRunStage(.reading)
        XCTAssertEqual(healthKit.progressBanner?.title, "Importing Blood pressure")
        XCTAssertEqual(healthKit.progressBanner?.detail, HealthKitRunStage.reading.displayText)

        healthKit.endRun(metric: .vitals)
        XCTAssertNil(healthKit.progressBanner)
    }

    func testHealthKitProgressBannerShowsSavingBeforeRunStarts() {
        let healthKit = HealthKitSyncStateViewModel()
        healthKit.isSavingSettings = true
        XCTAssertEqual(healthKit.progressBanner?.title, "Saving HealthKit settings")
        XCTAssertEqual(healthKit.progressBanner?.detail, "Updating your preferences…")

        healthKit.beginRun(metric: .sleep, kind: .sync)
        XCTAssertEqual(healthKit.progressBanner?.title, "Syncing Sleep")
        XCTAssertEqual(healthKit.progressBanner?.detail, HealthKitRunStage.preparing.displayText)
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

    func testHealthKitImplementedSyncMetricsIncludeActivityVitalsSleepAndWorkouts() {
        XCTAssertEqual(
            HealthKitSyncStateViewModel.implementedSyncMetrics,
            [.activity, .vitals, .sleep, .workouts]
        )
        let activity = HealthKitClient.readTypes(for: [.activity])
        let all = HealthKitClient.readTypes(for: [.activity, .vitals, .sleep, .workouts])
        let stepCount = HKObjectType.quantityType(forIdentifier: .stepCount)
        XCTAssertEqual(activity.count, 1)
        if let stepCount {
            XCTAssertTrue(activity.contains(stepCount))
        }
        XCTAssertTrue(all.count >= 6) // steps, BP sys/dia, HR, sleep, workout
        // Single combined set is what one-shot auth uses.
        XCTAssertEqual(all, HealthKitClient.readTypes(for: [.activity]).union(
            HealthKitClient.readTypes(for: [.vitals])
        ).union(
            HealthKitClient.readTypes(for: [.sleep])
        ).union(HealthKitClient.readTypes(for: [.workouts])))
    }

    func testHealthKitSyncAllRequiresConsentAndImplementedMetric() async {
        let viewModel = HealthBootstrapViewModel()
        viewModel.auth.signedInUserId = "user-1"
        let selfProfile = makeProfile(id: "p1", linkedUserId: "user-1", displayName: "Me", relationshipLabel: "Self")
        viewModel.profiles.profiles = [selfProfile]
        viewModel.healthKit.linkedProfileId = selfProfile.id
        viewModel.healthKit.isAvailable = true
        viewModel.healthKit.consentGranted = false
        await viewModel.syncAllEnabledHealthMetrics()
        XCTAssertTrue(viewModel.isError)
        XCTAssertTrue(viewModel.statusMessage.lowercased().contains("consent"))
    }

    func testHealthKitSyncAllAllowsSleepOnly() async {
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
        await viewModel.syncAllEnabledHealthMetrics()
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

    func testStartupKeepsPendingInviteUntilAccept() async throws {
        let viewModel = makeViewModelWithMock([
            "/invites/invite-token": """
            {"data":{"familyName":"Jain Family","creatorDisplayName":"Deepanshu","status":"pending","expiresAt":"2026-08-16T12:00:00.000Z"}}
            """,
            "/bootstrap": """
            {"data":{"family":null,"membership":null,"profiles":[],"selfProfile":null,"needsProfileSetup":true}}
            """
        ])
        viewModel.auth.accessToken = "token"
        viewModel.auth.signedInUserId = "user-1"
        viewModel.pendingInviteToken = "invite-token"

        await viewModel.startup()

        XCTAssertEqual(viewModel.pendingInviteToken, "invite-token")
        XCTAssertEqual(viewModel.pendingInvitePreview?.creatorDisplayName, "Deepanshu")
        XCTAssertTrue(viewModel.shouldShowInviteAccept)
        XCTAssertFalse(viewModel.isStartingUp)
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

    func testHistoryTimelineGroupsByLocalDayNewestFirst() {
        let bangkok = TimeZone(identifier: "Asia/Bangkok")!
        let days = HistoryTimeline.days(
            bloodPressure: [
                makeBloodPressure(id: "bp-19", systolic: 120, diastolic: 80, measuredAt: "2026-08-19T01:12:00.000Z"),
                makeBloodPressure(id: "bp-18", systolic: 118, diastolic: 76, measuredAt: "2026-08-18T14:04:00.000Z")
            ],
            sleep: [makeSleepDay(sleepDay: "2026-08-19", totalMinutes: 432)],
            steps: [StepDayReading(localDay: "2026-08-19", count: 8432)],
            workouts: [
                makeWorkout(id: "w1", startedAtUtc: "2026-08-19T00:40:00.000Z", durationSeconds: 1920)
            ],
            filter: .all,
            timeZone: bangkok
        )

        XCTAssertEqual(days.map(\.localDay), ["2026-08-19", "2026-08-18"])
        XCTAssertEqual(days[0].items.map(\.id), ["bp:bp-19", "workout:w1", "sleep:2026-08-19", "steps:2026-08-19"])
        XCTAssertEqual(days[1].items.map(\.id), ["bp:bp-18"])
    }

    func testHistoryTimelineBloodPressureFilterOmitsOtherMetrics() {
        let bangkok = TimeZone(identifier: "Asia/Bangkok")!
        let days = HistoryTimeline.days(
            bloodPressure: [
                makeBloodPressure(id: "bp-19", systolic: 120, diastolic: 80, measuredAt: "2026-08-19T01:12:00.000Z")
            ],
            sleep: [makeSleepDay(sleepDay: "2026-08-19", totalMinutes: 432)],
            steps: [StepDayReading(localDay: "2026-08-19", count: 8432)],
            workouts: [],
            filter: .bloodPressure,
            timeZone: bangkok
        )

        XCTAssertEqual(days.map(\.localDay), ["2026-08-19"])
        XCTAssertEqual(days[0].items.map(\.id), ["bp:bp-19"])
    }

    func testHistoryDateTitleUsesTodayYesterdayAndDayMonth() {
        let bangkok = TimeZone(identifier: "Asia/Bangkok")!
        let now = HistoryTimeline.parseISO("2026-08-20T10:00:00.000Z")!
        XCTAssertEqual(HistoryTimeline.dateTitle(localDay: "2026-08-20", now: now, timeZone: bangkok), "Today")
        XCTAssertEqual(HistoryTimeline.dateTitle(localDay: "2026-08-19", now: now, timeZone: bangkok), "Yesterday")
        XCTAssertEqual(HistoryTimeline.dateTitle(localDay: "2026-08-18", now: now, timeZone: bangkok), "18 Aug")
    }

    func testHistorySleepStagesOmitsZeroMinutesAndCaptionsOther() {
        let day = makeSleepDay(sleepDay: "2026-08-19", totalMinutes: 432)
        let segments = HistorySleepStages.segments(day)
        XCTAssertEqual(segments.map(\.id), ["core", "deep", "rem", "other"])
        XCTAssertEqual(segments.map(\.minutes), [240, 80, 90, 22])

        let caption = HistorySleepStages.caption(day) { minutes in
            let hours = minutes / 60
            let mins = minutes % 60
            if hours == 0 { return "\(mins)m" }
            if mins == 0 { return "\(hours)h" }
            return "\(hours)h \(mins)m"
        }
        XCTAssertEqual(caption, "Deep 1h 20m · REM 1h 30m · Other 22m")
    }


    func testLoadHistoryFillsSleepStepsAndWorkouts() async {
        let personId = "00000000-0000-4000-8000-000000000111"
        let viewModel = makeViewModelWithMock([
            "/readings/blood-pressure": """
            {"data":[{"id":"bp1","systolic":120,"diastolic":80,"pulse":72,"source":"healthkit","measuredAt":"2026-08-19T01:12:00.000Z"}]}
            """,
            "/readings/sleep": """
            {"data":[{"personId":"\(personId)","sleepDay":"2026-08-19","timezoneVersion":1,"totalMinutes":432,"coreMinutes":240,"deepMinutes":80,"remMinutes":90,"unspecifiedAsleepMinutes":22,"awakeMinutes":0,"inBedMinutes":432}]}
            """,
            "/readings/steps": """
            {"data":[{"localDay":"2026-08-19","count":8432}]}
            """,
            "/readings/workouts": """
            {"data":[{"id":"w1","workoutType":"running","startedAtUtc":"2026-08-19T00:40:00.000Z","endedAtUtc":"2026-08-19T01:12:00.000Z","durationSeconds":1920,"activeEnergyKcal":280,"distanceMeters":5000,"averageHeartRateBpm":148,"maximumHeartRateBpm":172,"minimumHeartRateBpm":112,"sourceName":"Apple Watch","isIndoor":false,"elevationAscendedMeters":42,"averageMETs":9.4}]}
            """
        ])
        viewModel.auth.accessToken = "dev-token"
        viewModel.profiles.selectedProfileId = personId

        await viewModel.loadHistory()

        XCTAssertEqual(viewModel.readings.bloodPressureReadings.map(\.id), ["bp1"])
        XCTAssertEqual(viewModel.readings.sleepDays.map(\.sleepDay), ["2026-08-19"])
        XCTAssertEqual(viewModel.readings.stepDays.map(\.count), [8432])
        XCTAssertEqual(viewModel.readings.workouts.map(\.workoutType), ["running"])
        XCTAssertEqual(viewModel.readings.workouts.first?.averageHeartRateBpm, 148)
        XCTAssertEqual(viewModel.readings.workouts.first?.isIndoor, false)
    }

    func testWorkoutHistoryCopyIncludesHeartRateAndExtras() {
        let bangkok = TimeZone(identifier: "Asia/Bangkok")!
        let workout = makeWorkout(
            id: "w1",
            startedAtUtc: "2026-08-19T00:40:00.000Z",
            durationSeconds: 1920,
            endedAtUtc: "2026-08-19T01:12:00.000Z",
            averageHeartRateBpm: 148.4,
            maximumHeartRateBpm: 172.1,
            minimumHeartRateBpm: 112,
            sourceName: "Apple Watch",
            isIndoor: false,
            elevationAscendedMeters: 42,
            averageMETs: 9.4,
            events: [WorkoutHistoryEvent(type: "lap", dateUtc: "2026-08-19T00:50:00.000Z", endDateUtc: nil)]
        )
        let presentation = HistoryItem.workout(workout).presentation(timeZone: bangkok)

        XCTAssertEqual(presentation.title, "Running")
        XCTAssertEqual(presentation.subtitle, "07:40–08:12")
        XCTAssertEqual(
            presentation.metrics,
            [
                HistoryMetricCell(label: "Time", value: "32m"),
                HistoryMetricCell(label: "Active", value: "280 kcal"),
                HistoryMetricCell(label: "Distance", value: "5.0 km"),
                HistoryMetricCell(label: "Heart rate", value: "148 bpm", detail: "112–172"),
                HistoryMetricCell(label: "Elev", value: "+42 m"),
                HistoryMetricCell(label: "METs", value: "9.4"),
                HistoryMetricCell(label: "Laps", value: "1"),
                HistoryMetricCell(label: "Place", value: "Outdoor"),
                HistoryMetricCell(label: "Source", value: "Watch")
            ]
        )
    }

    func testBloodPressureAndStepsUseMetricTitles() {
        let bangkok = TimeZone(identifier: "Asia/Bangkok")!
        let bp = HistoryItem.bloodPressure(
            makeBloodPressure(id: "bp-1", systolic: 118, diastolic: 76, measuredAt: "2026-08-19T23:48:00.000Z")
        ).presentation(timeZone: bangkok)
        let steps = HistoryItem.steps(StepDayReading(localDay: "2026-08-19", count: 8432))
            .presentation(timeZone: bangkok)

        XCTAssertEqual(bp.title, "Blood Pressure")
        XCTAssertEqual(bp.subtitle, "06:48")
        XCTAssertEqual(
            bp.metrics,
            [
                HistoryMetricCell(label: "Reading", value: "118/76 mmHg"),
                HistoryMetricCell(label: "Pulse", value: "72 bpm")
            ]
        )
        XCTAssertEqual(steps.title, "Steps")
        XCTAssertNil(steps.subtitle)
        XCTAssertEqual(steps.metrics, [HistoryMetricCell(label: "Count", value: "8,432")])
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

private func makeBloodPressure(
    id: String,
    systolic: Int,
    diastolic: Int,
    measuredAt: String,
    pulse: Int? = 72
) -> BloodPressureReading {
    BloodPressureReading(
        id: id,
        systolic: systolic,
        diastolic: diastolic,
        pulse: pulse,
        source: .healthkit,
        measuredAt: measuredAt
    )
}

private func makeSleepDay(sleepDay: String, totalMinutes: Int) -> SleepDayReading {
    SleepDayReading(
        personId: "p1",
        sleepDay: sleepDay,
        totalMinutes: totalMinutes,
        coreMinutes: 240,
        deepMinutes: 80,
        remMinutes: 90,
        unspecifiedAsleepMinutes: 22,
        awakeMinutes: 0,
        inBedMinutes: totalMinutes,
        wristTemperatureCelsius: nil,
        breathingDisturbanceCount: nil
    )
}

private func makeWorkout(
    id: String,
    startedAtUtc: String,
    durationSeconds: Int,
    endedAtUtc: String? = nil,
    activeEnergyKcal: Double? = 280,
    distanceMeters: Double? = 5000,
    averageHeartRateBpm: Double? = nil,
    maximumHeartRateBpm: Double? = nil,
    minimumHeartRateBpm: Double? = nil,
    sourceName: String? = nil,
    deviceName: String? = nil,
    isIndoor: Bool? = nil,
    elevationAscendedMeters: Double? = nil,
    averageMETs: Double? = nil,
    swimmingStrokeCount: Int? = nil,
    totalFlightsClimbed: Int? = nil,
    events: [WorkoutHistoryEvent]? = nil,
    activities: [WorkoutHistoryActivity]? = nil,
    exercises: [WorkoutExerciseLog]? = nil
) -> WorkoutReading {
    WorkoutReading(
        id: id,
        workoutType: "running",
        startedAtUtc: startedAtUtc,
        endedAtUtc: endedAtUtc ?? startedAtUtc,
        durationSeconds: durationSeconds,
        activeEnergyKcal: activeEnergyKcal,
        distanceMeters: distanceMeters,
        averageHeartRateBpm: averageHeartRateBpm,
        maximumHeartRateBpm: maximumHeartRateBpm,
        minimumHeartRateBpm: minimumHeartRateBpm,
        sourceName: sourceName,
        deviceName: deviceName,
        isIndoor: isIndoor,
        elevationAscendedMeters: elevationAscendedMeters,
        averageMETs: averageMETs,
        swimmingStrokeCount: swimmingStrokeCount,
        totalFlightsClimbed: totalFlightsClimbed,
        events: events,
        activities: activities,
        exercises: exercises
    )
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
    let family = Family(id: familyId, name: "Test Family", kind: kind, createdByUserId: membershipUserId)
    let membership = makeMembership(id: "m1", userId: membershipUserId, role: membershipRole, status: .active)
    return BootstrapResponse(
        family: family,
        membership: membership,
        creatorDisplayName: nil,
        liveInvite: nil,
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
