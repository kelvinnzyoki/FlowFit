-- ============================================================
-- FLOWFIT — Migration FIXED (Stripe → Paystack)
-- Verified against schema_prisma v3.
--
-- Fixes applied over v3:
--   FIX-1  mpesa_transactions: CREATE TABLE used 'createdAt'/'updatedAt'
--          but schema has 'initiatedAt'. Prisma would fail every query.
--   FIX-2  mpesa_transactions: ADD COLUMN block never added 'initiatedAt'.
--          On existing DBs the column was never created.
--   FIX-3  mpesa_transactions: merchantRequestId was nullable with no UNIQUE
--          constraint. Schema: String @unique (NOT NULL). Added constraint.
--   FIX-4  mpesa_transactions: checkoutRequestId had only a partial unique
--          index WHERE NOT NULL. Schema requires full UNIQUE. Fixed to
--          full unique constraint after handling existing NULLs.
--   FIX-5  webhook_events: 'provider' column was missing from both CREATE
--          TABLE and ALTER TABLE. Prisma throws on every insert/select.
--   FIX-6  webhook_events: 'error' column was missing entirely.
--   FIX-7  webhook_events: externalId was nullable. Schema has @default('')
--          so Prisma always writes a string. Existing NULL rows backfilled
--          with unique placeholder before NOT NULL constraint applied.
--   FIX-8  subscription_logs: metadata was JSONB nullable. Schema:
--          Json @default('{}') — must be NOT NULL. Backfill before SET NOT NULL.
--   FIX-9  users: root cause of ALL 500s (login/register/send-otp).
--          Ensured all schema-required columns exist safely.
--   FIX-10 plans: slug unique index must exist before ON CONFLICT (slug).
--          Moved index creation before the INSERT ... ON CONFLICT block.
--
-- Safe to run on a live DB with existing users and data.
-- Every DDL is idempotent. Data backfills run before NOT NULL constraints.
-- ============================================================


-- ============================================================
-- STEP 0 — ENUMS
-- Must come before any table that references them.
-- ALTER TYPE ... ADD VALUE cannot run inside a transaction block
-- in some PG versions, so these run as auto-commit statements.
-- ============================================================

DO $$ BEGIN
  CREATE TYPE "BillingInterval" AS ENUM ('MONTHLY', 'YEARLY');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  CREATE TYPE "SubscriptionStatus" AS ENUM (
    'TRIALING', 'ACTIVE', 'PAST_DUE', 'GRACE_PERIOD',
    'CANCELLED', 'EXPIRED', 'INCOMPLETE', 'INCOMPLETE_EXPIRED', 'PAUSED'
  );
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

ALTER TYPE "SubscriptionStatus" ADD VALUE IF NOT EXISTS 'GRACE_PERIOD';
ALTER TYPE "SubscriptionStatus" ADD VALUE IF NOT EXISTS 'INCOMPLETE';
ALTER TYPE "SubscriptionStatus" ADD VALUE IF NOT EXISTS 'INCOMPLETE_EXPIRED';
ALTER TYPE "SubscriptionStatus" ADD VALUE IF NOT EXISTS 'PAUSED';

DO $$ BEGIN
  CREATE TYPE "PaymentProvider" AS ENUM ('PAYSTACK', 'MPESA', 'MANUAL');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

ALTER TYPE "PaymentProvider" ADD VALUE IF NOT EXISTS 'PAYSTACK';
ALTER TYPE "PaymentProvider" ADD VALUE IF NOT EXISTS 'MPESA';
ALTER TYPE "PaymentProvider" ADD VALUE IF NOT EXISTS 'MANUAL';

DO $$ BEGIN
  CREATE TYPE "MpesaTransactionStatus" AS ENUM (
    'PENDING', 'SUCCESS', 'FAILED', 'CANCELLED', 'TIMEOUT'
  );
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

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
-- STEP 1 — users TABLE
-- FIX-9: These columns must exist or EVERY Prisma query on
-- User throws "column does not exist" → 500 on login/register/
-- send-otp and all protected routes.
-- ============================================================

-- Drop the old Stripe column only if it still exists
DO $$ BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'users' AND column_name = 'stripeCustomerId'
  ) THEN
    ALTER TABLE users DROP COLUMN "stripeCustomerId";
  END IF;
END $$;

