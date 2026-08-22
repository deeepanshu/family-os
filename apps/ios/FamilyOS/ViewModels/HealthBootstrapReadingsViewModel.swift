import Foundation

extension HealthBootstrapViewModel {
    func loadBloodPressure(showsFeedback: Bool = false) async {
        await loadHistory(showsFeedback: showsFeedback)
    }

    func loadHistory(showsFeedback: Bool = false) async {
        await request(showsFeedback: showsFeedback) {
            let personId = profiles.selectedProfileId
            let window = historyDayWindow()
            async let bloodPressure = optionalList {
                try await client.listBloodPressure(
                    baseURL: connection.baseURL,
                    accessToken: auth.accessToken,
                    personId: personId
                )
            }
            async let sleep = optionalList {
                try await client.listSleepDays(
                    baseURL: connection.baseURL,
                    accessToken: auth.accessToken,
                    personId: personId,
                    from: window.from,
                    to: window.to
                )
            }
            async let steps = optionalList {
                try await client.listStepDays(
                    baseURL: connection.baseURL,
                    accessToken: auth.accessToken,
                    personId: personId,
                    from: window.from,
                    to: window.to
                )
            }
            async let workouts = optionalList {
                try await client.listWorkouts(
                    baseURL: connection.baseURL,
                    accessToken: auth.accessToken,
                    personId: personId,
                    from: window.from,
                    to: window.to
                )
            }
            let (
                bloodPressureReadings,
                sleepDays,
                stepDays,
                workoutReadings
            ) = await (bloodPressure, sleep, steps, workouts)
            if let bloodPressureReadings { readings.bloodPressureReadings = bloodPressureReadings }
            if let sleepDays { readings.sleepDays = sleepDays }
            if let stepDays { readings.stepDays = stepDays }
            if let workoutReadings { readings.workouts = workoutReadings }
            let loaded =
                readings.bloodPressureReadings.count
                + readings.sleepDays.count
                + readings.stepDays.count
                + readings.workouts.count
            return "Loaded \(loaded) history items."
        }
    }

    var historyTimeZone: TimeZone {
        TimeZone(identifier: healthKit.status?.healthTimezone ?? TimeZone.current.identifier) ?? .current
    }

    func historyDays(filter: HistoryMetricFilter) -> [HistoryDay] {
        HistoryTimeline.days(
            bloodPressure: readings.bloodPressureReadings,
            sleep: readings.sleepDays,
            steps: readings.stepDays,
            workouts: readings.workouts,
            filter: filter,
            timeZone: historyTimeZone
        )
    }

    func saveWorkoutExercises(workoutId: String, exercises: [WorkoutExerciseLog]) async {
        await request(showsFeedback: true) {
            let saved = try await client.putWorkoutExercises(
                baseURL: connection.baseURL,
                accessToken: auth.accessToken,
                workoutId: workoutId,
                exercises: exercises
            )
            if let index = readings.workouts.firstIndex(where: { $0.id == saved.id }) {
                readings.workouts[index] = saved
            }
            return exercises.isEmpty ? "Cleared workout exercises." : "Saved workout exercises."
        }
    }


    private func historyDayWindow(now: Date = Date()) -> (from: String, to: String) {
        var calendar = Calendar(identifier: .gregorian)
        calendar.timeZone = historyTimeZone
        let today = calendar.startOfDay(for: now)
        let start = calendar.date(byAdding: .day, value: -89, to: today) ?? today
        let formatter = DateFormatter()
        formatter.calendar = calendar
        formatter.timeZone = historyTimeZone
        formatter.locale = Locale(identifier: "en_US_POSIX")
        formatter.dateFormat = "yyyy-MM-dd"
        return (formatter.string(from: start), formatter.string(from: today))
    }

    private func optionalList<T>(_ work: () async throws -> [T]) async -> [T]? {
        try? await work()
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
