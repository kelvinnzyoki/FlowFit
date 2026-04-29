-- ============================================================
-- FLOWFIT — Migration v3 (Stripe → Paystack, sanitized)
--
-- Safe to run on a DB that:
--   (a) already has the pre-Paystack schema, OR
--   (b) is a fresh empty database
--
-- Every DDL statement is idempotent:
--   • CREATE TABLE / TYPE      → IF NOT EXISTS
--   • ADD COLUMN               → IF NOT EXISTS (via ALTER)
--   • ADD CONSTRAINT / FK      → guarded with pg_constraint check
--   • ADD ENUM VALUE           → ALTER TYPE ... ADD VALUE IF NOT EXISTS
--   • ADD INDEX                → CREATE [UNIQUE] INDEX IF NOT EXISTS
--
-- Run order matters — dependencies are respected:
--   enums → users columns → new tables → plans → subscriptions
--   → payments → webhook_events → subscription_logs
--   → mpesa_transactions → remaining tables
-- ============================================================


-- ============================================================
-- STEP 0 — ENUMS
-- Must come before any table that references them.
-- ============================================================

-- BillingInterval (may already exist)
DO $$ BEGIN
  CREATE TYPE "BillingInterval" AS ENUM ('MONTHLY', 'YEARLY');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- SubscriptionStatus — add new values that may be missing
DO $$ BEGIN
  CREATE TYPE "SubscriptionStatus" AS ENUM (
    'TRIALING', 'ACTIVE', 'PAST_DUE', 'GRACE_PERIOD',
    'CANCELLED', 'EXPIRED', 'INCOMPLETE', 'INCOMPLETE_EXPIRED', 'PAUSED'
  );
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
-- Safely add values that may not exist yet on an existing enum
ALTER TYPE "SubscriptionStatus" ADD VALUE IF NOT EXISTS 'GRACE_PERIOD';
ALTER TYPE "SubscriptionStatus" ADD VALUE IF NOT EXISTS 'INCOMPLETE';
ALTER TYPE "SubscriptionStatus" ADD VALUE IF NOT EXISTS 'INCOMPLETE_EXPIRED';
ALTER TYPE "SubscriptionStatus" ADD VALUE IF NOT EXISTS 'PAUSED';

-- PaymentProvider — new enum (replaces Stripe-only assumption)
DO $$ BEGIN
  CREATE TYPE "PaymentProvider" AS ENUM ('PAYSTACK', 'MPESA', 'MANUAL');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
ALTER TYPE "PaymentProvider" ADD VALUE IF NOT EXISTS 'PAYSTACK';
ALTER TYPE "PaymentProvider" ADD VALUE IF NOT EXISTS 'MPESA';
ALTER TYPE "PaymentProvider" ADD VALUE IF NOT EXISTS 'MANUAL';

-- MpesaTransactionStatus — new enum
DO $$ BEGIN
  CREATE TYPE "MpesaTransactionStatus" AS ENUM (
    'PENDING', 'SUCCESS', 'FAILED', 'CANCELLED', 'TIMEOUT'
  );
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- SubscriptionEvent — new enum
DO $$ BEGIN
  CREATE TYPE "SubscriptionEvent" AS ENUM (
    'CREATED', 'TRIAL_STARTED', 'TRIAL_CONVERTED', 'TRIAL_EXPIRED',
    'ACTIVATED', 'PAYMENT_SUCCEEDED', 'PAYMENT_FAILED',
    'UPGRADED', 'DOWNGRADE_SCHEDULED', 'DOWNGRADE_APPLIED',
    'CANCEL_SCHEDULED', 'CANCELLED', 'REACTIVATED',
    'EXPIRED', 'REFUNDED', 'WEBHOOK_RECEIVED',
    'MPESA_STK_INITIATED', 'MPESA_STK_SUCCESS', 'MPESA_STK_FAILED',
    'MPESA_RETRY_SCHEDULED', 'GRACE_PERIOD_STARTED',
    'GRACE_PERIOD_EXPIRED', 'RENEWAL_REMINDER_SENT'
  );
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;


-- ============================================================
-- STEP 1 — users TABLE: add Paystack + phone columns
-- ============================================================

-- Replace stripeCustomerId with paystackCustomerCode
-- stripeCustomerId may or may not exist — drop it only if present
DO $$ BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'users' AND column_name = 'stripeCustomerId'
  ) THEN
    ALTER TABLE users DROP COLUMN "stripeCustomerId";
  END IF;