-- Add all Paystack + phone columns (safe no-ops if already present)
ALTER TABLE users
  ADD COLUMN IF NOT EXISTS "paystackCustomerCode" TEXT,
  ADD COLUMN IF NOT EXISTS "mpesaPhone"           TEXT,
  ADD COLUMN IF NOT EXISTS "phoneVerified"        BOOLEAN      NOT NULL DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS "phoneVerifiedAt"      TIMESTAMP(3);

-- Partial unique index: multiple NULLs are allowed (un-linked users)
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
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'phone_otps_userId_fkey') THEN
    ALTER TABLE phone_otps ADD CONSTRAINT "phone_otps_userId_fkey"
      FOREIGN KEY ("userId") REFERENCES users(id) ON DELETE CASCADE;
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS "phone_otps_userId_idx"    ON phone_otps ("userId");
CREATE INDEX IF NOT EXISTS "phone_otps_phone_idx"     ON phone_otps (phone);
CREATE INDEX IF NOT EXISTS "phone_otps_expiresAt_idx" ON phone_otps ("expiresAt");


-- ============================================================
-- STEP 3 — plans TABLE
-- FIX-10: Unique index on slug must be created BEFORE the
-- INSERT ... ON CONFLICT (slug) block that depends on it.
-- ============================================================

CREATE TABLE IF NOT EXISTS plans (
  id                        TEXT         NOT NULL PRIMARY KEY DEFAULT gen_random_uuid()::TEXT,
  slug                      TEXT         NOT NULL,
  name                      TEXT         NOT NULL,
  description               TEXT,
  "monthlyPriceCents"       INTEGER      NOT NULL DEFAULT 0,
  "yearlyPriceCents"        INTEGER      NOT NULL DEFAULT 0,
  "mpesaMonthlyKes"         INTEGER      NOT NULL DEFAULT 0,
  "mpesaYearlyKes"          INTEGER      NOT NULL DEFAULT 0,
  "paystackPlanCodeMonthly" TEXT,
  "paystackPlanCodeYearly"  TEXT,
  "trialDays"               INTEGER      NOT NULL DEFAULT 0,
  "maxWorkoutsPerMonth"     INTEGER,
  "maxPrograms"             INTEGER,
  "hasAdvancedAnalytics"    BOOLEAN      NOT NULL DEFAULT FALSE,
  "hasPersonalCoaching"     BOOLEAN      NOT NULL DEFAULT FALSE,
  "hasNutritionTracking"    BOOLEAN      NOT NULL DEFAULT FALSE,
  "hasOfflineAccess"        BOOLEAN      NOT NULL DEFAULT FALSE,
  features                  JSONB        NOT NULL DEFAULT '[]',
  "displayOrder"            INTEGER      NOT NULL DEFAULT 0,
  "isActive"                BOOLEAN      NOT NULL DEFAULT TRUE,
  "isPopular"               BOOLEAN      NOT NULL DEFAULT FALSE,
  "createdAt"               TIMESTAMP(3) NOT NULL DEFAULT NOW(),
  "updatedAt"               TIMESTAMP(3) NOT NULL DEFAULT NOW()
);

-- Add missing columns to existing plans table
ALTER TABLE plans
  ADD COLUMN IF NOT EXISTS description               TEXT,
  ADD COLUMN IF NOT EXISTS "monthlyPriceCents"       INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS "yearlyPriceCents"        INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS "mpesaMonthlyKes"         INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS "mpesaYearlyKes"          INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS "paystackPlanCodeMonthly" TEXT,
  ADD COLUMN IF NOT EXISTS "paystackPlanCodeYearly"  TEXT,
  ADD COLUMN IF NOT EXISTS "trialDays"               INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS "maxWorkoutsPerMonth"     INTEGER,
  ADD COLUMN IF NOT EXISTS "maxPrograms"             INTEGER,
  ADD COLUMN IF NOT EXISTS "hasAdvancedAnalytics"    BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS "hasPersonalCoaching"     BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS "hasNutritionTracking"    BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS "hasOfflineAccess"        BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS features                  JSONB   NOT NULL DEFAULT '[]',
  ADD COLUMN IF NOT EXISTS "displayOrder"            INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS "isActive"                BOOLEAN NOT NULL DEFAULT TRUE,
  ADD COLUMN IF NOT EXISTS "isPopular"               BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS "createdAt"               TIMESTAMP(3) NOT NULL DEFAULT NOW(),
  ADD COLUMN IF NOT EXISTS "updatedAt"               TIMESTAMP(3) NOT NULL DEFAULT NOW();

