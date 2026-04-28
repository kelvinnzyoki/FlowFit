-- ============================================================
-- FLOWFIT — Migration Patch
-- Fixes: column "current_period_end" does not exist
-- ============================================================
-- Root cause: current_period_start and current_period_end were
-- not present in the original Stripe subscriptions schema, so
-- the index created in the main migration failed.
--
-- Run this patch, then re-run the main migration (or just the
-- index steps). All statements are idempotent.
-- ============================================================

-- 1. Add the missing period columns to subscriptions
ALTER TABLE subscriptions
  ADD COLUMN IF NOT EXISTS current_period_start TIMESTAMP(3),
  ADD COLUMN IF NOT EXISTS current_period_end   TIMESTAMP(3),
  ADD COLUMN IF NOT EXISTS trial_started_at     TIMESTAMP(3),
  ADD COLUMN IF NOT EXISTS trial_ends_at        TIMESTAMP(3);

-- 2. Now the indexes are safe to create
CREATE INDEX IF NOT EXISTS subscriptions_current_period_end_idx
  ON subscriptions (current_period_end);

CREATE INDEX IF NOT EXISTS subscriptions_grace_period_ends_at_idx
  ON subscriptions (grace_period_ends_at);

CREATE INDEX IF NOT EXISTS subscriptions_provider_idx
  ON subscriptions (provider);

CREATE INDEX IF NOT EXISTS subscriptions_paystack_subscription_code_idx
  ON subscriptions (paystack_subscription_code);
