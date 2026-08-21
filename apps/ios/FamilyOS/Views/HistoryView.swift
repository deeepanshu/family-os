import SwiftUI

struct HistoryView: View {
    @ObservedObject var viewModel: HealthBootstrapViewModel
    @State private var filter: HistoryMetricFilter = .all
    @State private var showingSleepLegend = false

    var body: some View {
        NavigationStack {
            List {
                if days.isEmpty {
                    EmptyRow(emptyCopy)
                } else {
                    ForEach(days) { day in
                        Section(HistoryTimeline.dateTitle(localDay: day.localDay, timeZone: viewModel.historyTimeZone)) {
                            ForEach(day.items) { item in
                                if case let .sleep(sleepDay) = item {
                                    ReadingRow(
                                        kicker: kicker(for: item),
                                        title: title(for: item),
                                        detail: detail(for: item),
                                        onInfo: { showingSleepLegend = true }
                                    ) {
                                        SleepStageBar(segments: HistorySleepStages.segments(sleepDay))
                                    }
                                } else {
                                    ReadingRow(
                                        kicker: kicker(for: item),
                                        title: title(for: item),
                                        detail: detail(for: item)
                                    )
                                }
                            }
                        }
                    }
                }
            }
            .navigationTitle("History")
            .sheet(isPresented: $showingSleepLegend) {
                SleepStageLegendSheet()
            }
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

    private func kicker(for item: HistoryItem) -> String {
        switch item {
        case .bloodPressure: return "Blood Pressure"
        case .sleep: return "Sleep"
        case .steps: return "Steps"
        case .workout: return "Workout"
        }
    }

    private func title(for item: HistoryItem) -> String {
        switch item {
        case let .bloodPressure(reading):
            return "\(reading.systolic)/\(reading.diastolic) mmHg"
        case let .sleep(day):
            return formatMinutes(day.totalMinutes)
        case let .steps(day):
            return stepFormatter.string(from: NSNumber(value: day.count)) ?? "\(day.count)"
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
            return HistorySleepStages.caption(day, formatMinutes: formatMinutes)
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

enum HistorySleepStages {
    struct Segment: Equatable {
        let id: String
        let minutes: Int
        let color: Color
    }

    static let coreColor = Color(red: 90 / 255, green: 200 / 255, blue: 250 / 255)
    static let deepColor = Color(red: 88 / 255, green: 86 / 255, blue: 214 / 255)
    static let remColor = Color(red: 175 / 255, green: 82 / 255, blue: 222 / 255)
    static let otherColor = Color(red: 142 / 255, green: 142 / 255, blue: 146 / 255)
    static let awakeColor = Color(red: 255 / 255, green: 159 / 255, blue: 10 / 255)

    static func segments(_ day: SleepDayReading) -> [Segment] {
        [
            Segment(id: "core", minutes: day.coreMinutes, color: coreColor),
            Segment(id: "deep", minutes: day.deepMinutes, color: deepColor),
            Segment(id: "rem", minutes: day.remMinutes, color: remColor),
            Segment(id: "other", minutes: day.unspecifiedAsleepMinutes, color: otherColor),
            Segment(id: "awake", minutes: day.awakeMinutes, color: awakeColor)
        ].filter { $0.minutes > 0 }
    }

    static func caption(_ day: SleepDayReading, formatMinutes: (Int) -> String) -> String? {
        var parts: [String] = []
        if day.deepMinutes > 0 { parts.append("Deep \(formatMinutes(day.deepMinutes))") }
        if day.remMinutes > 0 { parts.append("REM \(formatMinutes(day.remMinutes))") }
        if day.unspecifiedAsleepMinutes > 0 { parts.append("Other \(formatMinutes(day.unspecifiedAsleepMinutes))") }
        if let temp = day.wristTemperatureCelsius {
            parts.append(String(format: "Wrist %.1f°C", temp))
        }
        if let breathing = day.breathingDisturbanceCount {
            parts.append("Breathing \(breathing)")
        }
        return parts.isEmpty ? nil : parts.joined(separator: " · ")
    }
}

private struct SleepStageBar: View {
    let segments: [HistorySleepStages.Segment]

    var body: some View {
        GeometryReader { geo in
            let total = CGFloat(max(segments.reduce(0) { $0 + $1.minutes }, 1))
            HStack(spacing: 0) {
                ForEach(segments, id: \.id) { segment in
                    segment.color.frame(width: geo.size.width * CGFloat(segment.minutes) / total)
                }
            }
        }
        .frame(height: 16)
        .clipShape(Capsule())
    }
}

private struct SleepStageLegendSheet: View {
    @Environment(\.dismiss) private var dismiss

    var body: some View {
        NavigationStack {
            List {
                legendRow("Light / Core", HistorySleepStages.coreColor)
                legendRow("Deep", HistorySleepStages.deepColor)
                legendRow("REM", HistorySleepStages.remColor)
                legendRow("Other", HistorySleepStages.otherColor)
                legendRow("Awake", HistorySleepStages.awakeColor)
            }
            .navigationTitle("Sleep stages")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .confirmationAction) {
                    Button("Done") { dismiss() }
                }
            }
            .safeAreaInset(edge: .bottom) {
                Text("Stacked mix of that night — not bedtime-to-wake order. Other and Awake only show when those minutes exist.")
                    .font(.footnote)
                    .foregroundStyle(.secondary)
                    .padding()
                    .frame(maxWidth: .infinity, alignment: .leading)
            }
        }
        .presentationDetents([.medium])
    }

    private func legendRow(_ title: String, _ color: Color) -> some View {
        Label {
            Text(title)
        } icon: {
            RoundedRectangle(cornerRadius: 3)
                .fill(color)
                .frame(width: 14, height: 14)
        }
    }
}
