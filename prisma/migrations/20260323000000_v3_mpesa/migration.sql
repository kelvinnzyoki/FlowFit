-- ============================================================
-- FlowFit — Prisma Migration: v3 M-Pesa + provider fields
-- File location in your repo:
--   prisma/migrations/20260323000000_v3_mpesa/migration.sql
--
-- HOW TO USE:
--   1. In your repo create the folder:
--        prisma/migrations/20260323000000_v3_mpesa/
--   2. Save THIS file inside it as:
--        migration.sql
--   3. Create/update prisma/migrations/migration_lock.toml
--      (content shown at the bottom of this file)
--   4. Commit and push — Vercel runs `prisma migrate deploy`
--      which executes this SQL exactly as written.
--
-- WHY MANUAL SQL (not auto-generated):
--   Prisma auto-generates ADD COLUMN ... NOT NULL with no DEFAULT,
--   which Postgres rejects when the table already has rows.
--   This file uses safe patterns: add nullable → backfill → optionally
--   constrain, or add with DEFAULT so existing rows are covered.
-- ============================================================


-- ============================================================
-- STEP 1 — NEW ENUM TYPES
-- Must be created before any table that references them.
-- ============================================================

-- PaymentProvider: used by Subscription and Payment models
CREATE TYPE "PaymentProvider" AS ENUM ('STRIPE', 'MPESA', 'MANUAL');

-- MpesaTransactionStatus: used by MpesaTransaction model
CREATE TYPE "MpesaTransactionStatus" AS ENUM (
    'PENDING',
    'SUCCESS',
    'FAILED',
    'CANCELLED',
    'TIMEOUT'
);


-- ============================================================
-- STEP 2 — EXTEND EXISTING ENUMS
-- PostgreSQL requires ALTER TYPE … ADD VALUE for enum extensions.
-- ADD VALUE IF NOT EXISTS prevents errors on re-runs.
-- ============================================================

-- SubscriptionStatus: add GRACE_PERIOD
ALTER TYPE "SubscriptionStatus" ADD VALUE IF NOT EXISTS 'GRACE_PERIOD';

-- SubscriptionEvent: add M-Pesa and grace period events
ALTER TYPE "SubscriptionEvent" ADD VALUE IF NOT EXISTS 'MPESA_STK_INITIATED';
ALTER TYPE "SubscriptionEvent" ADD VALUE IF NOT EXISTS 'MPESA_STK_SUCCESS';
ALTER TYPE "SubscriptionEvent" ADD VALUE IF NOT EXISTS 'MPESA_STK_FAILED';
ALTER TYPE "SubscriptionEvent" ADD VALUE IF NOT EXISTS 'MPESA_RETRY_SCHEDULED';
ALTER TYPE "SubscriptionEvent" ADD VALUE IF NOT EXISTS 'GRACE_PERIOD_STARTED';
ALTER TYPE "SubscriptionEvent" ADD VALUE IF NOT EXISTS 'GRACE_PERIOD_EXPIRED';
ALTER TYPE "SubscriptionEvent" ADD VALUE IF NOT EXISTS 'RENEWAL_REMINDER_SENT';


-- ============================================================
-- STEP 3 — ALTER TABLE: users
-- Add mpesaPhone (nullable — existing users have no M-Pesa number yet)
-- ============================================================

ALTER TABLE "users"
    ADD COLUMN IF NOT EXISTS "mpesaPhone" TEXT;


-- ============================================================
-- STEP 4 — ALTER TABLE: plans
-- Add M-Pesa price columns with DEFAULT 0 so existing plan rows
-- are valid immediately (free / Stripe-only plans default to 0).
-- ============================================================

ALTER TABLE "plans"
    ADD COLUMN IF NOT EXISTS "mpesaMonthlyKes" INTEGER NOT NULL DEFAULT 0,
    ADD COLUMN IF NOT EXISTS "mpesaYearlyKes"  INTEGER NOT NULL DEFAULT 0;


-- ============================================================
-- STEP 5 — ALTER TABLE: subscriptions
-- Safe order: add nullable / defaulted columns first,
-- then the enum columns which need the type created in Step 1.
-- ============================================================

-- provider: all existing subscriptions are Stripe — DEFAULT STRIPE covers them
ALTER TABLE "subscriptions"
    ADD COLUMN IF NOT EXISTS "provider"
        "PaymentProvider" NOT NULL DEFAULT 'STRIPE';

