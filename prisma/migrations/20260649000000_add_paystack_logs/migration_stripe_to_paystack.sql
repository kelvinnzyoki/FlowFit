-- ============================================================
-- FLOWFIT — Migration: Stripe → Paystack
-- File: migration_stripe_to_paystack.sql
-- ============================================================
--
-- PURPOSE
--   Migrate a database that was built against the Stripe-era schema
--   to the current Paystack + M-Pesa schema (schema.prisma v3).
--
-- SAFETY
--   Every operation is wrapped in DO $$ ... END$$ guards that check
--   for the column / constraint / index before acting, making the
--   entire file safe to re-run (idempotent). New tables are created
--   with CREATE TABLE IF NOT EXISTS.
--
-- ORDER OF OPERATIONS
--   1.  PaymentProvider enum  — rename STRIPE → PAYSTACK
--   2.  users                 — rename stripe_customer_id → paystack_customer_code
--   3.  plans                 — rename stripe price ID columns → paystack plan code columns
--   4.  subscriptions         — rename Stripe columns, add new Paystack columns
--   5.  payments              — rename stripe_invoice_id, add M-Pesa columns
--   6.  Provider defaults     — update DEFAULT values on subscriptions, payments, webhook_events
--   7.  New tables            — CREATE TABLE IF NOT EXISTS for every table added since
--                               the Stripe-era schema (phone_otps, notifications,
--                               mpesa_transactions, subscription_logs, webhook_events,
--                               cron_locks, embeddings, user_memories, nutrition_logs)
--   8.  Enums                 — add new SubscriptionEvent + MpesaTransactionStatus values
--   9.  Orphan cleanup        — drop any remaining stripe_* columns
--   10. Final index pass      — ensure all schema.prisma @@index declarations exist
--
-- PREREQUISITES
--   PostgreSQL 10+ (required for ALTER TYPE ... RENAME VALUE).
--   Run as the database owner or a superuser.
--
-- ============================================================

BEGIN;

-- ─────────────────────────────────────────────────────────────────────────────
-- SECTION 1 — PaymentProvider enum: STRIPE → PAYSTACK
-- ─────────────────────────────────────────────────────────────────────────────
-- ALTER TYPE ... RENAME VALUE is idempotent on PostgreSQL 10+.
-- We check pg_enum first so repeated runs do not error.

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_enum e
    JOIN pg_type t ON t.oid = e.enumtypid
    WHERE t.typname = 'PaymentProvider' AND e.enumlabel = 'STRIPE'
  ) THEN
    ALTER TYPE "PaymentProvider" RENAME VALUE 'STRIPE' TO 'PAYSTACK';
    RAISE NOTICE 'PaymentProvider: renamed STRIPE → PAYSTACK';
  ELSE
    RAISE NOTICE 'PaymentProvider: PAYSTACK already exists, skipping rename';
  END IF;
END$$;

-- Add PAYSTACK if it somehow doesn't exist yet (belt-and-suspenders)
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_enum e
    JOIN pg_type t ON t.oid = e.enumtypid
    WHERE t.typname = 'PaymentProvider' AND e.enumlabel = 'PAYSTACK'
  ) THEN
    ALTER TYPE "PaymentProvider" ADD VALUE 'PAYSTACK';
    RAISE NOTICE 'PaymentProvider: added PAYSTACK value';
  END IF;
END$$;

-- ─────────────────────────────────────────────────────────────────────────────
-- SECTION 2 — users table
-- ─────────────────────────────────────────────────────────────────────────────

-- 2.1  stripe_customer_id → paystack_customer_code
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'users'
    AND column_name = 'stripe_customer_id'
  ) THEN
    -- Drop the old unique constraint before renaming
    ALTER TABLE "users"
      DROP CONSTRAINT IF EXISTS "users_stripe_customer_id_key";
    ALTER TABLE "users"
      RENAME COLUMN "stripe_customer_id" TO "paystack_customer_code";
    RAISE NOTICE 'users: renamed stripe_customer_id → paystack_customer_code';
  ELSE
    RAISE NOTICE 'users: stripe_customer_id not found — already migrated or did not exist';
  END IF;
END$$;

-- 2.2  Add paystack_customer_code if it still does not exist (fresh DB path)
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'users'
    AND column_name = 'paystack_customer_code'
  ) THEN
    ALTER TABLE "users" ADD COLUMN "paystack_customer_code" TEXT;
    RAISE NOTICE 'users: added paystack_customer_code column';
  END IF;
END$$;