END $$;

ALTER TABLE users
  ADD COLUMN IF NOT EXISTS "paystackCustomerCode" TEXT,
  ADD COLUMN IF NOT EXISTS "mpesaPhone"           TEXT,
  ADD COLUMN IF NOT EXISTS "phoneVerified"        BOOLEAN      NOT NULL DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS "phoneVerifiedAt"      TIMESTAMP(3);

-- Unique index on paystackCustomerCode (nullable — multiple NULLs allowed)
CREATE UNIQUE INDEX IF NOT EXISTS "users_paystackCustomerCode_key"
  ON users ("paystackCustomerCode")
  WHERE "paystackCustomerCode" IS NOT NULL;


-- ============================================================
-- STEP 2 — phone_otps TABLE (new)
-- ============================================================

CREATE TABLE IF NOT EXISTS phone_otps (
  id          TEXT         NOT NULL PRIMARY KEY DEFAULT gen_random_uuid()::TEXT,
  "userId"    TEXT         NOT NULL,
  phone       TEXT         NOT NULL,
  "codeHash"  TEXT         NOT NULL,
  attempts    INTEGER      NOT NULL DEFAULT 0,
  "expiresAt" TIMESTAMP(3) NOT NULL,
  "usedAt"    TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT NOW()
);

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'phone_otps_userId_fkey'
  ) THEN
    ALTER TABLE phone_otps ADD CONSTRAINT "phone_otps_userId_fkey"
      FOREIGN KEY ("userId") REFERENCES users(id) ON DELETE CASCADE;
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS "phone_otps_userId_idx"    ON phone_otps ("userId");
CREATE INDEX IF NOT EXISTS "phone_otps_phone_idx"     ON phone_otps (phone);
CREATE INDEX IF NOT EXISTS "phone_otps_expiresAt_idx" ON phone_otps ("expiresAt");


-- ============================================================
-- STEP 3 — plans TABLE
-- ============================================================

CREATE TABLE IF NOT EXISTS plans (
  id                         TEXT         NOT NULL PRIMARY KEY DEFAULT gen_random_uuid()::TEXT,
  slug                       TEXT         NOT NULL,
  name                       TEXT         NOT NULL,
  description                TEXT,
  "monthlyPriceCents"        INTEGER      NOT NULL DEFAULT 0,
  "yearlyPriceCents"         INTEGER      NOT NULL DEFAULT 0,
  "mpesaMonthlyKes"          INTEGER      NOT NULL DEFAULT 0,
  "mpesaYearlyKes"           INTEGER      NOT NULL DEFAULT 0,
  "paystackPlanCodeMonthly"  TEXT,
  "paystackPlanCodeYearly"   TEXT,
  "trialDays"                INTEGER      NOT NULL DEFAULT 0,
  "maxWorkoutsPerMonth"      INTEGER,
  "maxPrograms"              INTEGER,
  "hasAdvancedAnalytics"     BOOLEAN      NOT NULL DEFAULT FALSE,
  "hasPersonalCoaching"      BOOLEAN      NOT NULL DEFAULT FALSE,
  "hasNutritionTracking"     BOOLEAN      NOT NULL DEFAULT FALSE,
  "hasOfflineAccess"         BOOLEAN      NOT NULL DEFAULT FALSE,
  features                   JSONB        NOT NULL DEFAULT '[]',
  "displayOrder"             INTEGER      NOT NULL DEFAULT 0,
  "isActive"                 BOOLEAN      NOT NULL DEFAULT TRUE,
  "isPopular"                BOOLEAN      NOT NULL DEFAULT FALSE,
  "createdAt"                TIMESTAMP(3) NOT NULL DEFAULT NOW(),
  "updatedAt"                TIMESTAMP(3) NOT NULL DEFAULT NOW()
);

