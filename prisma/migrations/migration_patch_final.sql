-- ============================================================
-- FLOWFIT — Migration Patch: plans_slug_key already exists
-- The plans table was partially created on a prior run.
-- This patch skips constraints that already exist and ensures
-- all remaining steps from migration_missing_tables.sql
-- complete cleanly.
-- All statements are idempotent.
-- ============================================================

-- 1. Ensure all plans columns exist (in case table was created incomplete)
ALTER TABLE plans
  ADD COLUMN IF NOT EXISTS description              TEXT,
  ADD COLUMN IF NOT EXISTS "monthlyPriceCents"      INTEGER      NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS "yearlyPriceCents"       INTEGER      NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS "mpesaMonthlyKes"        INTEGER      NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS "mpesaYearlyKes"         INTEGER      NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS "paystackPlanCodeMonthly" TEXT,
  ADD COLUMN IF NOT EXISTS "paystackPlanCodeYearly"  TEXT,
  ADD COLUMN IF NOT EXISTS "trialDays"              INTEGER      NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS "maxWorkoutsPerMonth"    INTEGER,
  ADD COLUMN IF NOT EXISTS "maxPrograms"            INTEGER,
  ADD COLUMN IF NOT EXISTS "hasAdvancedAnalytics"   BOOLEAN      NOT NULL DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS "hasPersonalCoaching"    BOOLEAN      NOT NULL DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS "hasNutritionTracking"   BOOLEAN      NOT NULL DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS "hasOfflineAccess"       BOOLEAN      NOT NULL DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS features                 JSONB        NOT NULL DEFAULT '[]',
  ADD COLUMN IF NOT EXISTS "displayOrder"           INTEGER      NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS "isActive"               BOOLEAN      NOT NULL DEFAULT TRUE,
  ADD COLUMN IF NOT EXISTS "isPopular"              BOOLEAN      NOT NULL DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS "createdAt"              TIMESTAMP(3) NOT NULL DEFAULT NOW(),
  ADD COLUMN IF NOT EXISTS "updatedAt"              TIMESTAMP(3) NOT NULL DEFAULT NOW();

-- 2. Unique constraints — all guarded
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

-- 3. Seed plans (safe — ON CONFLICT DO NOTHING)
INSERT INTO plans (
  id, slug, name, description,
  "monthlyPriceCents", "yearlyPriceCents",
  "mpesaMonthlyKes",   "mpesaYearlyKes",
  "paystackPlanCodeMonthly", "paystackPlanCodeYearly",
  "trialDays",
  "maxWorkoutsPerMonth", "maxPrograms",
  "hasAdvancedAnalytics", "hasPersonalCoaching",
  "hasNutritionTracking", "hasOfflineAccess",
  features, "displayOrder", "isActive", "isPopular"
)
VALUES
  (
    gen_random_uuid()::TEXT, 'free', 'Free', 'Get started with the basics.',
    0, 0, 0, 0, NULL, NULL, 0,
    10, 1, FALSE, FALSE, FALSE, FALSE,
    '["Up to 10 workouts per month","1 active program","Basic progress tracking","Exercise library access"]',
    0, TRUE, FALSE
  ),
  (
    gen_random_uuid()::TEXT, 'pro', 'Pro', 'Everything you need to crush your goals.',
    1499, 11988, 1950, 15600, NULL, NULL, 14,
    NULL, NULL, TRUE, FALSE, TRUE, FALSE,
    '["Unlimited workouts","Unlimited programs","Advanced analytics & charts","Nutrition tracking","Priority support","14-day free trial"]',
    1, TRUE, TRUE
  ),
  (
    gen_random_uuid()::TEXT, 'elite', 'Elite', 'The complete performance platform.',
    2999, 23988, 3900, 31200, NULL, NULL, 7,
    NULL, NULL, TRUE, TRUE, TRUE, TRUE,
    '["Everything in Pro","Personal AI coaching","Offline access & sync","Custom program builder","Body composition analysis","Dedicated account manager"]',
    2, TRUE, FALSE
  )