-- 2.3  Unique constraint on paystack_customer_code
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'users_paystack_customer_code_key'
  ) THEN
    ALTER TABLE "users"
      ADD CONSTRAINT "users_paystack_customer_code_key"
      UNIQUE ("paystack_customer_code");
    RAISE NOTICE 'users: added UNIQUE constraint on paystack_customer_code';
  END IF;
END$$;

-- ─────────────────────────────────────────────────────────────────────────────
-- SECTION 3 — plans table
-- ─────────────────────────────────────────────────────────────────────────────

-- 3.1  stripe_price_id_monthly → paystack_plan_code_monthly
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'plans'
    AND column_name = 'stripe_price_id_monthly'
  ) THEN
    ALTER TABLE "plans"
      DROP CONSTRAINT IF EXISTS "plans_stripe_price_id_monthly_key";
    ALTER TABLE "plans"
      RENAME COLUMN "stripe_price_id_monthly" TO "paystack_plan_code_monthly";
    RAISE NOTICE 'plans: renamed stripe_price_id_monthly → paystack_plan_code_monthly';
  END IF;
END$$;

-- 3.2  Add paystack_plan_code_monthly if still missing
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'plans'
    AND column_name = 'paystack_plan_code_monthly'
  ) THEN
    ALTER TABLE "plans" ADD COLUMN "paystack_plan_code_monthly" TEXT;
    RAISE NOTICE 'plans: added paystack_plan_code_monthly';
  END IF;
END$$;

-- 3.3  Unique constraint on paystack_plan_code_monthly
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'plans_paystack_plan_code_monthly_key'
  ) THEN
    ALTER TABLE "plans"
      ADD CONSTRAINT "plans_paystack_plan_code_monthly_key"
      UNIQUE ("paystack_plan_code_monthly");
  END IF;
END$$;

-- 3.4  stripe_price_id_yearly → paystack_plan_code_yearly
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'plans'
    AND column_name = 'stripe_price_id_yearly'
  ) THEN
    ALTER TABLE "plans"
      DROP CONSTRAINT IF EXISTS "plans_stripe_price_id_yearly_key";
    ALTER TABLE "plans"
      RENAME COLUMN "stripe_price_id_yearly" TO "paystack_plan_code_yearly";
    RAISE NOTICE 'plans: renamed stripe_price_id_yearly → paystack_plan_code_yearly';
  END IF;
END$$;

-- 3.5  Add paystack_plan_code_yearly if still missing
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'plans'
    AND column_name = 'paystack_plan_code_yearly'
  ) THEN
    ALTER TABLE "plans" ADD COLUMN "paystack_plan_code_yearly" TEXT;
    RAISE NOTICE 'plans: added paystack_plan_code_yearly';
  END IF;
END$$;

-- 3.6  Unique constraint on paystack_plan_code_yearly
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'plans_paystack_plan_code_yearly_key'
  ) THEN
    ALTER TABLE "plans"
      ADD CONSTRAINT "plans_paystack_plan_code_yearly_key"
      UNIQUE ("paystack_plan_code_yearly");
  END IF;
END$$;

-- 3.7  Add M-Pesa price fields if missing (added in schema v3)
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'plans'
    AND column_name = 'mpesa_monthly_kes'
  ) THEN
    ALTER TABLE "plans" ADD COLUMN "mpesa_monthly_kes" INTEGER NOT NULL DEFAULT 0;
    RAISE NOTICE 'plans: added mpesa_monthly_kes';
  END IF;
END$$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'plans'
    AND column_name = 'mpesa_yearly_kes'
  ) THEN
    ALTER TABLE "plans" ADD COLUMN "mpesa_yearly_kes" INTEGER NOT NULL DEFAULT 0;
    RAISE NOTICE 'plans: added mpesa_yearly_kes';
  END IF;
END$$;

-- ─────────────────────────────────────────────────────────────────────────────
-- SECTION 4 — subscriptions table
-- ─────────────────────────────────────────────────────────────────────────────

-- 4.1  stripe_checkout_session_id → paystack_reference
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'subscriptions'
    AND column_name = 'stripe_checkout_session_id'
  ) THEN
    ALTER TABLE "subscriptions"
      DROP CONSTRAINT IF EXISTS "subscriptions_stripe_checkout_session_id_key";
    DROP INDEX IF EXISTS "subscriptions_stripe_checkout_session_id_idx";
    ALTER TABLE "subscriptions"
      RENAME COLUMN "stripe_checkout_session_id" TO "paystack_reference";
    RAISE NOTICE 'subscriptions: renamed stripe_checkout_session_id → paystack_reference';
  END IF;
