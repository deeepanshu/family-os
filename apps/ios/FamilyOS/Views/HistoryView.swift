import SwiftUI

struct HistoryView: View {
    @ObservedObject var viewModel: HealthBootstrapViewModel
    @State private var filter: HistoryMetricFilter = .all

    var body: some View {
        NavigationStack {
            List {
                if days.isEmpty {
                    EmptyRow(emptyCopy)
                } else {
                    ForEach(days) { day in
                        Section(HistoryTimeline.dateTitle(localDay: day.localDay, timeZone: viewModel.historyTimeZone)) {
                            ForEach(day.items) { item in
                                ReadingRow(
                                    title: title(for: item),
                                    detail: detail(for: item)
                                )
                            }
                        }
                    }
                }
            }
            .navigationTitle("History")
            .safeAreaInset(edge: .top) {
                header
            }
            .refreshable {
                await refreshHistory()
            }
            .task {
                await viewModel.loadProfiles()
                await refreshHistory()
            }
        }
    }

    private var header: some View {
        VStack(alignment: .leading, spacing: 10) {
            if viewModel.profiles.profiles.count > 1 {
                ProfilePicker(viewModel: viewModel)
            }
            if viewModel.isViewingAnotherMember {
                Text("Looking at \(viewModel.selectedProfile?.displayName ?? "this person"). Read-only.")
                    .font(.footnote)
                    .foregroundStyle(.secondary)
            }
            Picker("Metric", selection: $filter) {
                ForEach(HistoryMetricFilter.allCases) { metric in
                    Text(metric.title).tag(metric)
                }
            }
            .pickerStyle(.segmented)
        }
        .padding(.horizontal)
        .padding(.vertical, 8)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(.bar)
    }

    private var days: [HistoryDay] {
        viewModel.historyDays(filter: filter)
    }

    private var emptyCopy: String {
        switch filter {
        case .all: return "No history yet."
        case .bloodPressure: return "No blood pressure readings yet."
        case .sleep: return "No sleep days yet."
        case .steps: return "No step days yet."
        case .workouts: return "No workouts yet."
        }
    }

    private func refreshHistory() async {
        guard viewModel.hasSelectedProfile else { return }
        await viewModel.loadHistory()
    }

    private func title(for item: HistoryItem) -> String {
        switch item {
        case let .bloodPressure(reading):
            return "\(reading.systolic)/\(reading.diastolic) mmHg"
        case let .sleep(day):
            return "Sleep \(formatMinutes(day.totalMinutes))"
        case let .steps(day):
            return "\(stepFormatter.string(from: NSNumber(value: day.count)) ?? "\(day.count)") steps"
        case let .workout(workout):
            return workout.workoutType.replacingOccurrences(of: "_", with: " ").localizedCapitalized
        }
    }

    private func detail(for item: HistoryItem) -> String? {
        switch item {
        case let .bloodPressure(reading):
            let pulse = reading.pulse.map { "Pulse \($0)" } ?? "Pulse not recorded"
            if let time = formatTime(reading.measuredAt) {
                return "\(time) · \(pulse)"
            }
            return pulse
        case let .sleep(day):
            var parts = [
                "Deep \(formatMinutes(day.deepMinutes))",
                "REM \(formatMinutes(day.remMinutes))"
            ]
            if let temp = day.wristTemperatureCelsius {
                parts.append(String(format: "Wrist %.1f°C", temp))
            }
            if let breathing = day.breathingDisturbanceCount {
                parts.append("Breathing \(breathing)")
            }
            return parts.joined(separator: " · ")
        case .steps:
            return nil
        case let .workout(workout):
            var parts: [String] = []
            if let time = formatTime(workout.startedAtUtc) {
                parts.append(time)
            }
            parts.append(formatMinutes(max(workout.durationSeconds / 60, 0)))
            if let kcal = workout.activeEnergyKcal {
                parts.append("\(Int(kcal.rounded())) kcal")
            }
            if let meters = workout.distanceMeters {
                parts.append(String(format: "%.1f km", meters / 1000))
            }
            return parts.joined(separator: " · ")
        }
    }

    private func formatMinutes(_ total: Int) -> String {
        let hours = total / 60
        let minutes = total % 60
        if hours == 0 { return "\(minutes)m" }
        if minutes == 0 { return "\(hours)h" }
        return "\(hours)h \(minutes)m"
    }

    private func formatTime(_ iso: String) -> String? {
        guard let date = HistoryTimeline.parseISO(iso) else { return nil }
        let formatter = DateFormatter()
        formatter.timeZone = viewModel.historyTimeZone
        formatter.locale = Locale(identifier: "en_US_POSIX")
        formatter.dateFormat = "HH:mm"
        return formatter.string(from: date)
    }

    private var stepFormatter: NumberFormatter {
        let formatter = NumberFormatter()
        formatter.numberStyle = .decimal
        formatter.maximumFractionDigits = 0
        return formatter
    }
}
