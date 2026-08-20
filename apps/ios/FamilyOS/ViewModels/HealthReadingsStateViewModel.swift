import Foundation

@MainActor
final class HealthReadingsViewModel: ObservableObject {
    @Published var systolic = ""
    @Published var diastolic = ""
    @Published var pulse = ""
    @Published var bloodPressureReadings: [BloodPressureReading] = []
    @Published var sleepDays: [SleepDayReading] = []
    @Published var stepDays: [StepDayReading] = []
    @Published var workouts: [WorkoutReading] = []
    @Published var notificationRouteMessage: String?

    func clear() {
        bloodPressureReadings = []
        sleepDays = []
        stepDays = []
        workouts = []
        notificationRouteMessage = nil
    }
}
