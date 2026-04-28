-- ============================================================
-- FLOWFIT — Migration Patch v2 (self-contained)
-- Adds ALL missing subscriptions columns first, then indexes.
-- Safe to run standalone — no dependency on the main migration.
-- All statements use IF NOT EXISTS and are fully idempotent.
-- ============================================================

-- Step 1: Add every column the indexes below reference,
--         plus all other missing subscription columns.
--         IF NOT EXISTS means no error if already present.

ALTER TABLE subscriptions
  ADD COLUMN IF NOT EXISTS current_period_start        TIMESTAMP(3),
  ADD COLUMN IF NOT EXISTS current_period_end          TIMESTAMP(3),
  ADD COLUMN IF NOT EXISTS trial_started_at            TIMESTAMP(3),
  ADD COLUMN IF NOT EXISTS trial_ends_at               TIMESTAMP(3),
  ADD COLUMN IF NOT EXISTS provider                    "PaymentProvider"  NOT NULL DEFAULT 'PAYSTACK',
  ADD COLUMN IF NOT EXISTS auto_renew                  BOOLEAN            NOT NULL DEFAULT TRUE,
  ADD COLUMN IF NOT EXISTS paystack_subscription_code  TEXT,
  ADD COLUMN IF NOT EXISTS paystack_email_token        TEXT,
  ADD COLUMN IF NOT EXISTS paystack_reference          TEXT,
  ADD COLUMN IF NOT EXISTS paystack_customer_code      TEXT,
  ADD COLUMN IF NOT EXISTS cancelled_at                TIMESTAMP(3),
  ADD COLUMN IF NOT EXISTS cancellation_reason         TEXT,
  ADD COLUMN IF NOT EXISTS scheduled_plan_id           TEXT,
  ADD COLUMN IF NOT EXISTS scheduled_interval          "BillingInterval",
  ADD COLUMN IF NOT EXISTS mpesa_renewal_attempts      INTEGER            NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS mpesa_last_renewal_at       TIMESTAMP(3),
  ADD COLUMN IF NOT EXISTS grace_period_ends_at        TIMESTAMP(3),
  ADD COLUMN IF NOT EXISTS reminder_sent_at            TIMESTAMP(3),
  ADD COLUMN IF NOT EXISTS activated_at                TIMESTAMP(3),
  ADD COLUMN IF NOT EXISTS expired_at                  TIMESTAMP(3);

-- Step 2: Unique constraint on paystack_subscription_code
DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.table_constraints
    WHERE table_name = 'subscriptions'
      AND constraint_name = 'subscriptions_paystack_subscription_code_key'
  ) THEN
    ALTER TABLE subscriptions
      ADD CONSTRAINT subscriptions_paystack_subscription_code_key
      UNIQUE (paystack_subscription_code);
  END IF;
END $$;

-- Step 3: FK for scheduled_plan_id → plans(id)
DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.table_constraints
    WHERE table_name = 'subscriptions'
      AND constraint_name = 'subscriptions_scheduled_plan_id_fkey'
  ) THEN
    ALTER TABLE subscriptions
      ADD CONSTRAINT subscriptions_scheduled_plan_id_fkey
      FOREIGN KEY (scheduled_plan_id)
      REFERENCES plans(id)
      ON DELETE SET NULL;
  END IF;
END $$;

-- Step 4: Indexes (all columns now guaranteed to exist)
CREATE INDEX IF NOT EXISTS subscriptions_provider_idx
  ON subscriptions (provider);

CREATE INDEX IF NOT EXISTS subscriptions_paystack_subscription_code_idx
  ON subscriptions (paystack_subscription_code);

CREATE INDEX IF NOT EXISTS subscriptions_current_period_end_idx
  ON subscriptions (current_period_end);

CREATE INDEX IF NOT EXISTS subscriptions_grace_period_ends_at_idx
  ON subscriptions (grace_period_ends_at);
