ALTER TABLE health_workout_exercises
  DROP COLUMN IF EXISTS "catalog_id__DEPRECATED";
--> statement-breakpoint
DROP TABLE IF EXISTS "workout_exercise_catalog__DEPRECATED";