END$$;

-- 4.2  Add paystack_reference if still missing
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'subscriptions'
    AND column_name = 'paystack_reference'
  ) THEN
    ALTER TABLE "subscriptions" ADD COLUMN "paystack_reference" TEXT;
    RAISE NOTICE 'subscriptions: added paystack_reference';
  END IF;
END$$;

-- 4.3  stripe_subscription_id → paystack_subscription_code
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'subscriptions'
    AND column_name = 'stripe_subscription_id'
  ) THEN
    ALTER TABLE "subscriptions"
      DROP CONSTRAINT IF EXISTS "subscriptions_stripe_subscription_id_key";
    DROP INDEX IF EXISTS "subscriptions_stripe_subscription_id_idx";
    ALTER TABLE "subscriptions"
      RENAME COLUMN "stripe_subscription_id" TO "paystack_subscription_code";
    RAISE NOTICE 'subscriptions: renamed stripe_subscription_id → paystack_subscription_code';
  END IF;
END$$;

-- 4.4  Add paystack_subscription_code if still missing
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'subscriptions'
    AND column_name = 'paystack_subscription_code'
  ) THEN
    ALTER TABLE "subscriptions" ADD COLUMN "paystack_subscription_code" TEXT;
    RAISE NOTICE 'subscriptions: added paystack_subscription_code';
  END IF;
END$$;

-- 4.5  Unique constraint on paystack_subscription_code
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'subscriptions_paystack_subscription_code_key'
  ) THEN
    ALTER TABLE "subscriptions"
      ADD CONSTRAINT "subscriptions_paystack_subscription_code_key"
      UNIQUE ("paystack_subscription_code");
  END IF;
END$$;

-- 4.6  paystack_email_token
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'subscriptions'
    AND column_name = 'paystack_email_token'
  ) THEN
    ALTER TABLE "subscriptions" ADD COLUMN "paystack_email_token" TEXT;
    RAISE NOTICE 'subscriptions: added paystack_email_token';
  END IF;
END$$;

-- 4.7  paystack_customer_code on subscriptions
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'subscriptions'
    AND column_name = 'paystack_customer_code'
  ) THEN
    ALTER TABLE "subscriptions" ADD COLUMN "paystack_customer_code" TEXT;
    RAISE NOTICE 'subscriptions: added paystack_customer_code';
  END IF;
END$$;

-- 4.8  provider column — add if missing (added in schema v3)
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'subscriptions'
    AND column_name = 'provider'
  ) THEN
    ALTER TABLE "subscriptions"
      ADD COLUMN "provider" "PaymentProvider" NOT NULL DEFAULT 'PAYSTACK'::"PaymentProvider";
    RAISE NOTICE 'subscriptions: added provider column';
  END IF;
END$$;

-- 4.9  M-Pesa renewal tracking columns (added in schema v3)
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'subscriptions'
    AND column_name = 'mpesa_renewal_attempts'
  ) THEN
    ALTER TABLE "subscriptions"
      ADD COLUMN "mpesa_renewal_attempts" INTEGER NOT NULL DEFAULT 0;
  END IF;
END$$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'subscriptions'
    AND column_name = 'mpesa_last_renewal_at'
  ) THEN
    ALTER TABLE "subscriptions" ADD COLUMN "mpesa_last_renewal_at" TIMESTAMPTZ;
  END IF;
END$$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'subscriptions'
    AND column_name = 'grace_period_ends_at'
  ) THEN
    ALTER TABLE "subscriptions" ADD COLUMN "grace_period_ends_at" TIMESTAMPTZ;
  END IF;
END$$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'subscriptions'
    AND column_name = 'reminder_sent_at'
  ) THEN
    ALTER TABLE "subscriptions" ADD COLUMN "reminder_sent_at" TIMESTAMPTZ;
  END IF;
END$$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'subscriptions'
    AND column_name = 'auto_renew'
  ) THEN
    ALTER TABLE "subscriptions"
      ADD COLUMN "auto_renew" BOOLEAN NOT NULL DEFAULT true;
  END IF;
END$$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'subscriptions'
    AND column_name = 'expired_at'
  ) THEN
    ALTER TABLE "subscriptions" ADD COLUMN "expired_at" TIMESTAMPTZ;
  END IF;
END$$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'subscriptions'
    AND column_name = 'scheduled_plan_id'
  ) THEN
    ALTER TABLE "subscriptions" ADD COLUMN "scheduled_plan_id" TEXT;
  END IF;
