import Foundation

extension HealthBootstrapViewModel {
    func loadBloodPressure() async {
        await request {
            readings.bloodPressureReadings = try await client.listBloodPressure(
                baseURL: connection.baseURL,
                accessToken: auth.accessToken,
                personId: profiles.selectedProfileId
            )
            return "Loaded \(readings.bloodPressureReadings.count) BP readings."
        }
    }

    func handleNotification(userInfo: [AnyHashable: Any]) {
        let action = userInfo["action"] as? String
        if let subjectPersonId = userInfo["subject_person_id"] as? String,
           !subjectPersonId.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
            profiles.selectedProfileId = subjectPersonId
        }
        switch action {
        case "open_add_blood_glucose":
            readings.notificationRouteMessage = "Open HealthKit sync to update glucose data."
            statusMessage = readings.notificationRouteMessage ?? statusMessage
        case "open_add_blood_pressure":
            readings.notificationRouteMessage = "Opened BP logging from reminder."
            statusMessage = readings.notificationRouteMessage ?? statusMessage
        case "open_reminder":
            readings.notificationRouteMessage = "Opened reminder details."
            statusMessage = readings.notificationRouteMessage ?? statusMessage
        default:
            readings.notificationRouteMessage = "Opened Family OS notification."
            statusMessage = readings.notificationRouteMessage ?? statusMessage
        }
    }
}
