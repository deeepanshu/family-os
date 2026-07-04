import SwiftUI

struct LatestReadingsSummary: View {
    @ObservedObject var viewModel: HealthBootstrapViewModel

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            Text("Latest")
                .font(.headline)

            HStack(spacing: 12) {
                MetricTile(
                    title: "BP",
                    value: viewModel.readings.bloodPressureReadings.first.map { "\($0.systolic)/\($0.diastolic)" } ?? "--",
                    detail: "mmHg"
                )
                MetricTile(
                    title: "Blood Sugar",
                    value: viewModel.readings.bloodGlucoseReadings.first.map { String(format: "%.0f", $0.value) } ?? "--",
                    detail: "mg/dL"
                )
            }
        }
    }
}