END$$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'subscriptions'
    AND column_name = 'scheduled_interval'
  ) THEN
    ALTER TABLE "subscriptions"
      ADD COLUMN "scheduled_interval" "BillingInterval";
  END IF;
END$$;

-- ─────────────────────────────────────────────────────────────────────────────
-- SECTION 5 — payments table
-- ─────────────────────────────────────────────────────────────────────────────

-- 5.1  stripe_invoice_id → paystack_reference
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'payments'
    AND column_name = 'stripe_invoice_id'
  ) THEN
    ALTER TABLE "payments"
      DROP CONSTRAINT IF EXISTS "payments_stripe_invoice_id_key";
    DROP INDEX IF EXISTS "payments_stripe_invoice_id_idx";
    ALTER TABLE "payments"
      RENAME COLUMN "stripe_invoice_id" TO "paystack_reference";
    RAISE NOTICE 'payments: renamed stripe_invoice_id → paystack_reference';
  END IF;
END$$;

-- 5.2  Add paystack_reference if still missing
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'payments'
    AND column_name = 'paystack_reference'
  ) THEN
    ALTER TABLE "payments" ADD COLUMN "paystack_reference" TEXT;
    RAISE NOTICE 'payments: added paystack_reference';
  END IF;
END$$;

-- 5.3  mpesa_transaction_id
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'payments'
    AND column_name = 'mpesa_transaction_id'
  ) THEN
    ALTER TABLE "payments" ADD COLUMN "mpesa_transaction_id" TEXT;
    RAISE NOTICE 'payments: added mpesa_transaction_id';
  END IF;
END$$;

-- 5.4  mpesa_receipt_number
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'payments'
    AND column_name = 'mpesa_receipt_number'
  ) THEN
    ALTER TABLE "payments" ADD COLUMN "mpesa_receipt_number" TEXT;
    RAISE NOTICE 'payments: added mpesa_receipt_number';
  END IF;
END$$;

-- 5.5  provider column — add if missing
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'payments'
    AND column_name = 'provider'
  ) THEN
    ALTER TABLE "payments"
      ADD COLUMN "provider" "PaymentProvider" NOT NULL DEFAULT 'PAYSTACK'::"PaymentProvider";
    RAISE NOTICE 'payments: added provider column';
  END IF;
END$$;

-- 5.6  paid_at
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'payments'
    AND column_name = 'paid_at'
  ) THEN
    ALTER TABLE "payments" ADD COLUMN "paid_at" TIMESTAMPTZ;
  END IF;
END$$;

-- 5.7  refund columns
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'payments'
    AND column_name = 'failure_message'
  ) THEN
    ALTER TABLE "payments" ADD COLUMN "failure_message" TEXT;
  END IF;
END$$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'payments'
    AND column_name = 'refunded_at'
  ) THEN
    ALTER TABLE "payments" ADD COLUMN "refunded_at" TIMESTAMPTZ;
  END IF;
END$$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'payments'
    AND column_name = 'refund_amount_cents'
  ) THEN
    ALTER TABLE "payments" ADD COLUMN "refund_amount_cents" INTEGER;
  END IF;
END$$;

-- ─────────────────────────────────────────────────────────────────────────────
-- SECTION 6 — Update provider DEFAULT values
-- ─────────────────────────────────────────────────────────────────────────────

-- 6.1  subscriptions.provider default
ALTER TABLE "subscriptions"
  ALTER COLUMN "provider" SET DEFAULT 'PAYSTACK'::"PaymentProvider";

-- 6.2  payments.provider default
ALTER TABLE "payments"
  ALTER COLUMN "provider" SET DEFAULT 'PAYSTACK'::"PaymentProvider";

-- 6.3  webhook_events.provider default (text field, lowercase value)
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'webhook_events'
    AND column_name = 'provider'
  ) THEN
    ALTER TABLE "webhook_events"
      ALTER COLUMN "provider" SET DEFAULT 'paystack';
  END IF;
END$$;

-- 6.4  Migrate existing STRIPE rows to PAYSTACK
UPDATE "subscriptions"
  SET "provider" = 'PAYSTACK'::"PaymentProvider"
  WHERE "provider"::TEXT = 'STRIPE';

UPDATE "payments"
  SET "provider" = 'PAYSTACK'::"PaymentProvider"
  WHERE "provider"::TEXT = 'STRIPE';

