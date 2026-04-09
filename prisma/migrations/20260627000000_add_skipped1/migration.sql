-- Add skipped column to WorkoutLog table
ALTER TABLE "workout_logs"
ADD COLUMN "skipped" BOOLEAN NOT NULL DEFAULT false;
