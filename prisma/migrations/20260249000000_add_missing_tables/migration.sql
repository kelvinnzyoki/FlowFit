-- ============================================================
-- FLOWFIT — Missing Tables Migration
-- Fixes: 500 on /subscriptions/plans and /subscriptions/current
--
-- ROOT CAUSE:
--   The `plans` and `subscriptions` tables were never created in
--   the DB. Every Prisma query against them throws a relation
--   "plans does not exist" error → Express catches it → 500.
--   This cascades to plansFromAPI=false on the frontend, which
--   makes every "Start Trial" button show "Plans not loaded".
--
-- ALSO FIXED:
--   payments table: missing camelCase columns paystackReference
--   and paidAt that Prisma expects (DB only had snake_case).
--
--   webhook_events table: created by a prior patch with only
--   snake_case columns; Prisma schema has no @map so it expects
--   camelCase. Adding the missing camelCase columns.
--
-- ALL STATEMENTS ARE IDEMPOTENT (safe to re-run).
-- ============================================================


-- ============================================================
-- STEP 1 — CREATE plans TABLE
-- Prisma model: Plan  @@map("plans")
-- All column names match Prisma field names exactly (camelCase).
-- ============================================================

CREATE TABLE IF NOT EXISTS plans (
  id                    TEXT             NOT NULL PRIMARY KEY DEFAULT gen_random_uuid()::TEXT,
  slug                  TEXT             NOT NULL,
  name                  TEXT             NOT NULL,
  description           TEXT,

  "monthlyPriceCents"   INTEGER          NOT NULL DEFAULT 0,
  "yearlyPriceCents"    INTEGER          NOT NULL DEFAULT 0,

  -- M-Pesa prices (whole KES shillings)
  "mpesaMonthlyKes"     INTEGER          NOT NULL DEFAULT 0,
  "mpesaYearlyKes"      INTEGER          NOT NULL DEFAULT 0,

  -- Paystack plan codes — set in Paystack dashboard, stored here
  "paystackPlanCodeMonthly" TEXT,
  "paystackPlanCodeYearly"  TEXT,

  "trialDays"               INTEGER      NOT NULL DEFAULT 0,
  "maxWorkoutsPerMonth"     INTEGER,
  "maxPrograms"             INTEGER,
  "hasAdvancedAnalytics"    BOOLEAN      NOT NULL DEFAULT FALSE,
  "hasPersonalCoaching"     BOOLEAN      NOT NULL DEFAULT FALSE,
  "hasNutritionTracking"    BOOLEAN      NOT NULL DEFAULT FALSE,
  "hasOfflineAccess"        BOOLEAN      NOT NULL DEFAULT FALSE,

  features              JSONB            NOT NULL DEFAULT '[]',
  "displayOrder"        INTEGER          NOT NULL DEFAULT 0,
  "isActive"            BOOLEAN          NOT NULL DEFAULT TRUE,
  "isPopular"           BOOLEAN          NOT NULL DEFAULT FALSE,

  "createdAt"           TIMESTAMP(3)     NOT NULL DEFAULT NOW(),
  "updatedAt"           TIMESTAMP(3)     NOT NULL DEFAULT NOW()
);

-- Unique constraints
DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.table_constraints
    WHERE table_name = 'plans' AND constraint_name = 'plans_slug_key'
  ) THEN
    ALTER TABLE plans ADD CONSTRAINT plans_slug_key UNIQUE (slug);
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.table_constraints
    WHERE table_name = 'plans' AND constraint_name = 'plans_paystackPlanCodeMonthly_key'
  ) THEN
    ALTER TABLE plans ADD CONSTRAINT "plans_paystackPlanCodeMonthly_key"
      UNIQUE ("paystackPlanCodeMonthly");
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.table_constraints
    WHERE table_name = 'plans' AND constraint_name = 'plans_paystackPlanCodeYearly_key'
  ) THEN
    ALTER TABLE plans ADD CONSTRAINT "plans_paystackPlanCodeYearly_key"
      UNIQUE ("paystackPlanCodeYearly");
  END IF;
END $$;


-- ============================================================
-- STEP 2 — SEED plans WITH FREE / PRO / ELITE
-- Only inserts if the row doesn't already exist (ON CONFLICT DO NOTHING).
-- Update paystackPlanCodeMonthly/Yearly after you create plans
-- in your Paystack dashboard.
-- ============================================================