-- autoRenew: on by default for all existing subscriptions
ALTER TABLE "subscriptions"
    ADD COLUMN IF NOT EXISTS "autoRenew"
        BOOLEAN NOT NULL DEFAULT true;

-- mpesaRenewalAttempts: 0 for all existing rows
ALTER TABLE "subscriptions"
    ADD COLUMN IF NOT EXISTS "mpesaRenewalAttempts"
        INTEGER NOT NULL DEFAULT 0;

-- Nullable M-Pesa columns (no value for existing Stripe subs)
ALTER TABLE "subscriptions"
    ADD COLUMN IF NOT EXISTS "mpesaLastRenewalAt" TIMESTAMP(3),
    ADD COLUMN IF NOT EXISTS "gracePeriodEndsAt"  TIMESTAMP(3),
    ADD COLUMN IF NOT EXISTS "reminderSentAt"     TIMESTAMP(3);

-- Indexes for the new columns that will be queried
CREATE INDEX IF NOT EXISTS "subscriptions_provider_idx"
    ON "subscriptions"("provider");

CREATE INDEX IF NOT EXISTS "subscriptions_gracePeriodEndsAt_idx"
    ON "subscriptions"("gracePeriodEndsAt");


-- ============================================================
-- STEP 6 — ALTER TABLE: payments
-- Add provider enum column (all existing payments are Stripe).
-- Add nullable M-Pesa reference columns.
-- ============================================================

ALTER TABLE "payments"
    ADD COLUMN IF NOT EXISTS "provider"
        "PaymentProvider" NOT NULL DEFAULT 'STRIPE';

ALTER TABLE "payments"
    ADD COLUMN IF NOT EXISTS "mpesaTransactionId" TEXT,
    ADD COLUMN IF NOT EXISTS "mpesaReceiptNumber"  TEXT;

CREATE INDEX IF NOT EXISTS "payments_provider_idx"
    ON "payments"("provider");


-- ============================================================
-- STEP 7 — ALTER TABLE: webhook_events
--
-- Old schema had: stripeEventId String @unique
-- New schema has: externalId    String @unique
--                 provider      String (NOT NULL)
--
-- Root cause of build failure:
--   Prisma's pre-flight validator scans the entire migration SQL before
--   running any of it. When it sees any step that results in a NOT NULL
--   column, it checks the live row count and rejects the whole file if
--   rows exist — even if a backfill UPDATE appears later in the same file.
--
-- Fix: supply DEFAULT '' on the ADD COLUMN line itself so the validator
--   sees a safe default. Immediately overwrite with real values, then
--   drop the placeholder default so new rows must always supply a value.
-- ============================================================

-- a) Add externalId NOT NULL with temporary empty-string default.
--    Prisma's validator now sees a default and allows the step.
--    Existing 283 rows all get '' initially.
ALTER TABLE "webhook_events"
    ADD COLUMN IF NOT EXISTS "externalId" TEXT NOT NULL DEFAULT '';

-- b) Immediately overwrite the placeholder with the real value.
--    Every existing row had stripeEventId — copy it to externalId.
--    After this UPDATE no row has an empty externalId.
UPDATE "webhook_events"
   SET "externalId" = "stripeEventId"
 WHERE "stripeEventId" IS NOT NULL;

-- c) Drop the temporary default — new rows must supply externalId explicitly.
ALTER TABLE "webhook_events"
    ALTER COLUMN "externalId" DROP DEFAULT;

-- Unique index (replaces the unique index that was on stripeEventId)
DROP INDEX IF EXISTS "webhook_events_stripeEventId_key";
CREATE UNIQUE INDEX IF NOT EXISTS "webhook_events_externalId_key"
    ON "webhook_events"("externalId");

-- d) Add provider — DEFAULT 'stripe' covers all 283 existing Stripe events.
--    Prisma validator accepts this because a DEFAULT is present.
ALTER TABLE "webhook_events"
    ADD COLUMN IF NOT EXISTS "provider"
        TEXT NOT NULL DEFAULT 'stripe';

-- Drop the temporary default — new rows must supply provider explicitly.
ALTER TABLE "webhook_events"
    ALTER COLUMN "provider" DROP DEFAULT;

-- e) Drop the old stripeEventId column (data is now in externalId)
ALTER TABLE "webhook_events"
    DROP COLUMN IF EXISTS "stripeEventId";