ON CONFLICT (slug) DO NOTHING;

-- 4. Create subscriptions table
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
  ADD COLUMN IF NOT EXISTS "userId"                   TEXT,
  ADD COLUMN IF NOT EXISTS "planId"                   TEXT,
  ADD COLUMN IF NOT EXISTS "autoRenew"                BOOLEAN      NOT NULL DEFAULT TRUE,
  ADD COLUMN IF NOT EXISTS "paystackSubscriptionCode" TEXT,
  ADD COLUMN IF NOT EXISTS "paystackEmailToken"       TEXT,
  ADD COLUMN IF NOT EXISTS "paystackReference"        TEXT,
  ADD COLUMN IF NOT EXISTS "paystackCustomerCode"     TEXT,
  ADD COLUMN IF NOT EXISTS "currentPeriodStart"       TIMESTAMP(3),
  ADD COLUMN IF NOT EXISTS "currentPeriodEnd"         TIMESTAMP(3),
  ADD COLUMN IF NOT EXISTS "trialStartedAt"           TIMESTAMP(3),
  ADD COLUMN IF NOT EXISTS "trialEndsAt"              TIMESTAMP(3),
  ADD COLUMN IF NOT EXISTS "cancelAtPeriodEnd"        BOOLEAN      NOT NULL DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS "cancelledAt"              TIMESTAMP(3),
  ADD COLUMN IF NOT EXISTS "cancellationReason"       TEXT,
  ADD COLUMN IF NOT EXISTS "scheduledPlanId"          TEXT,
  ADD COLUMN IF NOT EXISTS "scheduledInterval"        "BillingInterval",
  ADD COLUMN IF NOT EXISTS "mpesaRenewalAttempts"     INTEGER      NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS "mpesaLastRenewalAt"       TIMESTAMP(3),
  ADD COLUMN IF NOT EXISTS "gracePeriodEndsAt"        TIMESTAMP(3),
  ADD COLUMN IF NOT EXISTS "reminderSentAt"           TIMESTAMP(3),
  ADD COLUMN IF NOT EXISTS "activatedAt"              TIMESTAMP(3),
  ADD COLUMN IF NOT EXISTS "expiredAt"                TIMESTAMP(3),
  ADD COLUMN IF NOT EXISTS "createdAt"                TIMESTAMP(3) NOT NULL DEFAULT NOW(),
  ADD COLUMN IF NOT EXISTS "updatedAt"                TIMESTAMP(3) NOT NULL DEFAULT NOW();

-- Foreign keys on subscriptions
DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.table_constraints
    WHERE table_name = 'subscriptions' AND constraint_name = 'subscriptions_userId_fkey'
  ) THEN
    ALTER TABLE subscriptions ADD CONSTRAINT "subscriptions_userId_fkey"
      FOREIGN KEY ("userId") REFERENCES users(id) ON DELETE CASCADE;
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.table_constraints
    WHERE table_name = 'subscriptions' AND constraint_name = 'subscriptions_planId_fkey'
  ) THEN
    ALTER TABLE subscriptions ADD CONSTRAINT "subscriptions_planId_fkey"
      FOREIGN KEY ("planId") REFERENCES plans(id);
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.table_constraints
    WHERE table_name = 'subscriptions' AND constraint_name = 'subscriptions_scheduledPlanId_fkey'
  ) THEN
    ALTER TABLE subscriptions ADD CONSTRAINT "subscriptions_scheduledPlanId_fkey"
      FOREIGN KEY ("scheduledPlanId") REFERENCES plans(id) ON DELETE SET NULL;
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.table_constraints
    WHERE table_name = 'subscriptions'
      AND constraint_name = 'subscriptions_paystackSubscriptionCode_key'
  ) THEN
    ALTER TABLE subscriptions ADD CONSTRAINT "subscriptions_paystackSubscriptionCode_key"
      UNIQUE ("paystackSubscriptionCode");
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS "subscriptions_userId_idx"              ON subscriptions ("userId");
CREATE INDEX IF NOT EXISTS "subscriptions_status_idx"              ON subscriptions (status);
CREATE INDEX IF NOT EXISTS "subscriptions_provider_idx"            ON subscriptions (provider);
CREATE INDEX IF NOT EXISTS "subscriptions_paystackSubscriptionCode_idx" ON subscriptions ("paystackSubscriptionCode");
CREATE INDEX IF NOT EXISTS "subscriptions_currentPeriodEnd_idx"    ON subscriptions ("currentPeriodEnd");
CREATE INDEX IF NOT EXISTS "subscriptions_gracePeriodEndsAt_idx"   ON subscriptions ("gracePeriodEndsAt");