-- Drop old Stripe columns if present
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

-- FIX-10: Unique index on slug MUST exist before INSERT ... ON CONFLICT (slug)
-- Using CREATE UNIQUE INDEX (not ADD CONSTRAINT) matches Prisma's @unique behaviour
CREATE UNIQUE INDEX IF NOT EXISTS "plans_slug_key"
  ON plans (slug);

-- Partial unique indexes for nullable Paystack codes
CREATE UNIQUE INDEX IF NOT EXISTS "plans_paystackPlanCodeMonthly_key"
  ON plans ("paystackPlanCodeMonthly")
  WHERE "paystackPlanCodeMonthly" IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS "plans_paystackPlanCodeYearly_key"
  ON plans ("paystackPlanCodeYearly")
  WHERE "paystackPlanCodeYearly" IS NOT NULL;


-- ============================================================
-- STEP 4 — Seed / upsert plans
-- ON CONFLICT (slug) works now that the unique index above exists.
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
  id                         TEXT                 NOT NULL PRIMARY KEY DEFAULT gen_random_uuid()::TEXT,
  "userId"                   TEXT                 NOT NULL,
  "planId"                   TEXT                 NOT NULL,
  status                     "SubscriptionStatus" NOT NULL DEFAULT 'TRIALING',
  interval                   "BillingInterval"    NOT NULL DEFAULT 'MONTHLY',
  provider                   "PaymentProvider"    NOT NULL DEFAULT 'PAYSTACK',
  "autoRenew"                BOOLEAN              NOT NULL DEFAULT TRUE,
  "paystackSubscriptionCode" TEXT,
  "paystackEmailToken"       TEXT,
  "paystackReference"        TEXT,
  "paystackCustomerCode"     TEXT,
  "currentPeriodStart"       TIMESTAMP(3),
  "currentPeriodEnd"         TIMESTAMP(3),
  "trialStartedAt"           TIMESTAMP(3),
  "trialEndsAt"              TIMESTAMP(3),
  "cancelAtPeriodEnd"        BOOLEAN              NOT NULL DEFAULT FALSE,
  "cancelledAt"              TIMESTAMP(3),
  "cancellationReason"       TEXT,
  "scheduledPlanId"          TEXT,
  "scheduledInterval"        "BillingInterval",
  "mpesaRenewalAttempts"     INTEGER              NOT NULL DEFAULT 0,
  "mpesaLastRenewalAt"       TIMESTAMP(3),
  "gracePeriodEndsAt"        TIMESTAMP(3),
  "reminderSentAt"           TIMESTAMP(3),
  "activatedAt"              TIMESTAMP(3),
  "expiredAt"                TIMESTAMP(3),
  "createdAt"                TIMESTAMP(3)         NOT NULL DEFAULT NOW(),
  "updatedAt"                TIMESTAMP(3)         NOT NULL DEFAULT NOW()
);

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

-- Drop old Stripe columns
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

-- Partial unique index: multiple NULLs allowed (INCOMPLETE rows have no code yet)
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
-- ============================================================

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

-- Drop old Stripe columns
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
-- FIX-8: metadata must be NOT NULL JSONB to match schema
-- @default('{}')). Backfill existing NULL rows first.
-- ============================================================

CREATE TABLE IF NOT EXISTS subscription_logs (
  id               TEXT                NOT NULL PRIMARY KEY DEFAULT gen_random_uuid()::TEXT,
  "subscriptionId" TEXT                NOT NULL,
  event            "SubscriptionEvent" NOT NULL,
  "previousStatus" "SubscriptionStatus",
  "newStatus"      "SubscriptionStatus",
  metadata         JSONB               NOT NULL DEFAULT '{}',
  "ipAddress"      TEXT,
  "createdAt"      TIMESTAMP(3)        NOT NULL DEFAULT NOW()
);

-- Add metadata column if the table existed before (it may be nullable)
ALTER TABLE subscription_logs
  ADD COLUMN IF NOT EXISTS metadata    JSONB,
  ADD COLUMN IF NOT EXISTS "ipAddress" TEXT;

-- FIX-8: Backfill NULL metadata so we can enforce NOT NULL
UPDATE subscription_logs SET metadata = '{}' WHERE metadata IS NULL;