INSERT INTO plans (
  id, slug, name, description,
  "monthlyPriceCents", "yearlyPriceCents",
  "mpesaMonthlyKes", "mpesaYearlyKes",
  "paystackPlanCodeMonthly", "paystackPlanCodeYearly",
  "trialDays",
  "maxWorkoutsPerMonth", "maxPrograms",
  "hasAdvancedAnalytics", "hasPersonalCoaching",
  "hasNutritionTracking", "hasOfflineAccess",
  features, "displayOrder", "isActive", "isPopular"
)
VALUES
  -- FREE plan
  (
    gen_random_uuid()::TEXT, 'free', 'Free', 'Get started with the basics.',
    0, 0,
    0, 0,
    NULL, NULL,
    0,
    10, 1,
    FALSE, FALSE,
    FALSE, FALSE,
    '["Up to 10 workouts per month","1 active program","Basic progress tracking","Exercise library access"]',
    0, TRUE, FALSE
  ),
  -- PRO plan
  (
    gen_random_uuid()::TEXT, 'pro', 'Pro', 'Everything you need to crush your goals.',
    1499, 11988,
    1950, 15600,
    NULL, NULL,   -- <-- fill in your Paystack plan codes after dashboard setup
    14,
    NULL, NULL,
    TRUE, FALSE,
    TRUE, FALSE,
    '["Unlimited workouts","Unlimited programs","Advanced analytics & charts","Nutrition tracking","Priority support","14-day free trial"]',
    1, TRUE, TRUE
  ),
  -- ELITE plan
  (
    gen_random_uuid()::TEXT, 'elite', 'Elite', 'The complete performance platform.',
    2999, 23988,
    3900, 31200,
    NULL, NULL,   -- <-- fill in your Paystack plan codes after dashboard setup
    7,
    NULL, NULL,
    TRUE, TRUE,
    TRUE, TRUE,
    '["Everything in Pro","Personal AI coaching","Offline access & sync","Custom program builder","Body composition analysis","Dedicated account manager"]',
    2, TRUE, FALSE
  )
ON CONFLICT (slug) DO NOTHING;


-- ============================================================
-- STEP 3 — CREATE subscriptions TABLE
-- Prisma model: Subscription  @@map("subscriptions")
-- All column names match Prisma field names exactly (camelCase).
-- ============================================================

CREATE TABLE IF NOT EXISTS subscriptions (
  id                        TEXT                    NOT NULL PRIMARY KEY DEFAULT gen_random_uuid()::TEXT,
  "userId"                  TEXT                    NOT NULL,
  "planId"                  TEXT                    NOT NULL,

  status                    "SubscriptionStatus"    NOT NULL DEFAULT 'TRIALING',
  interval                  "BillingInterval"       NOT NULL DEFAULT 'MONTHLY',
  provider                  "PaymentProvider"       NOT NULL DEFAULT 'PAYSTACK',
  "autoRenew"               BOOLEAN                 NOT NULL DEFAULT TRUE,

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

-- Foreign keys
DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.table_constraints
    WHERE table_name = 'subscriptions' AND constraint_name = 'subscriptions_userId_fkey'
  ) THEN
    ALTER TABLE subscriptions
      ADD CONSTRAINT "subscriptions_userId_fkey"
      FOREIGN KEY ("userId") REFERENCES users(id) ON DELETE CASCADE;
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.table_constraints
    WHERE table_name = 'subscriptions' AND constraint_name = 'subscriptions_planId_fkey'
  ) THEN
    ALTER TABLE subscriptions
      ADD CONSTRAINT "subscriptions_planId_fkey"
      FOREIGN KEY ("planId") REFERENCES plans(id);
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.table_constraints
    WHERE table_name = 'subscriptions' AND constraint_name = 'subscriptions_scheduledPlanId_fkey'
  ) THEN
    ALTER TABLE subscriptions
      ADD CONSTRAINT "subscriptions_scheduledPlanId_fkey"
      FOREIGN KEY ("scheduledPlanId") REFERENCES plans(id) ON DELETE SET NULL;
  END IF;
END $$;

-- Unique constraint on paystackSubscriptionCode
DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.table_constraints
    WHERE table_name = 'subscriptions'
      AND constraint_name = 'subscriptions_paystackSubscriptionCode_key'
  ) THEN
    ALTER TABLE subscriptions
      ADD CONSTRAINT "subscriptions_paystackSubscriptionCode_key"
      UNIQUE ("paystackSubscriptionCode");
  END IF;
END $$;

-- Indexes
CREATE INDEX IF NOT EXISTS "subscriptions_userId_idx"
  ON subscriptions ("userId");
CREATE INDEX IF NOT EXISTS "subscriptions_status_idx"
  ON subscriptions (status);
CREATE INDEX IF NOT EXISTS "subscriptions_provider_idx"
  ON subscriptions (provider);
CREATE INDEX IF NOT EXISTS "subscriptions_paystackSubscriptionCode_idx"
  ON subscriptions ("paystackSubscriptionCode");
CREATE INDEX IF NOT EXISTS "subscriptions_currentPeriodEnd_idx"
  ON subscriptions ("currentPeriodEnd");