-- 5. Fix payments table
ALTER TABLE payments
  ADD COLUMN IF NOT EXISTS "paystackReference" TEXT,
  ADD COLUMN IF NOT EXISTS "paidAt"            TIMESTAMP(3);

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.table_constraints
    WHERE table_name = 'payments' AND constraint_name = 'payments_subscriptionId_fkey'
  ) THEN
    ALTER TABLE payments ADD CONSTRAINT "payments_subscriptionId_fkey"
      FOREIGN KEY ("subscriptionId") REFERENCES subscriptions(id) ON DELETE CASCADE;
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS "payments_paystackReference_idx" ON payments ("paystackReference");

-- 6. Fix webhook_events table
ALTER TABLE webhook_events
  ADD COLUMN IF NOT EXISTS "externalId"     TEXT         NOT NULL DEFAULT '',
  ADD COLUMN IF NOT EXISTS "eventType"      TEXT         NOT NULL DEFAULT '',
  ADD COLUMN IF NOT EXISTS "processedAt"    TIMESTAMP(3) NOT NULL DEFAULT NOW(),
  ADD COLUMN IF NOT EXISTS "responseStatus" INTEGER      NOT NULL DEFAULT 200;

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.table_constraints
    WHERE table_name = 'webhook_events'
      AND constraint_name = 'webhook_events_externalId_key'
  ) THEN
    ALTER TABLE webhook_events ADD CONSTRAINT "webhook_events_externalId_key"
      UNIQUE ("externalId");
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS "webhook_events_externalId_idx"  ON webhook_events ("externalId");
CREATE INDEX IF NOT EXISTS "webhook_events_processedAt_idx" ON webhook_events ("processedAt");

-- 7. Fix subscription_logs FK
DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.table_constraints
    WHERE table_name = 'subscription_logs'
      AND constraint_name = 'subscription_logs_subscriptionId_fkey'
  ) THEN
    ALTER TABLE subscription_logs ADD CONSTRAINT "subscription_logs_subscriptionId_fkey"
      FOREIGN KEY ("subscriptionId") REFERENCES subscriptions(id) ON DELETE CASCADE;
  END IF;
END $$;

-- 8. Fix mpesa_transactions FKs
DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.table_constraints
    WHERE table_name = 'mpesa_transactions'
      AND constraint_name = 'mpesa_transactions_subscriptionId_fkey'
  ) THEN
    ALTER TABLE mpesa_transactions ADD CONSTRAINT "mpesa_transactions_subscriptionId_fkey"
      FOREIGN KEY ("subscriptionId") REFERENCES subscriptions(id) ON DELETE SET NULL;
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.table_constraints
    WHERE table_name = 'mpesa_transactions'
      AND constraint_name = 'mpesa_transactions_planId_fkey'
  ) THEN
    ALTER TABLE mpesa_transactions ADD CONSTRAINT "mpesa_transactions_planId_fkey"
      FOREIGN KEY ("planId") REFERENCES plans(id) ON DELETE SET NULL;
  END IF;
END $$;