-- ─────────────────────────────────────────────────────────────────────────────
-- SECTION 7 — New tables (CREATE TABLE IF NOT EXISTS)
-- All tables added since the Stripe-era schema.
-- ─────────────────────────────────────────────────────────────────────────────

-- 7.1  mpesa_transactions
CREATE TABLE IF NOT EXISTS "mpesa_transactions" (
  "id"                  TEXT        NOT NULL DEFAULT gen_random_uuid()::TEXT,
  "subscription_id"     TEXT,
  "plan_id"             TEXT,
  "user_id"             TEXT        NOT NULL,
  "merchant_request_id" TEXT        NOT NULL,
  "checkout_request_id" TEXT        NOT NULL,
  "mpesa_receipt_number" TEXT,
  "phone_number"        TEXT,
  "amount_kes"          INTEGER     NOT NULL,
  "status"              "MpesaTransactionStatus" NOT NULL DEFAULT 'PENDING',
  "result_code"         TEXT,
  "result_desc"         TEXT,
  "interval"            "BillingInterval" NOT NULL DEFAULT 'MONTHLY',
  "attempt_number"      INTEGER     NOT NULL DEFAULT 1,
  "is_renewal"          BOOLEAN     NOT NULL DEFAULT false,
  "initiated_at"        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  "completed_at"        TIMESTAMPTZ,
  "timeout_at"          TIMESTAMPTZ,
  CONSTRAINT "mpesa_transactions_pkey"               PRIMARY KEY ("id"),
  CONSTRAINT "mpesa_transactions_merchant_request_id_key" UNIQUE ("merchant_request_id"),
  CONSTRAINT "mpesa_transactions_checkout_request_id_key" UNIQUE ("checkout_request_id"),
  CONSTRAINT "mpesa_transactions_mpesa_receipt_number_key" UNIQUE ("mpesa_receipt_number"),
  CONSTRAINT "mpesa_transactions_subscription_id_fkey"
    FOREIGN KEY ("subscription_id") REFERENCES "subscriptions"("id") ON DELETE SET NULL,
  CONSTRAINT "mpesa_transactions_plan_id_fkey"
    FOREIGN KEY ("plan_id") REFERENCES "plans"("id") ON DELETE SET NULL,
  CONSTRAINT "mpesa_transactions_user_id_fkey"
    FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE
);

-- 7.2  subscription_logs
CREATE TABLE IF NOT EXISTS "subscription_logs" (
  "id"              TEXT        NOT NULL DEFAULT gen_random_uuid()::TEXT,
  "subscription_id" TEXT        NOT NULL,
  "event"           "SubscriptionEvent" NOT NULL,
  "previous_status" "SubscriptionStatus",
  "new_status"      "SubscriptionStatus",
  "metadata"        JSONB       NOT NULL DEFAULT '{}',
  "ip_address"      TEXT,
  "created_at"      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT "subscription_logs_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "subscription_logs_subscription_id_fkey"
    FOREIGN KEY ("subscription_id") REFERENCES "subscriptions"("id") ON DELETE CASCADE
);

-- 7.3  webhook_events
CREATE TABLE IF NOT EXISTS "webhook_events" (
  "id"              TEXT        NOT NULL DEFAULT gen_random_uuid()::TEXT,
  "external_id"     TEXT        NOT NULL DEFAULT '' UNIQUE,
  "provider"        TEXT        NOT NULL DEFAULT 'paystack',
  "event_type"      TEXT        NOT NULL,
  "processed_at"    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  "response_status" INTEGER     NOT NULL DEFAULT 200,
  "error"           TEXT,
  CONSTRAINT "webhook_events_pkey"        PRIMARY KEY ("id"),
  CONSTRAINT "webhook_events_external_id_key" UNIQUE ("external_id")
);

-- 7.4  cron_locks
CREATE TABLE IF NOT EXISTS "cron_locks" (
  "id"         TEXT        NOT NULL,
  "locked_at"  TIMESTAMPTZ NOT NULL,
  "expires_at" TIMESTAMPTZ NOT NULL,
  CONSTRAINT "cron_locks_pkey" PRIMARY KEY ("id")
);

-- 7.5  notifications
CREATE TABLE IF NOT EXISTS "notifications" (
  "id"         TEXT        NOT NULL DEFAULT gen_random_uuid()::TEXT,
  "user_id"    TEXT        NOT NULL,
  "type"       TEXT        NOT NULL,
  "title"      TEXT        NOT NULL,
  "body"       TEXT        NOT NULL,
  "icon"       TEXT        NOT NULL DEFAULT '🔔',
  "link"       TEXT,
  "read_at"    TIMESTAMPTZ,
  "created_at" TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT "notifications_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "notifications_user_id_fkey"
    FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE
);