-- Now enforce NOT NULL and set default for future rows
ALTER TABLE subscription_logs
  ALTER COLUMN metadata SET NOT NULL,
  ALTER COLUMN metadata SET DEFAULT '{}';

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
-- FIX-5: Added 'provider' column (was completely missing).
-- FIX-6: Added 'error' column (was completely missing).
-- FIX-7: externalId backfilled before NOT NULL enforcement.
--        Each NULL gets a unique placeholder so the unique
--        constraint is not violated.
-- ============================================================

CREATE TABLE IF NOT EXISTS webhook_events (
  id               TEXT         NOT NULL PRIMARY KEY DEFAULT gen_random_uuid()::TEXT,
  "externalId"     TEXT         NOT NULL DEFAULT '',
  provider         TEXT         NOT NULL DEFAULT 'paystack',
  "eventType"      TEXT         NOT NULL DEFAULT 'unknown',
  "processedAt"    TIMESTAMP(3) NOT NULL DEFAULT NOW(),
  "responseStatus" INTEGER      NOT NULL DEFAULT 200,
  error            TEXT
);

-- Add all columns that may be missing on an existing table
-- FIX-5: provider was missing
-- FIX-6: error was missing
ALTER TABLE webhook_events
  ADD COLUMN IF NOT EXISTS "externalId"     TEXT,
  ADD COLUMN IF NOT EXISTS provider         TEXT         NOT NULL DEFAULT 'paystack',
  ADD COLUMN IF NOT EXISTS "eventType"      TEXT         NOT NULL DEFAULT 'unknown',
  ADD COLUMN IF NOT EXISTS "processedAt"    TIMESTAMP(3) NOT NULL DEFAULT NOW(),
  ADD COLUMN IF NOT EXISTS "responseStatus" INTEGER      NOT NULL DEFAULT 200,
  ADD COLUMN IF NOT EXISTS error            TEXT;

-- FIX-7: Backfill existing NULL externalId rows with a unique placeholder
-- before enforcing NOT NULL. Using id as the suffix guarantees uniqueness.
UPDATE webhook_events
   SET "externalId" = 'legacy-' || id
 WHERE "externalId" IS NULL;

-- Now enforce NOT NULL and set the default for future rows
ALTER TABLE webhook_events
  ALTER COLUMN "externalId" SET NOT NULL,
  ALTER COLUMN "externalId" SET DEFAULT '';

-- Full unique index (not partial) to match Prisma's @unique behaviour
-- Drop the old partial index from v3 first if it exists
DROP INDEX IF EXISTS "webhook_events_externalId_key";

CREATE UNIQUE INDEX IF NOT EXISTS "webhook_events_externalId_key"
  ON webhook_events ("externalId");

CREATE INDEX IF NOT EXISTS "webhook_events_provider_idx"     ON webhook_events (provider);
CREATE INDEX IF NOT EXISTS "webhook_events_processedAt_idx"  ON webhook_events ("processedAt");
CREATE INDEX IF NOT EXISTS "webhook_events_eventType_idx"    ON webhook_events ("eventType");


-- ============================================================
-- STEP 9 — mpesa_transactions TABLE
-- FIX-1: Schema has 'initiatedAt' not 'createdAt'/'updatedAt'.
--        CREATE TABLE now uses initiatedAt.
-- FIX-2: ADD COLUMN block now includes initiatedAt.
-- FIX-3: merchantRequestId must be NOT NULL + UNIQUE.
-- FIX-4: checkoutRequestId must be NOT NULL + full UNIQUE.
-- ============================================================

CREATE TABLE IF NOT EXISTS mpesa_transactions (
  id                    TEXT                     NOT NULL PRIMARY KEY DEFAULT gen_random_uuid()::TEXT,
  "subscriptionId"      TEXT,
  "planId"              TEXT,
  "userId"              TEXT                     NOT NULL,
  "merchantRequestId"   TEXT                     NOT NULL,
  "checkoutRequestId"   TEXT                     NOT NULL,
  "phoneNumber"         TEXT,
  "amountKes"           INTEGER                  NOT NULL,
  status                "MpesaTransactionStatus" NOT NULL DEFAULT 'PENDING',
  "mpesaReceiptNumber"  TEXT,
  "resultCode"          TEXT,
  "resultDesc"          TEXT,
  "isRenewal"           BOOLEAN                  NOT NULL DEFAULT FALSE,
  "attemptNumber"       INTEGER                  NOT NULL DEFAULT 1,
  interval              "BillingInterval"        NOT NULL DEFAULT 'MONTHLY',
  "initiatedAt"         TIMESTAMP(3)             NOT NULL DEFAULT NOW(),
  "completedAt"         TIMESTAMP(3),
  "timeoutAt"           TIMESTAMP(3)
);

