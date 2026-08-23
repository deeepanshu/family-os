-- Stop using the wger catalog. Keep the rows under a deprecated name
-- so we do not delete contributor data in this cutover.
--> statement-breakpoint
DO $$
DECLARE
  fk_name text;
BEGIN
  SELECT c.conname INTO fk_name
  FROM pg_constraint c
  JOIN pg_class t ON t.oid = c.conrelid
  WHERE t.relname = 'health_workout_exercises'
    AND c.contype = 'f'
    AND pg_get_constraintdef(c.oid) ILIKE '%catalog_id%';
  IF fk_name IS NOT NULL THEN
    EXECUTE format('ALTER TABLE health_workout_exercises DROP CONSTRAINT %I', fk_name);
  END IF;
END $$;
--> statement-breakpoint
ALTER TABLE workout_exercise_catalog RENAME TO "workout_exercise_catalog__DEPRECATED";
--> statement-breakpoint
ALTER TABLE health_workout_exercises RENAME COLUMN catalog_id TO "catalog_id__DEPRECATED";
--> statement-breakpoint
ALTER TABLE health_workout_exercises
  ADD CONSTRAINT health_workout_exercises_catalog_id__DEPRECATED_fkey
  FOREIGN KEY ("catalog_id__DEPRECATED") REFERENCES "workout_exercise_catalog__DEPRECATED"(id);