-- 7.6  phone_otps
CREATE TABLE IF NOT EXISTS "phone_otps" (
  "id"         TEXT        NOT NULL DEFAULT gen_random_uuid()::TEXT,
  "user_id"    TEXT        NOT NULL,
  "phone"      TEXT        NOT NULL,
  "code_hash"  TEXT        NOT NULL,
  "attempts"   INTEGER     NOT NULL DEFAULT 0,
  "expires_at" TIMESTAMPTZ NOT NULL,
  "used_at"    TIMESTAMPTZ,
  "created_at" TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT "phone_otps_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "phone_otps_user_id_fkey"
    FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE
);

-- 7.7  user_memories
CREATE TABLE IF NOT EXISTS "user_memories" (
  "id"         TEXT        NOT NULL DEFAULT gen_random_uuid()::TEXT,
  "user_id"    TEXT        NOT NULL,
  "data"       JSONB       NOT NULL DEFAULT '{}',
  "updated_at" TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT "user_memories_pkey"    PRIMARY KEY ("id"),
  CONSTRAINT "user_memories_user_id_key" UNIQUE ("user_id")
);

-- 7.8  embeddings
CREATE TABLE IF NOT EXISTS "embeddings" (
  "id"         TEXT        NOT NULL DEFAULT gen_random_uuid()::TEXT,
  "user_id"    TEXT        NOT NULL,
  "text"       TEXT        NOT NULL,
  "vector"     JSONB       NOT NULL,
  "created_at" TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT "embeddings_pkey" PRIMARY KEY ("id")
);

-- 7.9  nutrition_logs
CREATE TABLE IF NOT EXISTS "nutrition_logs" (
  "id"         TEXT        NOT NULL DEFAULT gen_random_uuid()::TEXT,
  "user_id"    TEXT        NOT NULL,
  "name"       TEXT        NOT NULL,
  "calories"   DOUBLE PRECISION,
  "protein"    DOUBLE PRECISION,
  "carbs"      DOUBLE PRECISION,
  "fat"        DOUBLE PRECISION,
  "meal_type"  TEXT        NOT NULL DEFAULT 'OTHER',
  "date"       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  "created_at" TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  "updated_at" TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT "nutrition_logs_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "nutrition_logs_user_id_fkey"
    FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE
);

-- ─────────────────────────────────────────────────────────────────────────────
-- SECTION 8 — Enum additions (new values added in schema v3)
-- ─────────────────────────────────────────────────────────────────────────────

-- SubscriptionEvent additions
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_enum e JOIN pg_type t ON t.oid = e.enumtypid
                 WHERE t.typname = 'SubscriptionEvent' AND e.enumlabel = 'MPESA_STK_INITIATED') THEN
    ALTER TYPE "SubscriptionEvent" ADD VALUE 'MPESA_STK_INITIATED';
  END IF;
END$$;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_enum e JOIN pg_type t ON t.oid = e.enumtypid
                 WHERE t.typname = 'SubscriptionEvent' AND e.enumlabel = 'MPESA_STK_SUCCESS') THEN
    ALTER TYPE "SubscriptionEvent" ADD VALUE 'MPESA_STK_SUCCESS';
  END IF;
END$$;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_enum e JOIN pg_type t ON t.oid = e.enumtypid
                 WHERE t.typname = 'SubscriptionEvent' AND e.enumlabel = 'MPESA_STK_FAILED') THEN
    ALTER TYPE "SubscriptionEvent" ADD VALUE 'MPESA_STK_FAILED';
  END IF;
END$$;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_enum e JOIN pg_type t ON t.oid = e.enumtypid
                 WHERE t.typname = 'SubscriptionEvent' AND e.enumlabel = 'MPESA_RETRY_SCHEDULED') THEN
    ALTER TYPE "SubscriptionEvent" ADD VALUE 'MPESA_RETRY_SCHEDULED';
  END IF;
END$$;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_enum e JOIN pg_type t ON t.oid = e.enumtypid
                 WHERE t.typname = 'SubscriptionEvent' AND e.enumlabel = 'GRACE_PERIOD_STARTED') THEN
    ALTER TYPE "SubscriptionEvent" ADD VALUE 'GRACE_PERIOD_STARTED';
  END IF;