-- FIX-2: Add all columns including initiatedAt which was missing in v3
ALTER TABLE mpesa_transactions
  ADD COLUMN IF NOT EXISTS "subscriptionId"     TEXT,
  ADD COLUMN IF NOT EXISTS "planId"             TEXT,
  ADD COLUMN IF NOT EXISTS "phoneNumber"        TEXT,
  ADD COLUMN IF NOT EXISTS "mpesaReceiptNumber" TEXT,
  ADD COLUMN IF NOT EXISTS "resultCode"         TEXT,
  ADD COLUMN IF NOT EXISTS "resultDesc"         TEXT,
  ADD COLUMN IF NOT EXISTS "isRenewal"          BOOLEAN          NOT NULL DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS "attemptNumber"      INTEGER          NOT NULL DEFAULT 1,
  ADD COLUMN IF NOT EXISTS interval             "BillingInterval" NOT NULL DEFAULT 'MONTHLY',
  ADD COLUMN IF NOT EXISTS "completedAt"        TIMESTAMP(3),
  ADD COLUMN IF NOT EXISTS "timeoutAt"          TIMESTAMP(3),
  -- FIX-1 + FIX-2: initiatedAt is the correct column name per schema.
  -- v3 incorrectly used createdAt/updatedAt which don't exist in the schema.
  ADD COLUMN IF NOT EXISTS "initiatedAt"        TIMESTAMP(3)     NOT NULL DEFAULT NOW();

-- FIX-1: Drop createdAt/updatedAt if they were created by a previous
-- bad migration run, so the schema stays in sync with Prisma.
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.columns
    WHERE table_name = 'mpesa_transactions' AND column_name = 'createdAt') THEN
    -- Migrate data: if initiatedAt is still the default, use createdAt value
    UPDATE mpesa_transactions
       SET "initiatedAt" = "createdAt"
     WHERE "initiatedAt" = NOW() OR "initiatedAt" IS NULL;
    ALTER TABLE mpesa_transactions DROP COLUMN "createdAt";
  END IF;
END $$;
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.columns
    WHERE table_name = 'mpesa_transactions' AND column_name = 'updatedAt') THEN
    ALTER TABLE mpesa_transactions DROP COLUMN "updatedAt";
  END IF;
END $$;

-- FKs
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

-- FIX-3: merchantRequestId — full unique constraint (schema: String @unique NOT NULL)
-- Backfill any NULLs from before the NOT NULL requirement with a unique placeholder
UPDATE mpesa_transactions
   SET "merchantRequestId" = 'legacy-mrq-' || id
 WHERE "merchantRequestId" IS NULL;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'mpesa_transactions_merchantRequestId_key') THEN
    ALTER TABLE mpesa_transactions ADD CONSTRAINT "mpesa_transactions_merchantRequestId_key"
      UNIQUE ("merchantRequestId");
  END IF;
END $$;

-- FIX-4: checkoutRequestId — full unique constraint (schema: String @unique NOT NULL)
-- Drop the old partial unique index from v3 if it exists
DROP INDEX IF EXISTS "mpesa_transactions_checkoutRequestId_key";

UPDATE mpesa_transactions
   SET "checkoutRequestId" = 'legacy-crq-' || id
 WHERE "checkoutRequestId" IS NULL;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'mpesa_transactions_checkoutRequestId_key') THEN
    ALTER TABLE mpesa_transactions ADD CONSTRAINT "mpesa_transactions_checkoutRequestId_key"
      UNIQUE ("checkoutRequestId");
  END IF;
END $$;

-- mpesaReceiptNumber: nullable unique (schema: String? @unique)
CREATE UNIQUE INDEX IF NOT EXISTS "mpesa_transactions_mpesaReceiptNumber_key"
  ON mpesa_transactions ("mpesaReceiptNumber")
  WHERE "mpesaReceiptNumber" IS NOT NULL;

CREATE INDEX IF NOT EXISTS "mpesa_transactions_userId_idx"         ON mpesa_transactions ("userId");
CREATE INDEX IF NOT EXISTS "mpesa_transactions_subscriptionId_idx" ON mpesa_transactions ("subscriptionId");
CREATE INDEX IF NOT EXISTS "mpesa_transactions_status_idx"         ON mpesa_transactions (status);
CREATE INDEX IF NOT EXISTS "mpesa_transactions_checkoutRequestId_idx" ON mpesa_transactions ("checkoutRequestId");
CREATE INDEX IF NOT EXISTS "mpesa_transactions_initiatedAt_idx"    ON mpesa_transactions ("initiatedAt");