-- Add any columns that may be missing on an existing plans table
-- (safe no-ops if they already exist)
ALTER TABLE plans
  ADD COLUMN IF NOT EXISTS description                TEXT,
  ADD COLUMN IF NOT EXISTS "monthlyPriceCents"        INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS "yearlyPriceCents"         INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS "mpesaMonthlyKes"          INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS "mpesaYearlyKes"           INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS "paystackPlanCodeMonthly"  TEXT,
  ADD COLUMN IF NOT EXISTS "paystackPlanCodeYearly"   TEXT,
  ADD COLUMN IF NOT EXISTS "trialDays"                INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS "maxWorkoutsPerMonth"      INTEGER,
  ADD COLUMN IF NOT EXISTS "maxPrograms"              INTEGER,
  ADD COLUMN IF NOT EXISTS "hasAdvancedAnalytics"     BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS "hasPersonalCoaching"      BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS "hasNutritionTracking"     BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS "hasOfflineAccess"         BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS features                   JSONB   NOT NULL DEFAULT '[]',
  ADD COLUMN IF NOT EXISTS "displayOrder"             INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS "isActive"                 BOOLEAN NOT NULL DEFAULT TRUE,
  ADD COLUMN IF NOT EXISTS "isPopular"                BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS "createdAt"                TIMESTAMP(3) NOT NULL DEFAULT NOW(),
  ADD COLUMN IF NOT EXISTS "updatedAt"                TIMESTAMP(3) NOT NULL DEFAULT NOW();

-- Drop old Stripe-specific columns if they exist
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.columns
    WHERE table_name = 'plans' AND column_name = 'stripePriceIdMonthly') THEN
    ALTER TABLE plans DROP COLUMN "stripePriceIdMonthly";
  END IF;
END $$;
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.columns
    WHERE table_name = 'plans' AND column_name = 'stripePriceIdYearly') THEN
    ALTER TABLE plans DROP COLUMN "stripePriceIdYearly";
  END IF;
END $$;

-- Unique indexes
CREATE UNIQUE INDEX IF NOT EXISTS plans_slug_key
  ON plans (slug);

-- Partial unique indexes — NULLs are excluded so multiple NULL plan codes are allowed
CREATE UNIQUE INDEX IF NOT EXISTS "plans_paystackPlanCodeMonthly_key"
  ON plans ("paystackPlanCodeMonthly")
  WHERE "paystackPlanCodeMonthly" IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS "plans_paystackPlanCodeYearly_key"
  ON plans ("paystackPlanCodeYearly")
  WHERE "paystackPlanCodeYearly" IS NOT NULL;


-- ============================================================
-- STEP 4 — Seed / update plans
-- Correct prices: Pro $9/mo $94/yr, Elite $12/mo $125/yr
-- ============================================================

INSERT INTO plans (
  id, slug, name, description,
  "monthlyPriceCents", "yearlyPriceCents",
  "mpesaMonthlyKes",   "mpesaYearlyKes",
  "paystackPlanCodeMonthly", "paystackPlanCodeYearly",
  "trialDays", "maxWorkoutsPerMonth", "maxPrograms",
  "hasAdvancedAnalytics", "hasPersonalCoaching",
  "hasNutritionTracking", "hasOfflineAccess",
  features, "displayOrder", "isActive", "isPopular",
  "updatedAt"
)
VALUES
  (
    gen_random_uuid()::TEXT, 'free', 'Free', 'Get started with the basics.',
    0, 0, 0, 0, NULL, NULL,
    0, 10, 1,
    FALSE, FALSE, FALSE, FALSE,
    '["Up to 10 workouts per month","1 active program","Basic progress tracking","Exercise library access"]',
    0, TRUE, FALSE, NOW()
  ),
  (
    gen_random_uuid()::TEXT, 'pro', 'Pro', 'Everything you need to crush your goals.',
    900, 9400, 1170, 12220, NULL, NULL,
    14, NULL, NULL,
    TRUE, FALSE, TRUE, FALSE,
    '["Unlimited workouts","Unlimited programs","Advanced analytics & charts","Nutrition tracking","Priority support","14-day free trial"]',
    1, TRUE, TRUE, NOW()
  ),
  (
    gen_random_uuid()::TEXT, 'elite', 'Elite', 'The complete performance platform.',
    1200, 12500, 1560, 16250, NULL, NULL,
    7, NULL, NULL,
    TRUE, TRUE, TRUE, TRUE,
    '["Everything in Pro","Personal AI coaching","Offline access & sync","Custom program builder","Body composition analysis","Dedicated account manager"]',
    2, TRUE, FALSE, NOW()
  )
