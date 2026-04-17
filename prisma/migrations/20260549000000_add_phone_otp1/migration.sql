-- ─────────────────────────────────────────────────────────────
-- 1. Add new fields to "User" table
-- ─────────────────────────────────────────────────────────────

ALTER TABLE "users"
ADD COLUMN IF NOT EXISTS "phoneVerified" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN IF NOT EXISTS "phoneVerifiedAt" TIMESTAMP;

-- ─────────────────────────────────────────────────────────────
-- 2. Create "phone_otps" table (PhoneOtp model)
-- ─────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS "phone_otps" (
  "id" TEXT PRIMARY KEY,
  "userId" TEXT NOT NULL,
  "phone" TEXT NOT NULL,
  "codeHash" TEXT NOT NULL,
  "attempts" INTEGER NOT NULL DEFAULT 0,
  "expiresAt" TIMESTAMP NOT NULL,
  "usedAt" TIMESTAMP,
  "createdAt" TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "phone_otps_userId_fkey"
    FOREIGN KEY ("userId")
    REFERENCES "User"("id")
    ON DELETE CASCADE
);

-- ─────────────────────────────────────────────────────────────
-- 3. Indexes for performance
-- ─────────────────────────────────────────────────────────────

CREATE INDEX IF NOT EXISTS "phone_otps_userId_idx"
ON "phone_otps" ("userId");

CREATE INDEX IF NOT EXISTS "phone_otps_phone_idx"
ON "phone_otps" ("phone");

CREATE INDEX IF NOT EXISTS "phone_otps_expiresAt_idx"
ON "phone_otps" ("expiresAt");

-- ─────────────────────────────────────────────────────────────
-- 4. Optional: cleanup expired OTPs (recommended for cron job)
-- ─────────────────────────────────────────────────────────────
-- DELETE FROM "phone_otps" WHERE "expiresAt" < NOW();
