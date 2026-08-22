-- User-authored strength logs. Join HealthKit workouts by
-- (person_id, source_sample_key); never FK to health_workouts.id so a
-- repair delete+reinsert keeps the log. No workout_type on these tables:
-- later overlays (notes, splits) use the same key.
--> statement-breakpoint
CREATE TABLE health_workout_exercises (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  person_id uuid NOT NULL REFERENCES people(id) ON DELETE CASCADE,
  source_sample_key uuid NOT NULL,
  position integer NOT NULL,
  name text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT health_workout_exercises_position_check CHECK (position >= 0),
  CONSTRAINT health_workout_exercises_name_check CHECK (char_length(name) BETWEEN 1 AND 80)
);
--> statement-breakpoint
CREATE UNIQUE INDEX health_workout_exercises_person_sample_position_idx
  ON health_workout_exercises (person_id, source_sample_key, position);
--> statement-breakpoint
CREATE INDEX health_workout_exercises_person_sample_idx
  ON health_workout_exercises (person_id, source_sample_key);
--> statement-breakpoint
CREATE TABLE health_workout_sets (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  exercise_id uuid NOT NULL REFERENCES health_workout_exercises(id) ON DELETE CASCADE,
  position integer NOT NULL,
  reps integer NOT NULL,
  weight_kg numeric(6, 1),
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT health_workout_sets_position_check CHECK (position >= 0),
  CONSTRAINT health_workout_sets_reps_check CHECK (reps BETWEEN 1 AND 1000),
  CONSTRAINT health_workout_sets_weight_check
    CHECK (weight_kg IS NULL OR (weight_kg >= 0 AND weight_kg <= 1000))
);
--> statement-breakpoint
CREATE UNIQUE INDEX health_workout_sets_exercise_position_idx
  ON health_workout_sets (exercise_id, position);
--> statement-breakpoint
CREATE TRIGGER health_workout_exercises_set_updated_at
  BEFORE UPDATE ON health_workout_exercises
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
--> statement-breakpoint
ALTER TABLE health_workout_exercises ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE health_workout_sets ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY health_workout_exercises_select ON health_workout_exercises
  FOR SELECT USING (
    EXISTS (
      SELECT 1 FROM people p
      WHERE p.id = health_workout_exercises.person_id
        AND p.status = 'active'
        AND (
          p.linked_user_id = auth.uid()
          OR (p.family_id IS NOT NULL AND family_os_is_active_member(p.family_id))
        )
    )
  );
--> statement-breakpoint
CREATE POLICY health_workout_exercises_write ON health_workout_exercises
  FOR ALL USING (
    EXISTS (
      SELECT 1 FROM people p
      WHERE p.id = health_workout_exercises.person_id
        AND p.linked_user_id = auth.uid()
        AND p.relationship_label = 'Self'
        AND p.status = 'active'
    )
  ) WITH CHECK (
    EXISTS (
      SELECT 1 FROM people p
      WHERE p.id = health_workout_exercises.person_id
        AND p.linked_user_id = auth.uid()
        AND p.relationship_label = 'Self'
        AND p.status = 'active'
    )
  );
--> statement-breakpoint
CREATE POLICY health_workout_sets_select ON health_workout_sets
  FOR SELECT USING (
    EXISTS (
      SELECT 1
      FROM health_workout_exercises e
      JOIN people p ON p.id = e.person_id
      WHERE e.id = health_workout_sets.exercise_id
        AND p.status = 'active'
        AND (
          p.linked_user_id = auth.uid()
          OR (p.family_id IS NOT NULL AND family_os_is_active_member(p.family_id))
        )
    )
  );
--> statement-breakpoint
CREATE POLICY health_workout_sets_write ON health_workout_sets
  FOR ALL USING (
    EXISTS (
      SELECT 1
      FROM health_workout_exercises e
      JOIN people p ON p.id = e.person_id
      WHERE e.id = health_workout_sets.exercise_id
        AND p.linked_user_id = auth.uid()
        AND p.relationship_label = 'Self'
        AND p.status = 'active'
    )
  ) WITH CHECK (
    EXISTS (
      SELECT 1
      FROM health_workout_exercises e
      JOIN people p ON p.id = e.person_id
      WHERE e.id = health_workout_sets.exercise_id
        AND p.linked_user_id = auth.uid()
        AND p.relationship_label = 'Self'
        AND p.status = 'active'
    )
  );
