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

    func createBloodGlucose() async {
        await request {
            guard !profiles.selectedProfileId.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else {
                return "Choose a profile first."
            }
            guard let value = Double(readings.glucoseValue), (20...700).contains(value) else {
                return "Sugar must be 20-700 mg/dL."
            }
            let reading = try await client.createBloodGlucose(
                baseURL: connection.baseURL,
                accessToken: auth.accessToken,
                personId: profiles.selectedProfileId,
                value: value,
                context: readings.glucoseContext
            )
            readings.bloodGlucoseReadings.insert(reading, at: 0)
            return "Logged sugar \(reading.value) mg/dL."
        }
    }

    func loadBloodGlucose() async {
        await request {
            readings.bloodGlucoseReadings = try await client.listBloodGlucose(
                baseURL: connection.baseURL,
                accessToken: auth.accessToken,
                personId: profiles.selectedProfileId
            )
            return "Loaded \(readings.bloodGlucoseReadings.count) sugar readings."
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
            readings.notificationRouteMessage = "Opened sugar logging from reminder."
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
