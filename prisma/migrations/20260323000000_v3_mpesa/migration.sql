-- ============================================================
-- FlowFit — Migration: v3 M-Pesa + provider fields
-- File: prisma/migrations/20260323000000_v3_mpesa/migration.sql
--
-- Run by: prisma migrate deploy (NOT prisma db push)
-- prisma db push generates its own SQL and ignores this file.
-- ============================================================


-- ============================================================
-- STEP 1 — NEW ENUM TYPES
-- DO/EXCEPTION pattern makes each CREATE TYPE idempotent.
-- ============================================================

DO $$ BEGIN
    CREATE TYPE "PaymentProvider" AS ENUM ('STRIPE', 'MPESA', 'MANUAL');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
    CREATE TYPE "MpesaTransactionStatus" AS ENUM (
        'PENDING', 'SUCCESS', 'FAILED', 'CANCELLED', 'TIMEOUT'
    );
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;


-- ============================================================
-- STEP 2 — EXTEND EXISTING ENUMS
-- ============================================================

ALTER TYPE "SubscriptionStatus"  ADD VALUE IF NOT EXISTS 'GRACE_PERIOD';

ALTER TYPE "SubscriptionEvent"   ADD VALUE IF NOT EXISTS 'MPESA_STK_INITIATED';
ALTER TYPE "SubscriptionEvent"   ADD VALUE IF NOT EXISTS 'MPESA_STK_SUCCESS';
ALTER TYPE "SubscriptionEvent"   ADD VALUE IF NOT EXISTS 'MPESA_STK_FAILED';
ALTER TYPE "SubscriptionEvent"   ADD VALUE IF NOT EXISTS 'MPESA_RETRY_SCHEDULED';
ALTER TYPE "SubscriptionEvent"   ADD VALUE IF NOT EXISTS 'GRACE_PERIOD_STARTED';
ALTER TYPE "SubscriptionEvent"   ADD VALUE IF NOT EXISTS 'GRACE_PERIOD_EXPIRED';
ALTER TYPE "SubscriptionEvent"   ADD VALUE IF NOT EXISTS 'RENEWAL_REMINDER_SENT';


-- ============================================================
-- STEP 3 — users
-- ============================================================

ALTER TABLE "users"
    ADD COLUMN IF NOT EXISTS "mpesaPhone" TEXT;


-- ============================================================
-- STEP 4 — plans
-- ============================================================

ALTER TABLE "plans"
    ADD COLUMN IF NOT EXISTS "mpesaMonthlyKes" INTEGER NOT NULL DEFAULT 0,
    ADD COLUMN IF NOT EXISTS "mpesaYearlyKes"  INTEGER NOT NULL DEFAULT 0;


-- ============================================================
-- STEP 5 — subscriptions
-- ============================================================

ALTER TABLE "subscriptions"
    ADD COLUMN IF NOT EXISTS "provider"
        "PaymentProvider" NOT NULL DEFAULT 'STRIPE';

ALTER TABLE "subscriptions"
    ADD COLUMN IF NOT EXISTS "autoRenew"
        BOOLEAN NOT NULL DEFAULT true;

ALTER TABLE "subscriptions"
    ADD COLUMN IF NOT EXISTS "mpesaRenewalAttempts"
        INTEGER NOT NULL DEFAULT 0;

ALTER TABLE "subscriptions"
    ADD COLUMN IF NOT EXISTS "mpesaLastRenewalAt" TIMESTAMP(3),
    ADD COLUMN IF NOT EXISTS "gracePeriodEndsAt"  TIMESTAMP(3),
    ADD COLUMN IF NOT EXISTS "reminderSentAt"     TIMESTAMP(3);

CREATE INDEX IF NOT EXISTS "subscriptions_provider_idx"
    ON "subscriptions"("provider");

CREATE INDEX IF NOT EXISTS "subscriptions_gracePeriodEndsAt_idx"
    ON "subscriptions"("gracePeriodEndsAt");