CREATE INDEX IF NOT EXISTS "subscriptions_gracePeriodEndsAt_idx"
  ON subscriptions ("gracePeriodEndsAt");


-- ============================================================
-- STEP 4 — FIX payments TABLE
-- The DB has paystack_reference and paid_at (snake_case from
-- prior patches) but Prisma schema has no @map so it looks for
-- paystackReference and paidAt (camelCase).
-- Add the camelCase columns if they don't already exist.
-- ============================================================

ALTER TABLE payments
  ADD COLUMN IF NOT EXISTS "paystackReference" TEXT,
  ADD COLUMN IF NOT EXISTS "paidAt"            TIMESTAMP(3);

-- Fix FK: subscriptions table now exists so the FK can be added
DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.table_constraints
    WHERE table_name = 'payments' AND constraint_name = 'payments_subscriptionId_fkey'
  ) THEN
    ALTER TABLE payments
      ADD CONSTRAINT "payments_subscriptionId_fkey"
      FOREIGN KEY ("subscriptionId") REFERENCES subscriptions(id) ON DELETE CASCADE;
  END IF;
END $$;

-- Index on new column
CREATE INDEX IF NOT EXISTS "payments_paystackReference_idx"
  ON payments ("paystackReference");


-- ============================================================
-- STEP 5 — FIX webhook_events TABLE
-- Created by prior patches with snake_case only.
-- Prisma schema has no @map so it expects camelCase.
-- ============================================================

ALTER TABLE webhook_events
  ADD COLUMN IF NOT EXISTS "externalId"     TEXT         NOT NULL DEFAULT '',
  ADD COLUMN IF NOT EXISTS "eventType"      TEXT         NOT NULL DEFAULT '',
  ADD COLUMN IF NOT EXISTS "processedAt"    TIMESTAMP(3) NOT NULL DEFAULT NOW(),
  ADD COLUMN IF NOT EXISTS "responseStatus" INTEGER      NOT NULL DEFAULT 200;

-- Unique constraint on camelCase externalId
DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.table_constraints
    WHERE table_name = 'webhook_events'
      AND constraint_name = 'webhook_events_externalId_key'
  ) THEN
    ALTER TABLE webhook_events
      ADD CONSTRAINT "webhook_events_externalId_key" UNIQUE ("externalId");
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS "webhook_events_externalId_idx"
  ON webhook_events ("externalId");
CREATE INDEX IF NOT EXISTS "webhook_events_processedAt_idx"
  ON webhook_events ("processedAt");


-- ============================================================
-- STEP 6 — FIX subscription_logs FK
-- Table exists but the FK to subscriptions couldn't be created
-- before because subscriptions didn't exist yet.
-- ============================================================

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.table_constraints
    WHERE table_name = 'subscription_logs'
      AND constraint_name = 'subscription_logs_subscriptionId_fkey'
  ) THEN
    ALTER TABLE subscription_logs
      ADD CONSTRAINT "subscription_logs_subscriptionId_fkey"
      FOREIGN KEY ("subscriptionId") REFERENCES subscriptions(id) ON DELETE CASCADE;
  END IF;
END $$;


-- ============================================================
-- STEP 7 — FIX mpesa_transactions FK to subscriptions + plans
-- Same reason — the referenced tables didn't exist yet.
-- ============================================================

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.table_constraints
    WHERE table_name = 'mpesa_transactions'
      AND constraint_name = 'mpesa_transactions_subscriptionId_fkey'
  ) THEN
    ALTER TABLE mpesa_transactions
      ADD CONSTRAINT "mpesa_transactions_subscriptionId_fkey"
      FOREIGN KEY ("subscriptionId") REFERENCES subscriptions(id) ON DELETE SET NULL;
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.table_constraints
    WHERE table_name = 'mpesa_transactions'
      AND constraint_name = 'mpesa_transactions_planId_fkey'
  ) THEN
    ALTER TABLE mpesa_transactions
      ADD CONSTRAINT "mpesa_transactions_planId_fkey"
      FOREIGN KEY ("planId") REFERENCES plans(id) ON DELETE SET NULL;
  END IF;
END $$;


-- ============================================================
-- DONE
-- After running this:
--
-- 1. Verify plans were seeded:
--    SELECT slug, name, "isActive" FROM plans;
--
-- 2. Add your Paystack plan codes once you create them
--    in the Paystack dashboard:
--    UPDATE plans SET "paystackPlanCodeMonthly" = 'PLN_xxx',
--                     "paystackPlanCodeYearly"  = 'PLN_xxx'
--    WHERE slug = 'pro';
--
-- 3. Tell Prisma this migration is applied:
--    npx prisma migrate resolve --applied "missing_tables"
-- ============================================================