END$$;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_enum e JOIN pg_type t ON t.oid = e.enumtypid
                 WHERE t.typname = 'SubscriptionEvent' AND e.enumlabel = 'GRACE_PERIOD_EXPIRED') THEN
    ALTER TYPE "SubscriptionEvent" ADD VALUE 'GRACE_PERIOD_EXPIRED';
  END IF;
END$$;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_enum e JOIN pg_type t ON t.oid = e.enumtypid
                 WHERE t.typname = 'SubscriptionEvent' AND e.enumlabel = 'RENEWAL_REMINDER_SENT') THEN
    ALTER TYPE "SubscriptionEvent" ADD VALUE 'RENEWAL_REMINDER_SENT';
  END IF;
END$$;

-- SubscriptionStatus additions
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_enum e JOIN pg_type t ON t.oid = e.enumtypid
                 WHERE t.typname = 'SubscriptionStatus' AND e.enumlabel = 'GRACE_PERIOD') THEN
    ALTER TYPE "SubscriptionStatus" ADD VALUE 'GRACE_PERIOD';
  END IF;
END$$;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_enum e JOIN pg_type t ON t.oid = e.enumtypid
                 WHERE t.typname = 'SubscriptionStatus' AND e.enumlabel = 'PAUSED') THEN
    ALTER TYPE "SubscriptionStatus" ADD VALUE 'PAUSED';
  END IF;
END$$;

-- MpesaTransactionStatus enum (create if it doesn't exist at all)
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'MpesaTransactionStatus') THEN
    CREATE TYPE "MpesaTransactionStatus" AS ENUM (
      'PENDING', 'SUCCESS', 'FAILED', 'CANCELLED', 'TIMEOUT'
    );
    RAISE NOTICE 'Created enum MpesaTransactionStatus';
  END IF;
END$$;

-- User fields added in v3
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'users'
    AND column_name = 'mpesa_phone'
  ) THEN
    ALTER TABLE "users" ADD COLUMN "mpesa_phone" TEXT;
  END IF;
END$$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'users'
    AND column_name = 'phone_verified'
  ) THEN
    ALTER TABLE "users" ADD COLUMN "phone_verified" BOOLEAN NOT NULL DEFAULT false;
  END IF;
END$$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'users'
    AND column_name = 'phone_verified_at'
  ) THEN
    ALTER TABLE "users" ADD COLUMN "phone_verified_at" TIMESTAMPTZ;
  END IF;
END$$;

-- ─────────────────────────────────────────────────────────────────────────────
-- SECTION 9 — Drop orphaned Stripe columns
-- Drops any remaining stripe_* columns across all tables.
-- Runs AFTER all renames so the only columns matching stripe_* are truly orphaned.
-- ─────────────────────────────────────────────────────────────────────────────

DO $$
DECLARE
  r RECORD;
BEGIN
  FOR r IN
    SELECT table_name, column_name
    FROM information_schema.columns
    WHERE table_schema = 'public'
    AND column_name LIKE 'stripe_%'
  LOOP
    EXECUTE format(
      'ALTER TABLE %I DROP COLUMN IF EXISTS %I',
      r.table_name, r.column_name
    );
    RAISE NOTICE 'Dropped orphaned Stripe column: %.%', r.table_name, r.column_name;
  END LOOP;
END$$;

-- ─────────────────────────────────────────────────────────────────────────────
-- SECTION 10 — Indexes (CREATE INDEX IF NOT EXISTS for every @@index in schema)
-- ─────────────────────────────────────────────────────────────────────────────

-- subscriptions
CREATE INDEX IF NOT EXISTS "subscriptions_user_id_idx"
  ON "subscriptions" ("user_id");
CREATE INDEX IF NOT EXISTS "subscriptions_status_idx"
  ON "subscriptions" ("status");
CREATE INDEX IF NOT EXISTS "subscriptions_provider_idx"
  ON "subscriptions" ("provider");
CREATE INDEX IF NOT EXISTS "subscriptions_paystack_subscription_code_idx"
  ON "subscriptions" ("paystack_subscription_code");
CREATE INDEX IF NOT EXISTS "subscriptions_current_period_end_idx"
  ON "subscriptions" ("current_period_end");
CREATE INDEX IF NOT EXISTS "subscriptions_grace_period_ends_at_idx"
  ON "subscriptions" ("grace_period_ends_at");

-- mpesa_transactions
CREATE INDEX IF NOT EXISTS "mpesa_transactions_subscription_id_idx"
  ON "mpesa_transactions" ("subscription_id");
CREATE INDEX IF NOT EXISTS "mpesa_transactions_plan_id_idx"
  ON "mpesa_transactions" ("plan_id");
