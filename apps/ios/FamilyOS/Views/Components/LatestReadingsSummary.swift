import SwiftUI

struct LatestReadingsSummary: View {
    @ObservedObject var viewModel: HealthBootstrapViewModel

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            Text("Latest")
                .font(.headline)

            MetricTile(
                title: "BP",
                value: viewModel.readings.bloodPressureReadings.first.map { "\($0.systolic)/\($0.diastolic)" } ?? "--",
                detail: "mmHg"
            )
        }
    }
}
