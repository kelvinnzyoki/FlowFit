-- Add skipped column to WorkoutLog table
ALTER TABLE "WorkoutLog"
ADD COLUMN "skipped" BOOLEAN NOT NULL DEFAULT false;