ON CONFLICT (slug) DO UPDATE SET
  "monthlyPriceCents"    = EXCLUDED."monthlyPriceCents",
  "yearlyPriceCents"     = EXCLUDED."yearlyPriceCents",
  "mpesaMonthlyKes"      = EXCLUDED."mpesaMonthlyKes",
  "mpesaYearlyKes"       = EXCLUDED."mpesaYearlyKes",
  "hasAdvancedAnalytics" = EXCLUDED."hasAdvancedAnalytics",
  "hasPersonalCoaching"  = EXCLUDED."hasPersonalCoaching",
  "hasNutritionTracking" = EXCLUDED."hasNutritionTracking",
  "hasOfflineAccess"     = EXCLUDED."hasOfflineAccess",
  features               = EXCLUDED.features,
  "isActive"             = EXCLUDED."isActive",
  "isPopular"            = EXCLUDED."isPopular",
  "updatedAt"            = NOW();


-- ============================================================
-- STEP 5 — subscriptions TABLE
-- ============================================================

CREATE TABLE IF NOT EXISTS subscriptions (
  id                         TEXT                   NOT NULL PRIMARY KEY DEFAULT gen_random_uuid()::TEXT,
  "userId"                   TEXT                   NOT NULL,
  "planId"                   TEXT                   NOT NULL,
  status                     "SubscriptionStatus"   NOT NULL DEFAULT 'TRIALING',
  interval                   "BillingInterval"      NOT NULL DEFAULT 'MONTHLY',
  provider                   "PaymentProvider"      NOT NULL DEFAULT 'PAYSTACK',
  "autoRenew"                BOOLEAN                NOT NULL DEFAULT TRUE,
  "paystackSubscriptionCode" TEXT,
  "paystackEmailToken"       TEXT,
  "paystackReference"        TEXT,
  "paystackCustomerCode"     TEXT,
  "currentPeriodStart"       TIMESTAMP(3),
  "currentPeriodEnd"         TIMESTAMP(3),
  "trialStartedAt"           TIMESTAMP(3),
  "trialEndsAt"              TIMESTAMP(3),
  "cancelAtPeriodEnd"        BOOLEAN                NOT NULL DEFAULT FALSE,
  "cancelledAt"              TIMESTAMP(3),
  "cancellationReason"       TEXT,
  "scheduledPlanId"          TEXT,
  "scheduledInterval"        "BillingInterval",
  "mpesaRenewalAttempts"     INTEGER                NOT NULL DEFAULT 0,
  "mpesaLastRenewalAt"       TIMESTAMP(3),
  "gracePeriodEndsAt"        TIMESTAMP(3),
  "reminderSentAt"           TIMESTAMP(3),
  "activatedAt"              TIMESTAMP(3),
  "expiredAt"                TIMESTAMP(3),
  "createdAt"                TIMESTAMP(3)           NOT NULL DEFAULT NOW(),
  "updatedAt"                TIMESTAMP(3)           NOT NULL DEFAULT NOW()
);

-- Add any columns that may be missing on an existing subscriptions table
ALTER TABLE subscriptions
  ADD COLUMN IF NOT EXISTS provider                   "PaymentProvider" NOT NULL DEFAULT 'PAYSTACK',
  ADD COLUMN IF NOT EXISTS "autoRenew"                BOOLEAN           NOT NULL DEFAULT TRUE,
  ADD COLUMN IF NOT EXISTS "paystackSubscriptionCode" TEXT,
  ADD COLUMN IF NOT EXISTS "paystackEmailToken"       TEXT,
  ADD COLUMN IF NOT EXISTS "paystackReference"        TEXT,
  ADD COLUMN IF NOT EXISTS "paystackCustomerCode"     TEXT,
  ADD COLUMN IF NOT EXISTS "currentPeriodStart"       TIMESTAMP(3),
  ADD COLUMN IF NOT EXISTS "currentPeriodEnd"         TIMESTAMP(3),
  ADD COLUMN IF NOT EXISTS "trialStartedAt"           TIMESTAMP(3),
  ADD COLUMN IF NOT EXISTS "trialEndsAt"              TIMESTAMP(3),
  ADD COLUMN IF NOT EXISTS "cancelAtPeriodEnd"        BOOLEAN           NOT NULL DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS "cancelledAt"              TIMESTAMP(3),
  ADD COLUMN IF NOT EXISTS "cancellationReason"       TEXT,
  ADD COLUMN IF NOT EXISTS "scheduledPlanId"          TEXT,
  ADD COLUMN IF NOT EXISTS "scheduledInterval"        "BillingInterval",
  ADD COLUMN IF NOT EXISTS "mpesaRenewalAttempts"     INTEGER           NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS "mpesaLastRenewalAt"       TIMESTAMP(3),
  ADD COLUMN IF NOT EXISTS "gracePeriodEndsAt"        TIMESTAMP(3),
  ADD COLUMN IF NOT EXISTS "reminderSentAt"           TIMESTAMP(3),
  ADD COLUMN IF NOT EXISTS "activatedAt"              TIMESTAMP(3),
  ADD COLUMN IF NOT EXISTS "expiredAt"                TIMESTAMP(3),
  ADD COLUMN IF NOT EXISTS "updatedAt"                TIMESTAMP(3)      NOT NULL DEFAULT NOW();

