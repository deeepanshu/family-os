import SwiftUI

struct WorkoutExerciseLogSheet: View {
    let workout: WorkoutReading
    let canEdit: Bool
    let formatTime: (String) -> String?
    let formatMinutes: (Int) -> String
    let loadCatalog: (String?) async -> [WorkoutExerciseCatalogEntry]
    let onSave: ([WorkoutExerciseLog]) async -> Void

    @Environment(\.dismiss) private var dismiss
    @AppStorage("familyos.recentExerciseIds") private var recentIdsRaw = ""
    @State private var exercises: [DraftExercise]
    @State private var catalog: [WorkoutExerciseCatalogEntry] = []
    @State private var search = ""
    @State private var pickingFor: UUID?
    @State private var isSaving = false

    init(
        workout: WorkoutReading,
        canEdit: Bool,
        formatTime: @escaping (String) -> String?,
        formatMinutes: @escaping (Int) -> String,
        loadCatalog: @escaping (String?) async -> [WorkoutExerciseCatalogEntry],
        onSave: @escaping ([WorkoutExerciseLog]) async -> Void
    ) {
        self.workout = workout
        self.canEdit = canEdit
        self.formatTime = formatTime
        self.formatMinutes = formatMinutes
        self.loadCatalog = loadCatalog
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

                if canEdit, !recentEntries.isEmpty {
                    Section("Recent") {
                        ScrollView(.horizontal, showsIndicators: false) {
                            HStack {
                                ForEach(recentEntries) { entry in
                                    Button(entry.name) { addExercise(entry) }
                                        .buttonStyle(.bordered)
                                }
                            }
                        }
                    }
                }

                ForEach($exercises) { $exercise in
                    Section {
                        if canEdit {
                            Button {
                                pickingFor = exercise.id
                            } label: {
                                HStack {
                                    Text(exercise.name.isEmpty ? "Choose exercise" : exercise.name)
                                        .font(.headline)
                                        .foregroundStyle(exercise.name.isEmpty ? .secondary : .primary)
                                    Spacer()
                                    Image(systemName: "chevron.up.chevron.down")
                                        .foregroundStyle(.secondary)
                                }
                            }
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
                        Button("Add Exercise") { addBlankExercise() }
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
            .sheet(isPresented: Binding(
                get: { pickingFor != nil },
                set: { if !$0 { pickingFor = nil } }
            )) {
                catalogPicker
            }
            .task {
                catalog = await loadCatalog(nil)
            }
        }
        .presentationDetents([.large])
    }

    private var catalogPicker: some View {
        NavigationStack {
            List(filteredCatalog) { entry in
                Button {
                    choose(entry)
                } label: {
                    VStack(alignment: .leading, spacing: 2) {
                        Text(entry.name)
                        Text([entry.category, entry.equipment.joined(separator: ", ")].filter { !$0.isEmpty }.joined(separator: " · "))
                            .font(.footnote)
                            .foregroundStyle(.secondary)
                    }
                }
            }
            .navigationTitle("Choose exercise")
            .navigationBarTitleDisplayMode(.inline)
            .searchable(text: $search, prompt: "Search exercises")
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Cancel") { pickingFor = nil }
                }
            }
        }
        .presentationDetents([.medium, .large])
    }

    private var filteredCatalog: [WorkoutExerciseCatalogEntry] {
        let needle = search.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        guard !needle.isEmpty else { return catalog }
        return catalog.filter { $0.name.lowercased().contains(needle) }
    }

    private var metaLine: String {
        var parts: [String] = []
        if let time = formatTime(workout.startedAtUtc) { parts.append(time) }
        parts.append(formatMinutes(max(workout.durationSeconds / 60, 0)))
        return parts.joined(separator: " · ")
    }

    private var recentEntries: [WorkoutExerciseCatalogEntry] {
        recentIdsRaw.split(separator: "\u{1e}").compactMap { id in
            catalog.first { $0.id == String(id) }
        }
    }

    private func addBlankExercise() {
        let draft = DraftExercise()
        exercises.append(draft)
        pickingFor = draft.id
    }

    private func addExercise(_ entry: WorkoutExerciseCatalogEntry) {
        exercises.append(DraftExercise(exerciseId: entry.id, name: entry.name, sets: [DraftSet()]))
    }

    private func choose(_ entry: WorkoutExerciseCatalogEntry) {
        guard let target = pickingFor, let index = exercises.firstIndex(where: { $0.id == target }) else { return }
        exercises[index].exerciseId = entry.id
        exercises[index].name = entry.name
        pickingFor = nil
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
        remember(ids: payload.map(\.exerciseId))
        await onSave(payload)
        dismiss()
    }

    private func remember(ids: [String]) {
        var next = ids + recentIdsRaw.split(separator: "\u{1e}").map(String.init)
        var seen = Set<String>()
        next = next.filter { seen.insert($0).inserted }
        recentIdsRaw = next.prefix(8).joined(separator: "\u{1e}")
    }
}

private struct DraftExercise: Identifiable {
    let id: UUID
    var exerciseId: String
    var name: String
    var sets: [DraftSet]

    init(id: UUID = UUID(), exerciseId: String = "", name: String = "", sets: [DraftSet] = [DraftSet()]) {
        self.id = id
        self.exerciseId = exerciseId
        self.name = name
        self.sets = sets
    }

    init(_ log: WorkoutExerciseLog) {
        id = log.id
        exerciseId = log.exerciseId
        name = log.name
        sets = log.sets.map(DraftSet.init)
    }

    var payload: WorkoutExerciseLog? {
        guard !exerciseId.isEmpty, !name.isEmpty else { return nil }
        let sets = sets.compactMap(\.payload)
        guard !sets.isEmpty else { return nil }
        return WorkoutExerciseLog(exerciseId: exerciseId, name: name, sets: sets)
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
