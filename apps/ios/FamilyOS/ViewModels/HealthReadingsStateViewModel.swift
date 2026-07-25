import Foundation

@MainActor
final class HealthReadingsViewModel: ObservableObject {
    @Published var systolic = ""
    @Published var diastolic = ""
    @Published var pulse = ""
    @Published var bloodPressureReadings: [BloodPressureReading] = []
    @Published var notificationRouteMessage: String?

    func clear() {
        bloodPressureReadings = []
        notificationRouteMessage = nil
    }
}
