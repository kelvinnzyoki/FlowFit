-- ============================================================
-- FLOWFIT — Migration Patch v3
-- Fixes: column "subscription_id" does not exist on payments
-- Self-contained: adds ALL missing payments columns first,
-- then creates indexes. Fully idempotent.
-- ============================================================

-- Step 1: Add every missing column to payments.
--         Core relational fields (subscription_id, amount_cents,
--         currency, status) may or may not exist — IF NOT EXISTS
--         handles both cases safely.

ALTER TABLE payments
  ADD COLUMN IF NOT EXISTS subscription_id       TEXT,
  ADD COLUMN IF NOT EXISTS provider              "PaymentProvider"  NOT NULL DEFAULT 'PAYSTACK',
  ADD COLUMN IF NOT EXISTS paystack_reference    TEXT,
  ADD COLUMN IF NOT EXISTS paid_at               TIMESTAMP(3),
  ADD COLUMN IF NOT EXISTS mpesa_transaction_id  TEXT,
  ADD COLUMN IF NOT EXISTS mpesa_receipt_number  TEXT,
  ADD COLUMN IF NOT EXISTS amount_cents          INTEGER            NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS currency              TEXT               NOT NULL DEFAULT 'KES',
  ADD COLUMN IF NOT EXISTS status                TEXT               NOT NULL DEFAULT 'succeeded',
  ADD COLUMN IF NOT EXISTS failure_message       TEXT,
  ADD COLUMN IF NOT EXISTS refunded_at           TIMESTAMP(3),
  ADD COLUMN IF NOT EXISTS refund_amount_cents   INTEGER,
  ADD COLUMN IF NOT EXISTS created_at            TIMESTAMP(3)       NOT NULL DEFAULT NOW();

-- Step 2: Drop old Stripe columns
ALTER TABLE payments DROP COLUMN IF EXISTS stripe_invoice_id;
ALTER TABLE payments DROP COLUMN IF EXISTS stripe_payment_intent_id;

-- Step 3: FK from payments.subscription_id → subscriptions(id)
DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.table_constraints
    WHERE table_name = 'payments'
      AND constraint_name = 'payments_subscription_id_fkey'
  ) THEN
    ALTER TABLE payments
      ADD CONSTRAINT payments_subscription_id_fkey
      FOREIGN KEY (subscription_id)
      REFERENCES subscriptions(id)
      ON DELETE CASCADE;
  END IF;
END $$;

-- Step 4: Indexes (all columns now guaranteed to exist)
CREATE INDEX IF NOT EXISTS payments_subscription_id_idx
  ON payments (subscription_id);

CREATE INDEX IF NOT EXISTS payments_provider_idx
  ON payments (provider);

CREATE INDEX IF NOT EXISTS payments_status_idx
  ON payments (status);

CREATE INDEX IF NOT EXISTS payments_paystack_reference_idx
  ON payments (paystack_reference);
