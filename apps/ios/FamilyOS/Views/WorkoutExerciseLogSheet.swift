import SwiftUI

struct WorkoutExerciseLogSheet: View {
    let workout: WorkoutReading
    let canEdit: Bool
    let formatTime: (String) -> String?
    let formatMinutes: (Int) -> String
    let onSave: ([WorkoutExerciseLog]) async -> Void

    @Environment(\.dismiss) private var dismiss
    @AppStorage("familyos.recentExerciseNames") private var recentNamesRaw = ""
    @State private var exercises: [DraftExercise]
    @State private var isSaving = false

    init(
        workout: WorkoutReading,
        canEdit: Bool,
        formatTime: @escaping (String) -> String?,
        formatMinutes: @escaping (Int) -> String,
        onSave: @escaping ([WorkoutExerciseLog]) async -> Void
    ) {
        self.workout = workout
        self.canEdit = canEdit
        self.formatTime = formatTime
        self.formatMinutes = formatMinutes
        self.onSave = onSave
        _exercises = State(initialValue: (workout.exercises ?? []).map(DraftExercise.init))
    }

    var body: some View {
        NavigationStack {
            List {
                Section {
                    Text(workout.workoutType.replacingOccurrences(of: "_", with: " ").localizedCapitalized)
                        .font(.headline)
                    Text(metaLine)
                        .font(.subheadline)
                        .foregroundStyle(.secondary)
                }

                if canEdit, !recentNames.isEmpty {
                    Section("Recent") {
                        ScrollView(.horizontal, showsIndicators: false) {
                            HStack {
                                ForEach(recentNames, id: \.self) { name in
                                    Button(name) { addExercise(named: name) }
                                        .buttonStyle(.bordered)
                                }
                            }
                        }
                    }
                }

                ForEach($exercises) { $exercise in
                    Section {
                        if canEdit {
                            TextField("Exercise name", text: $exercise.name)
                                .font(.headline)
                        } else {
                            Text(exercise.name.isEmpty ? "Untitled" : exercise.name)
                                .font(.headline)
                        }

                        HStack {
                            Text("SET").frame(width: 44, alignment: .center)
                            Text("KG").frame(maxWidth: .infinity)
                            Text("REPS").frame(maxWidth: .infinity)
                            if canEdit { Color.clear.frame(width: 28) }
                        }
                        .font(.caption.weight(.semibold))
                        .foregroundStyle(.secondary)

                        ForEach($exercise.sets) { $set in
                            HStack {
                                Text("\(exercise.sets.firstIndex(where: { $0.id == set.id }).map { $0 + 1 } ?? 1)")
                                    .frame(width: 44, alignment: .center)
                                    .foregroundStyle(.secondary)
                                TextField("—", text: $set.weightText)
                                    .keyboardType(.decimalPad)
                                    .multilineTextAlignment(.center)
                                    .disabled(!canEdit)
                                TextField("0", text: $set.repsText)
                                    .keyboardType(.numberPad)
                                    .multilineTextAlignment(.center)
                                    .disabled(!canEdit)
                                if canEdit {
                                    Button {
                                        exercise.sets.removeAll { $0.id == set.id }
                                        if exercise.sets.isEmpty {
                                            exercise.sets.append(DraftSet())
                                        }
                                    } label: {
                                        Image(systemName: "xmark.circle.fill")
                                            .foregroundStyle(.secondary)
                                    }
                                    .buttonStyle(.borderless)
                                }
                            }
                        }

                        if canEdit {
                            Button("Add Set") { addSet(to: exercise.id) }
                        }
                    }
                }

                if canEdit {
                    Section {
                        Button("Add Exercise") { addExercise(named: "") }
                        if !exercises.isEmpty {
                            Button("Clear All", role: .destructive) { exercises = [] }
                        }
                    }
                }
            }
            .navigationTitle("Exercises")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Close") { dismiss() }
                }
                if canEdit {
                    ToolbarItem(placement: .confirmationAction) {
                        Button("Save") { Task { await save() } }
                            .disabled(isSaving)
                    }
                }
            }
        }
        .presentationDetents([.large])
    }

    private var metaLine: String {
        var parts: [String] = []
        if let time = formatTime(workout.startedAtUtc) { parts.append(time) }
        parts.append(formatMinutes(max(workout.durationSeconds / 60, 0)))
        return parts.joined(separator: " · ")
    }

    private var recentNames: [String] {
        recentNamesRaw.split(separator: "\u{1e}").map(String.init).filter { !$0.isEmpty }
    }

    private func addExercise(named name: String) {
        exercises.append(DraftExercise(name: name, sets: [DraftSet()]))
    }

    private func addSet(to exerciseId: UUID) {
        guard let index = exercises.firstIndex(where: { $0.id == exerciseId }) else { return }
        let last = exercises[index].sets.last
        exercises[index].sets.append(DraftSet(weightText: last?.weightText ?? "", repsText: last?.repsText ?? ""))
    }

    private func save() async {
        isSaving = true
        defer { isSaving = false }
        let payload = exercises.compactMap(\.payload)
        remember(names: payload.map(\.name))
        await onSave(payload)
        dismiss()
    }

    private func remember(names: [String]) {
        var next = names + recentNames
        var seen = Set<String>()
        next = next.filter { seen.insert($0).inserted }
        recentNamesRaw = next.prefix(8).joined(separator: "\u{1e}")
    }
}

private struct DraftExercise: Identifiable {
    let id: UUID
    var name: String
    var sets: [DraftSet]

    init(id: UUID = UUID(), name: String = "", sets: [DraftSet] = [DraftSet()]) {
        self.id = id
        self.name = name
        self.sets = sets
    }

    init(_ log: WorkoutExerciseLog) {
        id = log.id
        name = log.name
        sets = log.sets.map(DraftSet.init)
    }

    var payload: WorkoutExerciseLog? {
        let trimmed = name.trimmingCharacters(in: .whitespacesAndNewlines)
        let sets = sets.compactMap(\.payload)
        guard !trimmed.isEmpty, !sets.isEmpty else { return nil }
        return WorkoutExerciseLog(name: trimmed, sets: sets)
    }
}

private struct DraftSet: Identifiable {
    let id: UUID
    var weightText: String
    var repsText: String

    init(id: UUID = UUID(), weightText: String = "", repsText: String = "") {
        self.id = id
        self.weightText = weightText
        self.repsText = repsText
    }

    init(_ log: WorkoutSetLog) {
        id = log.id
        weightText = log.weightKg.map { String($0) } ?? ""
        repsText = String(log.reps)
    }

    var payload: WorkoutSetLog? {
        guard let reps = Int(repsText.trimmingCharacters(in: .whitespacesAndNewlines)), reps >= 1 else {
            return nil
        }
        let trimmedWeight = weightText.trimmingCharacters(in: .whitespacesAndNewlines)
        if trimmedWeight.isEmpty {
            return WorkoutSetLog(reps: reps, weightKg: nil)
        }
        guard let weight = Double(trimmedWeight), weight >= 0, weight <= 1000 else {
            return nil
        }
        return WorkoutSetLog(reps: reps, weightKg: weight)
    }
}