-- ============================================================
-- STEP 6 — payments
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
-- STEP 7 — webhook_events: stripeEventId → externalId + provider
--
-- Order is critical:
--   a) ADD COLUMN with DEFAULT '' — Prisma validator passes,
--      Postgres accepts it, 283 rows get '' temporarily.
--   b) UPDATE backfills real stripeEventId values (all unique).
--   c) DROP DEFAULT removes the placeholder.
--   d) UNIQUE INDEX created HERE — after backfill — so all 283
--      values are distinct. Creating it before step b would fail
--      because 283 rows would all have '' (duplicate violation).
--   e) provider added with DEFAULT 'stripe', then default dropped.
--   f) Old stripeEventId column dropped.
-- ============================================================

-- a) Add with temporary default
ALTER TABLE "webhook_events"
    ADD COLUMN IF NOT EXISTS "externalId" TEXT NOT NULL DEFAULT '';

-- b) Backfill from existing stripeEventId values
UPDATE "webhook_events"
   SET "externalId" = "stripeEventId"
 WHERE "stripeEventId" IS NOT NULL;

-- c) Remove the temporary default
ALTER TABLE "webhook_events"
    ALTER COLUMN "externalId" DROP DEFAULT;

-- d) Unique index AFTER backfill (values are now all distinct)
DROP INDEX IF EXISTS "webhook_events_stripeEventId_key";
CREATE UNIQUE INDEX IF NOT EXISTS "webhook_events_externalId_key"
    ON "webhook_events"("externalId");

-- e) provider column
ALTER TABLE "webhook_events"
    ADD COLUMN IF NOT EXISTS "provider" TEXT NOT NULL DEFAULT 'stripe';

ALTER TABLE "webhook_events"
    ALTER COLUMN "provider" DROP DEFAULT;

-- f) Drop old column
ALTER TABLE "webhook_events"
    DROP COLUMN IF EXISTS "stripeEventId";

CREATE INDEX IF NOT EXISTS "webhook_events_externalId_idx"
    ON "webhook_events"("externalId");

CREATE INDEX IF NOT EXISTS "webhook_events_provider_idx"
    ON "webhook_events"("provider");


-- ============================================================
-- STEP 8 — mpesa_transactions
-- ============================================================

CREATE TABLE IF NOT EXISTS "mpesa_transactions" (
    "id"                 TEXT          NOT NULL,
    "subscriptionId"     TEXT,
    "userId"             TEXT          NOT NULL,
    "merchantRequestId"  TEXT          NOT NULL,
    "checkoutRequestId"  TEXT          NOT NULL,
    "mpesaReceiptNumber" TEXT,
    "phoneNumber"        TEXT,
    "amountKes"          INTEGER       NOT NULL,
    "status"             "MpesaTransactionStatus" NOT NULL DEFAULT 'PENDING',
    "resultCode"         TEXT,
    "resultDesc"         TEXT,
    "attemptNumber"      INTEGER       NOT NULL DEFAULT 1,
    "isRenewal"          BOOLEAN       NOT NULL DEFAULT true,
    "initiatedAt"        TIMESTAMP(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completedAt"        TIMESTAMP(3),
    "timeoutAt"          TIMESTAMP(3),

    CONSTRAINT "mpesa_transactions_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "mpesa_transactions_merchantRequestId_key"
    ON "mpesa_transactions"("merchantRequestId");

CREATE UNIQUE INDEX IF NOT EXISTS "mpesa_transactions_checkoutRequestId_key"
    ON "mpesa_transactions"("checkoutRequestId");

CREATE UNIQUE INDEX IF NOT EXISTS "mpesa_transactions_mpesaReceiptNumber_key"
    ON "mpesa_transactions"("mpesaReceiptNumber")
    WHERE "mpesaReceiptNumber" IS NOT NULL;

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

ALTER TABLE "mpesa_transactions"
    ADD CONSTRAINT "mpesa_transactions_subscriptionId_fkey"
    FOREIGN KEY ("subscriptionId")
    REFERENCES "subscriptions"("id")
    ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "mpesa_transactions"
    ADD CONSTRAINT "mpesa_transactions_userId_fkey"
    FOREIGN KEY ("userId")
    REFERENCES "users"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;


-- ============================================================
-- STEP 9 — cron_locks
-- ============================================================

CREATE TABLE IF NOT EXISTS "cron_locks" (
    "id"        TEXT         NOT NULL,
    "lockedAt"  TIMESTAMP(3) NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "cron_locks_pkey" PRIMARY KEY ("id")
);