CREATE INDEX IF NOT EXISTS "mpesa_transactions_user_id_idx"
  ON "mpesa_transactions" ("user_id");
CREATE INDEX IF NOT EXISTS "mpesa_transactions_status_idx"
  ON "mpesa_transactions" ("status");
CREATE INDEX IF NOT EXISTS "mpesa_transactions_checkout_request_id_idx"
  ON "mpesa_transactions" ("checkout_request_id");
CREATE INDEX IF NOT EXISTS "mpesa_transactions_initiated_at_idx"
  ON "mpesa_transactions" ("initiated_at");

-- subscription_logs
CREATE INDEX IF NOT EXISTS "subscription_logs_subscription_id_idx"
  ON "subscription_logs" ("subscription_id");
CREATE INDEX IF NOT EXISTS "subscription_logs_event_idx"
  ON "subscription_logs" ("event");
CREATE INDEX IF NOT EXISTS "subscription_logs_created_at_idx"
  ON "subscription_logs" ("created_at");

-- webhook_events
CREATE INDEX IF NOT EXISTS "webhook_events_external_id_idx"
  ON "webhook_events" ("external_id");
CREATE INDEX IF NOT EXISTS "webhook_events_provider_idx"
  ON "webhook_events" ("provider");
CREATE INDEX IF NOT EXISTS "webhook_events_processed_at_idx"
  ON "webhook_events" ("processed_at");

-- notifications
CREATE INDEX IF NOT EXISTS "notifications_user_id_idx"
  ON "notifications" ("user_id");
CREATE INDEX IF NOT EXISTS "notifications_read_at_idx"
  ON "notifications" ("read_at");
CREATE INDEX IF NOT EXISTS "notifications_created_at_idx"
  ON "notifications" ("created_at");

-- phone_otps
CREATE INDEX IF NOT EXISTS "phone_otps_user_id_idx"
  ON "phone_otps" ("user_id");
CREATE INDEX IF NOT EXISTS "phone_otps_phone_idx"
  ON "phone_otps" ("phone");
CREATE INDEX IF NOT EXISTS "phone_otps_expires_at_idx"
  ON "phone_otps" ("expires_at");

-- payments
CREATE INDEX IF NOT EXISTS "payments_subscription_id_idx"
  ON "payments" ("subscription_id");
CREATE INDEX IF NOT EXISTS "payments_provider_idx"
  ON "payments" ("provider");
CREATE INDEX IF NOT EXISTS "payments_status_idx"
  ON "payments" ("status");

-- embeddings
CREATE INDEX IF NOT EXISTS "embeddings_user_id_idx"
  ON "embeddings" ("user_id");
CREATE INDEX IF NOT EXISTS "embeddings_user_id_created_at_idx"
  ON "embeddings" ("user_id", "created_at");

-- nutrition_logs
CREATE INDEX IF NOT EXISTS "nutrition_logs_user_id_idx"
  ON "nutrition_logs" ("user_id");
CREATE INDEX IF NOT EXISTS "nutrition_logs_user_id_date_idx"
  ON "nutrition_logs" ("user_id", "date");

COMMIT;

-- ─────────────────────────────────────────────────────────────────────────────
-- POST-MIGRATION VERIFICATION QUERIES
-- Run these manually after applying the migration to confirm success.
-- ─────────────────────────────────────────────────────────────────────────────

-- 1. Confirm PaymentProvider enum values
--    Expected: PAYSTACK, MPESA, MANUAL  (no STRIPE)
-- SELECT enumlabel FROM pg_enum e JOIN pg_type t ON t.oid = e.enumtypid
-- WHERE t.typname = 'PaymentProvider' ORDER BY enumsortorder;

-- 2. Confirm no Stripe columns remain
--    Expected: 0 rows
-- SELECT table_name, column_name FROM information_schema.columns
-- WHERE table_schema = 'public' AND column_name LIKE 'stripe_%';

-- 3. Confirm new Paystack columns exist on key tables
-- SELECT column_name FROM information_schema.columns
-- WHERE table_schema = 'public' AND table_name = 'subscriptions'
-- AND column_name LIKE 'paystack_%' ORDER BY column_name;

-- 4. Confirm all new tables exist
-- SELECT tablename FROM pg_tables
-- WHERE schemaname = 'public'
-- AND tablename IN (
--   'mpesa_transactions','subscription_logs','webhook_events',
--   'cron_locks','notifications','phone_otps',
--   'user_memories','embeddings','nutrition_logs'
-- )
-- ORDER BY tablename;