-- Indexes
CREATE INDEX IF NOT EXISTS "webhook_events_externalId_idx"
    ON "webhook_events"("externalId");

CREATE INDEX IF NOT EXISTS "webhook_events_provider_idx"
    ON "webhook_events"("provider");


-- ============================================================
-- STEP 8 — CREATE TABLE: mpesa_transactions
--
-- phoneNumber and subscriptionId are nullable to match the schema
-- (existing rows in the DB pre-date these fields).
-- New rows from /mpesa/initiate always supply both values.
-- ============================================================

CREATE TABLE IF NOT EXISTS "mpesa_transactions" (
    "id"                TEXT        NOT NULL,
    "subscriptionId"    TEXT,                      -- nullable: legacy rows have no sub
    "userId"            TEXT        NOT NULL,
    "merchantRequestId" TEXT        NOT NULL,
    "checkoutRequestId" TEXT        NOT NULL,
    "mpesaReceiptNumber" TEXT,
    "phoneNumber"       TEXT,                      -- nullable: legacy rows have no phone
    "amountKes"         INTEGER     NOT NULL,
    "status"            "MpesaTransactionStatus" NOT NULL DEFAULT 'PENDING',
    "resultCode"        TEXT,
    "resultDesc"        TEXT,
    "attemptNumber"     INTEGER     NOT NULL DEFAULT 1,
    "isRenewal"         BOOLEAN     NOT NULL DEFAULT true,
    "initiatedAt"       TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completedAt"       TIMESTAMP(3),
    "timeoutAt"         TIMESTAMP(3),

    CONSTRAINT "mpesa_transactions_pkey" PRIMARY KEY ("id")
);

-- Unique constraints
CREATE UNIQUE INDEX IF NOT EXISTS "mpesa_transactions_merchantRequestId_key"
    ON "mpesa_transactions"("merchantRequestId");

CREATE UNIQUE INDEX IF NOT EXISTS "mpesa_transactions_checkoutRequestId_key"
    ON "mpesa_transactions"("checkoutRequestId");

CREATE UNIQUE INDEX IF NOT EXISTS "mpesa_transactions_mpesaReceiptNumber_key"
    ON "mpesa_transactions"("mpesaReceiptNumber")
    WHERE "mpesaReceiptNumber" IS NOT NULL;

-- Query indexes
CREATE INDEX IF NOT EXISTS "mpesa_transactions_subscriptionId_idx"
    ON "mpesa_transactions"("subscriptionId");

CREATE INDEX IF NOT EXISTS "mpesa_transactions_userId_idx"
    ON "mpesa_transactions"("userId");

CREATE INDEX IF NOT EXISTS "mpesa_transactions_status_idx"
    ON "mpesa_transactions"("status");

CREATE INDEX IF NOT EXISTS "mpesa_transactions_checkoutRequestId_idx"
    ON "mpesa_transactions"("checkoutRequestId");

CREATE INDEX IF NOT EXISTS "mpesa_transactions_initiatedAt_idx"
    ON "mpesa_transactions"("initiatedAt");

-- Foreign keys
ALTER TABLE "mpesa_transactions"
    ADD CONSTRAINT "mpesa_transactions_subscriptionId_fkey"
    FOREIGN KEY ("subscriptionId")
    REFERENCES "subscriptions"("id")
    ON DELETE SET NULL
    ON UPDATE CASCADE;

ALTER TABLE "mpesa_transactions"
    ADD CONSTRAINT "mpesa_transactions_userId_fkey"
    FOREIGN KEY ("userId")
    REFERENCES "users"("id")
    ON DELETE CASCADE
    ON UPDATE CASCADE;


-- ============================================================
-- STEP 9 — CREATE TABLE: cron_locks
-- Distributed lock table — prevents duplicate cron job execution
-- across concurrent Vercel function invocations.
-- ============================================================

CREATE TABLE IF NOT EXISTS "cron_locks" (
    "id"        TEXT        NOT NULL,   -- job name, e.g. "renewal-reminders"
    "lockedAt"  TIMESTAMP(3) NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "cron_locks_pkey" PRIMARY KEY ("id")
);


-- ============================================================
-- DONE
-- ============================================================


-- ============================================================
-- migration_lock.toml
-- Create this file at: prisma/migrations/migration_lock.toml
-- (if it doesn't already exist)
--
-- # Please do not edit this file manually
-- # It should be added in your version-control system (e.g., Git)
-- provider = "postgresql"
-- ============================================================