-- Drop old Stripe columns if they exist
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.columns
    WHERE table_name = 'subscriptions' AND column_name = 'stripeSubscriptionId') THEN
    ALTER TABLE subscriptions DROP COLUMN "stripeSubscriptionId";
  END IF;
END $$;
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.columns
    WHERE table_name = 'subscriptions' AND column_name = 'stripeCheckoutSessionId') THEN
    ALTER TABLE subscriptions DROP COLUMN "stripeCheckoutSessionId";
  END IF;
END $$;

-- FKs
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'subscriptions_userId_fkey') THEN
    ALTER TABLE subscriptions ADD CONSTRAINT "subscriptions_userId_fkey"
      FOREIGN KEY ("userId") REFERENCES users(id) ON DELETE CASCADE;
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'subscriptions_planId_fkey') THEN
    ALTER TABLE subscriptions ADD CONSTRAINT "subscriptions_planId_fkey"
      FOREIGN KEY ("planId") REFERENCES plans(id);
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'subscriptions_scheduledPlanId_fkey') THEN
    ALTER TABLE subscriptions ADD CONSTRAINT "subscriptions_scheduledPlanId_fkey"
      FOREIGN KEY ("scheduledPlanId") REFERENCES plans(id) ON DELETE SET NULL;
  END IF;
END $$;

-- Partial unique index — NULL subscription codes are fine (INCOMPLETE rows have no code yet)
CREATE UNIQUE INDEX IF NOT EXISTS "subscriptions_paystackSubscriptionCode_key"
  ON subscriptions ("paystackSubscriptionCode")
  WHERE "paystackSubscriptionCode" IS NOT NULL;

CREATE INDEX IF NOT EXISTS "subscriptions_userId_idx"                   ON subscriptions ("userId");
CREATE INDEX IF NOT EXISTS "subscriptions_status_idx"                   ON subscriptions (status);
CREATE INDEX IF NOT EXISTS "subscriptions_provider_idx"                 ON subscriptions (provider);
CREATE INDEX IF NOT EXISTS "subscriptions_paystackSubscriptionCode_idx" ON subscriptions ("paystackSubscriptionCode");
CREATE INDEX IF NOT EXISTS "subscriptions_currentPeriodEnd_idx"         ON subscriptions ("currentPeriodEnd");
CREATE INDEX IF NOT EXISTS "subscriptions_gracePeriodEndsAt_idx"        ON subscriptions ("gracePeriodEndsAt");


-- ============================================================
-- STEP 6 — payments TABLE
-- Complete set of columns from schema — v2 only added 2 of 9
-- ============================================================

-- Create if it doesn't exist (fresh DB)
CREATE TABLE IF NOT EXISTS payments (
  id                   TEXT              NOT NULL PRIMARY KEY DEFAULT gen_random_uuid()::TEXT,
  "subscriptionId"     TEXT              NOT NULL,
  provider             "PaymentProvider" NOT NULL DEFAULT 'PAYSTACK',
  "paystackReference"  TEXT,
  "paidAt"             TIMESTAMP(3),
  "mpesaTransactionId" TEXT,
  "mpesaReceiptNumber" TEXT,
  "amountCents"        INTEGER           NOT NULL,
  currency             TEXT              NOT NULL DEFAULT 'KES',
  status               TEXT              NOT NULL,
  "failureMessage"     TEXT,
  "refundedAt"         TIMESTAMP(3),
  "refundAmountCents"  INTEGER,
  "createdAt"          TIMESTAMP(3)      NOT NULL DEFAULT NOW()
);

