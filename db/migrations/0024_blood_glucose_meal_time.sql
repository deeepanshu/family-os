ALTER TABLE health_blood_glucose_readings
  ADD COLUMN meal_time text;
--> statement-breakpoint
ALTER TABLE health_blood_glucose_readings
  ADD CONSTRAINT health_glucose_meal_time_check
  CHECK (meal_time IS NULL OR meal_time IN ('preprandial', 'postprandial'));
