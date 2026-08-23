import SwiftUI

struct HistoryView: View {
    @ObservedObject var viewModel: HealthBootstrapViewModel
    @State private var filter: HistoryMetricFilter = .all
    @State private var showingSleepLegend = false
    @State private var selectedWorkout: WorkoutReading?


    var body: some View {
        NavigationStack {
            VStack(alignment: .leading, spacing: 10) {
                profileLine
                    .padding(.horizontal, 16)
                    .padding(.top, 8)
                Picker("Metric", selection: $filter) {
                    ForEach(HistoryMetricFilter.allCases) { metric in
                        Text(metric.title).tag(metric)
                    }
                }
                .pickerStyle(.segmented)
                .padding(.horizontal, 16)

                List {
                    if days.isEmpty {
                        EmptyRow(emptyCopy)
                    } else {
                        ForEach(days) { day in
                            Section(HistoryTimeline.dateTitle(localDay: day.localDay, timeZone: viewModel.historyTimeZone)) {
                                ForEach(day.items) { item in
                                    let presentation = item.presentation(timeZone: viewModel.historyTimeZone)
                                    if case let .sleep(sleepDay) = item {
                                        ReadingRow(
                                            presentation: presentation,
                                            onInfo: { showingSleepLegend = true }
                                        ) {
                                            SleepStageBar(segments: HistorySleepStages.segments(sleepDay))
                                        }
                                    } else if case let .workout(workout) = item, workout.isStrengthWorkout {
                                        Button {
                                            selectedWorkout = workout
                                        } label: {
                                            ReadingRow(presentation: presentation)
                                        }
                                        .buttonStyle(.plain)
                                    } else {
                                        ReadingRow(presentation: presentation)
                                    }
                                }
                            }

                        }
                    }
                }
                .listStyle(.insetGrouped)
                .scrollContentBackground(.hidden)
                .refreshable {
                    await refreshHistory()
                }
            }
            .background(Color(.systemGroupedBackground))
            .navigationBarTitleDisplayMode(.inline)
            .toolbar(.hidden, for: .navigationBar)
            .sheet(isPresented: $showingSleepLegend) {
                SleepStageLegendSheet()
            }
            .sheet(item: $selectedWorkout) { workout in
                WorkoutExerciseLogSheet(
                    workout: workout,
                    canEdit: !viewModel.isViewingAnotherMember,
                    formatTime: formatTime,
                    formatMinutes: formatMinutes,
                    loadCatalog: { query in
                        await viewModel.loadWorkoutExercises(query: query)
                    }
                ) { exercises in
                    await viewModel.saveWorkoutExercises(workoutId: workout.id, exercises: exercises)
                }
            }


            .task {
                await viewModel.loadProfiles()
                await refreshHistory()
            }
        }
    }

    private var profileLine: some View {
        Menu {
            ForEach(viewModel.profiles.profiles) { profile in
                Button(profile.displayName) {
                    viewModel.profiles.selectedProfileId = profile.id
                    Task { await refreshHistory() }
                }
            }
        } label: {
            HStack(spacing: 6) {
                Image(systemName: "chevron.up.chevron.down")
                    .font(.footnote.weight(.semibold))
                    .foregroundStyle(.secondary)
                Text(viewModel.selectedProfile?.displayName ?? "Choose profile")
                    .font(.title3.weight(.semibold))
                    .foregroundStyle(.primary)
                Spacer()
            }
        }
        .buttonStyle(.plain)
        .disabled(viewModel.profiles.profiles.count < 2)
    }

    private var days: [HistoryDay] {
        viewModel.historyDays(filter: filter)
    }

    private var emptyCopy: String {
        switch filter {
        case .all: return "No history yet."
        case .bloodPressure: return "No blood pressure readings yet."
        case .heartRate: return "No heart rate days yet."
        case .sleep: return "No sleep days yet."
        case .steps: return "No step days yet."
        case .workouts: return "No workouts yet."
        case .swimming: return "No swim workouts yet."
        }
    }

    private func refreshHistory() async {
        guard viewModel.hasSelectedProfile else { return }
        await viewModel.loadHistory()
    }


    private func formatMinutes(_ total: Int) -> String {
        HistoryTimeline.formatMinutes(total)
    }

    private func formatTime(_ iso: String) -> String? {
        HistoryTimeline.formatTime(iso, timeZone: viewModel.historyTimeZone)
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