-- Add all columns that may be missing on an existing payments table
ALTER TABLE payments
  ADD COLUMN IF NOT EXISTS provider             "PaymentProvider" NOT NULL DEFAULT 'PAYSTACK',
  ADD COLUMN IF NOT EXISTS "paystackReference"  TEXT,
  ADD COLUMN IF NOT EXISTS "paidAt"             TIMESTAMP(3),
  ADD COLUMN IF NOT EXISTS "mpesaTransactionId" TEXT,
  ADD COLUMN IF NOT EXISTS "mpesaReceiptNumber" TEXT,
  ADD COLUMN IF NOT EXISTS currency             TEXT              NOT NULL DEFAULT 'KES',
  ADD COLUMN IF NOT EXISTS "failureMessage"     TEXT,
  ADD COLUMN IF NOT EXISTS "refundedAt"         TIMESTAMP(3),
  ADD COLUMN IF NOT EXISTS "refundAmountCents"  INTEGER;

-- Drop old Stripe columns if they exist
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.columns
    WHERE table_name = 'payments' AND column_name = 'stripePaymentIntentId') THEN
    ALTER TABLE payments DROP COLUMN "stripePaymentIntentId";
  END IF;
END $$;
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.columns
    WHERE table_name = 'payments' AND column_name = 'stripeChargeId') THEN
    ALTER TABLE payments DROP COLUMN "stripeChargeId";
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'payments_subscriptionId_fkey') THEN
    ALTER TABLE payments ADD CONSTRAINT "payments_subscriptionId_fkey"
      FOREIGN KEY ("subscriptionId") REFERENCES subscriptions(id) ON DELETE CASCADE;
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS "payments_subscriptionId_idx"    ON payments ("subscriptionId");
CREATE INDEX IF NOT EXISTS "payments_provider_idx"          ON payments (provider);
CREATE INDEX IF NOT EXISTS "payments_status_idx"            ON payments (status);
CREATE INDEX IF NOT EXISTS "payments_paystackReference_idx" ON payments ("paystackReference");


-- ============================================================
-- STEP 7 — subscription_logs TABLE
-- Referenced by FKs elsewhere but never created in v2
-- ============================================================

CREATE TABLE IF NOT EXISTS subscription_logs (
  id               TEXT                  NOT NULL PRIMARY KEY DEFAULT gen_random_uuid()::TEXT,
  "subscriptionId" TEXT                  NOT NULL,
  event            "SubscriptionEvent"   NOT NULL,
  "previousStatus" "SubscriptionStatus",
  "newStatus"      "SubscriptionStatus",
  metadata         JSONB,
  "ipAddress"      TEXT,
  "createdAt"      TIMESTAMP(3)          NOT NULL DEFAULT NOW()
);

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'subscription_logs_subscriptionId_fkey') THEN
    ALTER TABLE subscription_logs ADD CONSTRAINT "subscription_logs_subscriptionId_fkey"
      FOREIGN KEY ("subscriptionId") REFERENCES subscriptions(id) ON DELETE CASCADE;
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS "subscription_logs_subscriptionId_idx" ON subscription_logs ("subscriptionId");
CREATE INDEX IF NOT EXISTS "subscription_logs_event_idx"          ON subscription_logs (event);
CREATE INDEX IF NOT EXISTS "subscription_logs_createdAt_idx"      ON subscription_logs ("createdAt");


-- ============================================================
-- STEP 8 — webhook_events TABLE
-- BUG FIX: externalId must be nullable, not NOT NULL DEFAULT ''.
-- Adding NOT NULL with DEFAULT '' means every existing row gets
-- the same value '', which immediately violates the unique index.
-- PostgreSQL unique indexes correctly allow multiple NULLs.
-- ============================================================

CREATE TABLE IF NOT EXISTS webhook_events (
  id               TEXT         NOT NULL PRIMARY KEY DEFAULT gen_random_uuid()::TEXT,
  "externalId"     TEXT,           -- nullable: PostgreSQL unique index allows multiple NULLs
  "eventType"      TEXT         NOT NULL DEFAULT 'unknown',
  "processedAt"    TIMESTAMP(3) NOT NULL DEFAULT NOW(),
  "responseStatus" INTEGER      NOT NULL DEFAULT 200
);

