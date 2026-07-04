import SwiftUI

struct LogReadingSheet: View {
    let kind: LogKind
    @ObservedObject var viewModel: HealthBootstrapViewModel
    @Environment(\.dismiss) private var dismiss

    var body: some View {
        NavigationStack {
            Form {
                Section("Profile") {
                    ProfilePicker(viewModel: viewModel)
                }

                switch kind {
                case .bloodPressure:
                    Section("Blood Pressure") {
                        TextField("Systolic", text: $viewModel.readings.systolic)
                            .keyboardType(.numberPad)
                        TextField("Diastolic", text: $viewModel.readings.diastolic)
                            .keyboardType(.numberPad)
                        TextField("Pulse (optional)", text: $viewModel.readings.pulse)
                            .keyboardType(.numberPad)
                    }
                case .bloodSugar:
                    Section("Blood Sugar") {
                        TextField("Blood sugar mg/dL", text: $viewModel.readings.glucoseValue)
                            .keyboardType(.decimalPad)
                        Picker("Context", selection: $viewModel.readings.glucoseContext) {
                            ForEach(GlucoseContext.allCases) { context in
                                Text(context.displayName).tag(context)
                            }
                        }
                    }
                }

                Section("Status") {
                    StatusText(viewModel: viewModel)
                }
            }
            .navigationTitle(kind.title)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Cancel") { dismiss() }
                }
                ToolbarItem(placement: .confirmationAction) {
                    Button("Save") {
                        Task {
                            switch kind {
                            case .bloodPressure:
                                await viewModel.createBloodPressure()
                            case .bloodSugar:
                                await viewModel.createBloodGlucose()
                            }
                            if !viewModel.isError {
                                dismiss()
                            }
                        }
                    }
                }
            }
        }
    }
}

enum LogKind: Identifiable {
    case bloodPressure
    case bloodSugar

    var id: String {
        switch self {
        case .bloodPressure:
            return "blood-pressure"
        case .bloodSugar:
            return "blood-sugar"
        }
    }

    var title: String {
        switch self {
        case .bloodPressure:
            return "Record BP"
        case .bloodSugar:
            return "Record Blood Sugar"
        }
    }
}