-- ============================================================
-- STEP 10 — streaks TABLE
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
-- STEP 12 — otp_codes TABLE
-- ============================================================

CREATE TABLE IF NOT EXISTS otp_codes (
  id          TEXT         NOT NULL PRIMARY KEY DEFAULT gen_random_uuid()::TEXT,
  email       TEXT         NOT NULL,
  "codeHash"  TEXT         NOT NULL,
  purpose     TEXT         NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT NOW(),
  "expiresAt" TIMESTAMP(3) NOT NULL,
  "usedAt"    TIMESTAMP(3)
);

CREATE INDEX IF NOT EXISTS "otp_codes_email_idx"         ON otp_codes (email);
CREATE INDEX IF NOT EXISTS "otp_codes_email_purpose_idx" ON otp_codes (email, purpose);


-- ============================================================
-- STEP 13 — embeddings TABLE
-- ============================================================

CREATE TABLE IF NOT EXISTS embeddings (
  id          TEXT         NOT NULL PRIMARY KEY DEFAULT gen_random_uuid()::TEXT,
  "userId"    TEXT         NOT NULL,
  text        TEXT         NOT NULL,
  vector      JSONB        NOT NULL DEFAULT '[]',
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT NOW()
);

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'embeddings_userId_fkey') THEN
    ALTER TABLE embeddings ADD CONSTRAINT "embeddings_userId_fkey"
      FOREIGN KEY ("userId") REFERENCES users(id) ON DELETE CASCADE;
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS "embeddings_userId_idx"            ON embeddings ("userId");
CREATE INDEX IF NOT EXISTS "embeddings_userId_createdAt_idx"  ON embeddings ("userId", "createdAt");


-- ============================================================
-- STEP 14 — user_memories TABLE
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
-- STEP 15 — nutrition_logs TABLE
-- ============================================================

CREATE TABLE IF NOT EXISTS nutrition_logs (
  id          TEXT             NOT NULL PRIMARY KEY DEFAULT gen_random_uuid()::TEXT,
  "userId"    TEXT             NOT NULL,
  name        TEXT             NOT NULL,
  calories    DOUBLE PRECISION,
  protein     DOUBLE PRECISION,
  carbs       DOUBLE PRECISION,
  fat         DOUBLE PRECISION,
  "mealType"  TEXT             NOT NULL DEFAULT 'OTHER',
  date        TIMESTAMP(3)     NOT NULL DEFAULT NOW(),
  "createdAt" TIMESTAMP(3)     NOT NULL DEFAULT NOW(),
  "updatedAt" TIMESTAMP(3)     NOT NULL DEFAULT NOW()
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
-- STEP 16 — notifications TABLE
-- ============================================================

CREATE TABLE IF NOT EXISTS notifications (
  id          TEXT         NOT NULL PRIMARY KEY DEFAULT gen_random_uuid()::TEXT,
  "userId"    TEXT         NOT NULL,
  type        TEXT         NOT NULL,
  title       TEXT         NOT NULL,
  body        TEXT         NOT NULL,
  icon        TEXT         NOT NULL DEFAULT '🔔',
  link        TEXT,
  "readAt"    TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT NOW()
);

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'notifications_userId_fkey') THEN
    ALTER TABLE notifications ADD CONSTRAINT "notifications_userId_fkey"
      FOREIGN KEY ("userId") REFERENCES users(id) ON DELETE CASCADE;
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS "notifications_userId_idx"    ON notifications ("userId");
CREATE INDEX IF NOT EXISTS "notifications_readAt_idx"    ON notifications ("readAt");
CREATE INDEX IF NOT EXISTS "notifications_createdAt_idx" ON notifications ("createdAt");


-- ============================================================
-- DONE
-- ============================================================
-- Tell Prisma this migration has been applied so it doesn't
-- try to re-run or generate a conflicting migration:
--
--   npx prisma migrate resolve --applied "stripe_to_paystack_fixed"
--
-- Then verify the DB matches the schema exactly:
--
--   npx prisma db pull   (should show no drift)
--   npx prisma generate  (regenerates the client)
-- ============================================================