-- Add columns to existing table — externalId stays nullable intentionally
ALTER TABLE webhook_events
  ADD COLUMN IF NOT EXISTS "externalId"     TEXT,
  ADD COLUMN IF NOT EXISTS "eventType"      TEXT         NOT NULL DEFAULT 'unknown',
  ADD COLUMN IF NOT EXISTS "processedAt"    TIMESTAMP(3) NOT NULL DEFAULT NOW(),
  ADD COLUMN IF NOT EXISTS "responseStatus" INTEGER      NOT NULL DEFAULT 200;

-- Unique index on non-null externalId values only
-- This correctly handles: existing NULL rows (no conflict) + new unique Paystack event IDs
CREATE UNIQUE INDEX IF NOT EXISTS "webhook_events_externalId_key"
  ON webhook_events ("externalId")
  WHERE "externalId" IS NOT NULL;

CREATE INDEX IF NOT EXISTS "webhook_events_processedAt_idx" ON webhook_events ("processedAt");
CREATE INDEX IF NOT EXISTS "webhook_events_eventType_idx"   ON webhook_events ("eventType");


-- ============================================================
-- STEP 9 — mpesa_transactions TABLE
-- ============================================================

CREATE TABLE IF NOT EXISTS mpesa_transactions (
  id                    TEXT                     NOT NULL PRIMARY KEY DEFAULT gen_random_uuid()::TEXT,
  "subscriptionId"      TEXT,                    -- nullable: created before sub in some flows
  "planId"              TEXT,
  "userId"              TEXT                     NOT NULL,
  "merchantRequestId"   TEXT,
  "checkoutRequestId"   TEXT,
  "phoneNumber"         TEXT                     NOT NULL,
  "amountKes"           INTEGER                  NOT NULL,
  status                "MpesaTransactionStatus" NOT NULL DEFAULT 'PENDING',
  "mpesaReceiptNumber"  TEXT,
  "resultCode"          TEXT,
  "resultDesc"          TEXT,
  "isRenewal"           BOOLEAN                  NOT NULL DEFAULT FALSE,
  "attemptNumber"       INTEGER                  NOT NULL DEFAULT 1,
  "timeoutAt"           TIMESTAMP(3),
  "completedAt"         TIMESTAMP(3),
  interval              "BillingInterval",
  "createdAt"           TIMESTAMP(3)             NOT NULL DEFAULT NOW(),
  "updatedAt"           TIMESTAMP(3)             NOT NULL DEFAULT NOW()
);

ALTER TABLE mpesa_transactions
  ADD COLUMN IF NOT EXISTS "subscriptionId"     TEXT,
  ADD COLUMN IF NOT EXISTS "planId"             TEXT,
  ADD COLUMN IF NOT EXISTS "merchantRequestId"  TEXT,
  ADD COLUMN IF NOT EXISTS "checkoutRequestId"  TEXT,
  ADD COLUMN IF NOT EXISTS "mpesaReceiptNumber" TEXT,
  ADD COLUMN IF NOT EXISTS "resultCode"         TEXT,
  ADD COLUMN IF NOT EXISTS "resultDesc"         TEXT,
  ADD COLUMN IF NOT EXISTS "isRenewal"          BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS "attemptNumber"      INTEGER NOT NULL DEFAULT 1,
  ADD COLUMN IF NOT EXISTS "timeoutAt"          TIMESTAMP(3),
  ADD COLUMN IF NOT EXISTS "completedAt"        TIMESTAMP(3),
  ADD COLUMN IF NOT EXISTS interval             "BillingInterval",
  ADD COLUMN IF NOT EXISTS "updatedAt"          TIMESTAMP(3) NOT NULL DEFAULT NOW();

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'mpesa_transactions_userId_fkey') THEN
    ALTER TABLE mpesa_transactions ADD CONSTRAINT "mpesa_transactions_userId_fkey"
      FOREIGN KEY ("userId") REFERENCES users(id) ON DELETE CASCADE;
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'mpesa_transactions_subscriptionId_fkey') THEN
    ALTER TABLE mpesa_transactions ADD CONSTRAINT "mpesa_transactions_subscriptionId_fkey"
      FOREIGN KEY ("subscriptionId") REFERENCES subscriptions(id) ON DELETE SET NULL;
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'mpesa_transactions_planId_fkey') THEN
    ALTER TABLE mpesa_transactions ADD CONSTRAINT "mpesa_transactions_planId_fkey"
      FOREIGN KEY ("planId") REFERENCES plans(id) ON DELETE SET NULL;
  END IF;
