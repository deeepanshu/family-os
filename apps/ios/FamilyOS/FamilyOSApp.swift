import SwiftUI
import UserNotifications

@main
struct FamilyOSApp: App {
    @UIApplicationDelegateAdaptor(NotificationAppDelegate.self) private var appDelegate
    @Environment(\.scenePhase) private var scenePhase
    @StateObject private var viewModel = HealthBootstrapViewModel()

    var body: some Scene {
        WindowGroup {
            ContentView(viewModel: viewModel)
                .onAppear {
                    HealthKitBackgroundSync.setSceneActive(true)
                    if let pending = NotificationAppDelegate.pendingNotificationUserInfo {
                        NotificationAppDelegate.pendingNotificationUserInfo = nil
                        viewModel.handleNotification(userInfo: pending)
                    }
                    #if DEBUG
                    if ProcessInfo.processInfo.arguments.contains("-FamilyOSLocalSmoke") {
                        Task { await viewModel.runLocalSmokeIfRequested() }
                    }
                    #endif
                }
                .onReceive(NotificationCenter.default.publisher(for: .didOpenReminderNotification)) { notification in
                    viewModel.handleNotification(userInfo: notification.userInfo ?? [:])
                    NotificationAppDelegate.pendingNotificationUserInfo = nil
                }
                .onOpenURL { url in
                    _ = viewModel.handleInviteURL(url)
                }
                .onReceive(NotificationCenter.default.publisher(for: HealthKitRunActivity.didChange)) { _ in
                    viewModel.healthKit.applyRunActivity(HealthKitRunActivity.shared.snapshot())
                }
                .onChange(of: scenePhase, initial: true) { _, phase in
                    HealthKitBackgroundSync.setSceneActive(phase == .active)
                    if phase == .active {
                        HealthKitBackgroundSync.scheduleBackgroundSync()
                        HealthKitBackgroundSync.scheduleAppRefresh()
                        Task {
                            CrashReporting.log("healthkit_become_active_start")
                            await HealthKitBackgroundSync.runBoundedSync(reason: "become_active")
                            await HealthKitBackgroundSync.drainIfConfigured()
                            await viewModel.reloadHealthKitStatusAfterPassiveSync()
                            CrashReporting.log("healthkit_become_active_end")
                        }
                    }
                }
        }
    }
}

final class NotificationAppDelegate: NSObject, UIApplicationDelegate, @preconcurrency UNUserNotificationCenterDelegate {
    static var pendingNotificationUserInfo: [AnyHashable: Any]?

    func application(
        _ application: UIApplication,
        didFinishLaunchingWithOptions launchOptions: [UIApplication.LaunchOptionsKey: Any]? = nil
    ) -> Bool {
        CrashReporting.configure()
        _ = HealthKitSyncStore.retryPendingWipe()
        UNUserNotificationCenter.current().delegate = self
        // Nonisolated BG registration — never own handlers on a @MainActor coordinator.
        HealthKitBackgroundSync.registerBackgroundTask()
        HealthKitBackgroundSync.scheduleBackgroundSync()
        HealthKitBackgroundSync.scheduleAppRefresh()
        // Rebuild observers/delivery from the saved enabled set (plan §6.7).
        Task {
            await HealthKitBackgroundSync.reconcileFromLocalStore()
        }
        return true
    }

    func userNotificationCenter(
        _ center: UNUserNotificationCenter,
        didReceive response: UNNotificationResponse,
        withCompletionHandler completionHandler: @escaping () -> Void
    ) {
        DispatchQueue.main.async {
            let userInfo = response.notification.request.content.userInfo
            NotificationAppDelegate.pendingNotificationUserInfo = userInfo
            NotificationCenter.default.post(
                name: .didOpenReminderNotification,
                object: nil,
                userInfo: userInfo
            )
            completionHandler()
        }
    }

    func userNotificationCenter(
        _ center: UNUserNotificationCenter,
        willPresent notification: UNNotification,
        withCompletionHandler completionHandler: @escaping (UNNotificationPresentationOptions) -> Void
    ) {
        completionHandler([.banner, .sound])
    }
}

extension Notification.Name {
    static let didOpenReminderNotification = Notification.Name("FamilyOSDidOpenReminderNotification")
}
