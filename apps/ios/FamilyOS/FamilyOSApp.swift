import SwiftUI
import UserNotifications

@main
struct FamilyOSApp: App {
    @UIApplicationDelegateAdaptor(NotificationAppDelegate.self) private var appDelegate
    @StateObject private var viewModel = HealthBootstrapViewModel()

    var body: some Scene {
        WindowGroup {
            ContentView(viewModel: viewModel)
                .onAppear {
                    if let pending = NotificationAppDelegate.pendingNotificationUserInfo {
                        NotificationAppDelegate.pendingNotificationUserInfo = nil
                        viewModel.handleNotification(userInfo: pending)
                    }
                }
                .onReceive(NotificationCenter.default.publisher(for: .didOpenReminderNotification)) { notification in
                    viewModel.handleNotification(userInfo: notification.userInfo ?? [:])
                    NotificationAppDelegate.pendingNotificationUserInfo = nil
                }
                .onOpenURL { url in
                    _ = viewModel.handleInviteURL(url)
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
        UNUserNotificationCenter.current().delegate = self
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