END $$;

-- Partial unique index on checkoutRequestId (may be null before STK fires)
CREATE UNIQUE INDEX IF NOT EXISTS "mpesa_transactions_checkoutRequestId_key"
  ON mpesa_transactions ("checkoutRequestId")
  WHERE "checkoutRequestId" IS NOT NULL;

CREATE INDEX IF NOT EXISTS "mpesa_transactions_userId_idx"          ON mpesa_transactions ("userId");
CREATE INDEX IF NOT EXISTS "mpesa_transactions_subscriptionId_idx"  ON mpesa_transactions ("subscriptionId");
CREATE INDEX IF NOT EXISTS "mpesa_transactions_status_idx"          ON mpesa_transactions (status);
CREATE INDEX IF NOT EXISTS "mpesa_transactions_createdAt_idx"       ON mpesa_transactions ("createdAt");


-- ============================================================
-- STEP 10 — streaks TABLE: enforce FK to users
-- ============================================================

CREATE TABLE IF NOT EXISTS streaks (
  id                TEXT         NOT NULL PRIMARY KEY DEFAULT gen_random_uuid()::TEXT,
  "userId"          TEXT         NOT NULL UNIQUE,
  "currentStreak"   INTEGER      NOT NULL DEFAULT 0,
  "longestStreak"   INTEGER      NOT NULL DEFAULT 0,
  "lastWorkoutDate" TIMESTAMP(3),
  "createdAt"       TIMESTAMP(3) NOT NULL DEFAULT NOW(),
  "updatedAt"       TIMESTAMP(3) NOT NULL DEFAULT NOW()
);

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'streaks_userId_fkey') THEN
    ALTER TABLE streaks ADD CONSTRAINT "streaks_userId_fkey"
      FOREIGN KEY ("userId") REFERENCES users(id) ON DELETE CASCADE;
  END IF;
END $$;


-- ============================================================
-- STEP 11 — cron_locks TABLE
-- ============================================================

CREATE TABLE IF NOT EXISTS cron_locks (
  id          TEXT         NOT NULL PRIMARY KEY,
  "lockedAt"  TIMESTAMP(3) NOT NULL,
  "expiresAt" TIMESTAMP(3) NOT NULL
);


-- ============================================================
-- STEP 12 — nutrition_logs TABLE (new — was missing from v2)
-- ============================================================

CREATE TABLE IF NOT EXISTS nutrition_logs (
  id          TEXT         NOT NULL PRIMARY KEY DEFAULT gen_random_uuid()::TEXT,
  "userId"    TEXT         NOT NULL,
  name        TEXT         NOT NULL,
  calories    DOUBLE PRECISION,
  protein     DOUBLE PRECISION,
  carbs       DOUBLE PRECISION,
  fat         DOUBLE PRECISION,
  "mealType"  TEXT         NOT NULL DEFAULT 'OTHER',
  date        TIMESTAMP(3) NOT NULL DEFAULT NOW(),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT NOW(),
  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT NOW()
);

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'nutrition_logs_userId_fkey') THEN
    ALTER TABLE nutrition_logs ADD CONSTRAINT "nutrition_logs_userId_fkey"
      FOREIGN KEY ("userId") REFERENCES users(id) ON DELETE CASCADE;
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS "nutrition_logs_userId_idx"      ON nutrition_logs ("userId");
CREATE INDEX IF NOT EXISTS "nutrition_logs_userId_date_idx" ON nutrition_logs ("userId", date);


-- ============================================================
-- STEP 13 — user_memories TABLE (new — was missing from v2)
-- ============================================================

CREATE TABLE IF NOT EXISTS user_memories (
  id          TEXT         NOT NULL PRIMARY KEY DEFAULT gen_random_uuid()::TEXT,
  "userId"    TEXT         NOT NULL UNIQUE,
  data        JSONB        NOT NULL DEFAULT '{}',
  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT NOW()
);

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'user_memories_userId_fkey') THEN
    ALTER TABLE user_memories ADD CONSTRAINT "user_memories_userId_fkey"
      FOREIGN KEY ("userId") REFERENCES users(id) ON DELETE CASCADE;
  END IF;
END $$;


-- ============================================================
-- DONE
-- ============================================================
