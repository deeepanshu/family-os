import SwiftUI

struct HistoryView: View {
    @ObservedObject var viewModel: HealthBootstrapViewModel

    var body: some View {
        NavigationStack {
            List {
                Section {
                    ProfilePicker(viewModel: viewModel)
                    if viewModel.isViewingAnotherMember {
                        Text("Looking at \(viewModel.selectedProfile?.displayName ?? "this person"). History is read-only.")
                            .font(.footnote)
                            .foregroundStyle(.secondary)
                    }
                    Button("Refresh") {
                        Task { await refreshHistory(showsFeedback: true) }
                    }
                }

                Section("Blood Pressure") {
                    if viewModel.readings.bloodPressureReadings.isEmpty {
                        EmptyRow("No blood pressure readings yet.")
                    } else {
                        ForEach(viewModel.readings.bloodPressureReadings) { reading in
                            ReadingRow(
                                title: "\(reading.systolic)/\(reading.diastolic) mmHg",
                                detail: reading.pulse.map { "Pulse \($0)" } ?? "Pulse not recorded",
                                source: reading.source.displayName
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

    private func refreshHistory(showsFeedback: Bool = false) async {
        guard viewModel.hasSelectedProfile else { return }
        await viewModel.loadBloodPressure(showsFeedback: showsFeedback)
    }
}
