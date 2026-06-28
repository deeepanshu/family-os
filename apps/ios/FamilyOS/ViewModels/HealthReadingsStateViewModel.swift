import Foundation

@MainActor
final class HealthReadingsViewModel: ObservableObject {
    @Published var systolic = ""
    @Published var diastolic = ""
    @Published var pulse = ""
    @Published var glucoseValue = ""
    @Published var glucoseContext: GlucoseContext = .fasting
    @Published var bloodPressureReadings: [BloodPressureReading] = []
    @Published var bloodGlucoseReadings: [BloodGlucoseReading] = []
    @Published var notificationRouteMessage: String?

    func clear() {
        bloodPressureReadings = []
        bloodGlucoseReadings = []
        notificationRouteMessage = nil
    }
}
