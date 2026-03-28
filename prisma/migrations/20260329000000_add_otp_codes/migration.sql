-- Migration: add otp_codes table
-- Place this file at:
--   prisma/migrations/20260329000000_add_otp_codes/migration.sql

CREATE TABLE IF NOT EXISTS "otp_codes" (
    "id"        TEXT         NOT NULL,
    "email"     TEXT         NOT NULL,
    "codeHash"  TEXT         NOT NULL,
    "purpose"   TEXT         NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "usedAt"    TIMESTAMP(3),

    CONSTRAINT "otp_codes_pkey" PRIMARY KEY ("id")
);

CREATE INDEX IF NOT EXISTS "otp_codes_email_idx"
    ON "otp_codes"("email");

CREATE INDEX IF NOT EXISTS "otp_codes_email_purpose_idx"
    ON "otp_codes"("email", "purpose");
