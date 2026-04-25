-- Migration: add_nutrition_log
-- Generated for FlowFit — run this in your database directly or save as a
-- new file in prisma/migrations/[timestamp]_add_nutrition_log/migration.sql

-- CreateTable
CREATE TABLE "NutritionLog" (
    "id"        TEXT NOT NULL,
    "userId"    TEXT NOT NULL,
    "name"      TEXT NOT NULL,
    "calories"  DOUBLE PRECISION,
    "protein"   DOUBLE PRECISION,
    "carbs"     DOUBLE PRECISION,
    "fat"       DOUBLE PRECISION,
    "mealType"  TEXT NOT NULL DEFAULT 'OTHER',
    "date"      TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "NutritionLog_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "NutritionLog_userId_idx" ON "NutritionLog"("userId");

-- CreateIndex
CREATE INDEX "NutritionLog_userId_date_idx" ON "NutritionLog"("userId", "date");

-- AddForeignKey
ALTER TABLE "NutritionLog"
    ADD CONSTRAINT "NutritionLog_userId_fkey"
    FOREIGN KEY ("userId")
    REFERENCES "User"("id")
    ON DELETE CASCADE
    ON UPDATE CASCADE;
