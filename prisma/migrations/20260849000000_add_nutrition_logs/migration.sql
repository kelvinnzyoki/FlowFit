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
    REFERENCES "users"("id")
    ON DELETE CASCADE
    ON UPDATE CASCADE;
