import SwiftUI

struct LatestReadingsSummary: View {
    @ObservedObject var viewModel: HealthBootstrapViewModel

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            Text("Latest")
                .font(.headline)

            LazyVGrid(columns: [GridItem(.flexible()), GridItem(.flexible())], spacing: 12) {
                MetricTile(
                    title: "BP",
                    value: viewModel.readings.bloodPressureReadings.first.map { "\($0.systolic)/\($0.diastolic)" } ?? "--",
                    detail: "mmHg"
                )
                MetricTile(
                    title: "Heart rate",
                    value: viewModel.readings.heartRateDays.first.flatMap { $0.averageBpm.map(String.init) } ?? "--",
                    detail: "avg bpm"
                )
                MetricTile(
                    title: "Swim",
                    value: latestSwim.map { formatMinutes(max($0.durationSeconds / 60, 0)) } ?? "--",
                    detail: swimDetail
                )
            }
        }
    }

    private var latestSwim: WorkoutReading? {
        viewModel.readings.workouts.first(where: \.isSwimmingWorkout)
    }

    private var swimDetail: String {
        guard let swim = latestSwim else { return "no session" }
        if let meters = swim.distanceMeters {
            return String(format: "%.0f m", meters)
        }
        if let strokes = swim.swimmingStrokeCount {
            return "\(strokes) strokes"
        }
        return "session"
    }

    private func formatMinutes(_ total: Int) -> String {
        let hours = total / 60
        let minutes = total % 60
        if hours == 0 { return "\(minutes)m" }
        if minutes == 0 { return "\(hours)h" }
        return "\(hours)h \(minutes)m"
    }
}
