import SwiftUI

struct HistoryView: View {
    @ObservedObject var viewModel: HealthBootstrapViewModel

    var body: some View {
        NavigationStack {
            List {
                Section {
                    ProfilePicker(viewModel: viewModel)
                    Button("Refresh") {
                        Task { await refreshHistory() }
                    }
                }

                Section("Blood Pressure") {
                    if viewModel.readings.bloodPressureReadings.isEmpty {
                        EmptyRow("No blood pressure readings yet.")
                    } else {
                        ForEach(viewModel.readings.bloodPressureReadings) { reading in
                            ReadingRow(
                                title: "\(reading.systolic)/\(reading.diastolic) mmHg",
                                detail: reading.pulse.map { "Pulse \($0)" } ?? "Pulse not recorded"
                            )
                        }
                    }
                }

                Section("Diabetes") {
                    if viewModel.readings.bloodGlucoseReadings.isEmpty {
                        EmptyRow("No blood sugar readings yet.")
                    } else {
                        ForEach(viewModel.readings.bloodGlucoseReadings) { reading in
                            ReadingRow(
                                title: "\(String(format: "%.0f", reading.value)) mg/dL",
                                detail: reading.context.replacingOccurrences(of: "_", with: " ").capitalized
                            )
                        }
                    }
                }
            }
            .navigationTitle("History")
            .task {
                await viewModel.loadProfiles()
                await refreshHistory()
            }
        }
    }

    private func refreshHistory() async {
        guard viewModel.hasSelectedProfile else { return }
        await viewModel.loadBloodPressure()
        await viewModel.loadBloodGlucose()
    }
}
