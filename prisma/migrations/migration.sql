-- ============================================================
-- FLOWFIT — Stripe → Paystack Migration
-- Generated: 2026-04-28
-- ============================================================
--
-- WHAT THIS MIGRATION DOES
-- ─────────────────────────
-- 1.  Adds new PostgreSQL ENUM types (PaymentProvider,
--     MpesaTransactionStatus, SubscriptionEvent) and extends
--     SubscriptionStatus with four new values.
-- 2.  Drops all Stripe columns from users / plans /
--     subscriptions / payments (each wrapped in IF EXISTS so
--     re-running is safe if they were already removed).
-- 3.  Adds all Paystack + M-Pesa columns to those tables.
-- 4.  Creates eight new tables that did not exist in the
--     Stripe schema.
-- 5.  Adds every index and foreign-key declared in the
--     Prisma schema (all guarded with IF NOT EXISTS /
--     existence checks so the script is fully idempotent).
--
-- PREREQUISITES
-- ─────────────
-- • PostgreSQL 13 + (gen_random_uuid() built-in, no extension needed).
-- • Run as a superuser or a role that owns the target tables.
--
-- IMPORTANT — ENUM CAVEATS
-- ─────────────────────────
-- ALTER TYPE ... ADD VALUE cannot be executed inside an
-- explicit transaction block in PostgreSQL < 12.
-- If your migration runner wraps everything in BEGIN/COMMIT,
-- either:
--   (a) split STEP 1 into a separate script and run it first,
--   (b) upgrade to PostgreSQL 12+ (Vercel/Neon ship PG 15),
--   (c) or accept that Prisma's migrate deploy will handle it.
-- ============================================================


-- ============================================================
-- STEP 1 — ENUM TYPES
-- Must appear before any column that references them.
-- ============================================================

-- 1a. PaymentProvider (brand-new enum)
DO $$ BEGIN
  CREATE TYPE "PaymentProvider" AS ENUM ('PAYSTACK', 'MPESA', 'MANUAL');
EXCEPTION WHEN duplicate_object THEN
  RAISE NOTICE 'PaymentProvider already exists — skipping';
END $$;

-- 1b. MpesaTransactionStatus (brand-new enum)
DO $$ BEGIN
  CREATE TYPE "MpesaTransactionStatus" AS ENUM (
    'PENDING', 'SUCCESS', 'FAILED', 'CANCELLED', 'TIMEOUT'
  );
EXCEPTION WHEN duplicate_object THEN
  RAISE NOTICE 'MpesaTransactionStatus already exists — skipping';
END $$;

-- 1c. SubscriptionEvent (brand-new enum)
DO $$ BEGIN
  CREATE TYPE "SubscriptionEvent" AS ENUM (
    'CREATED',
    'TRIAL_STARTED',
    'TRIAL_CONVERTED',
    'TRIAL_EXPIRED',
    'ACTIVATED',
    'PAYMENT_SUCCEEDED',
    'PAYMENT_FAILED',
    'UPGRADED',
    'DOWNGRADE_SCHEDULED',
    'DOWNGRADE_APPLIED',
    'CANCEL_SCHEDULED',
    'CANCELLED',
    'REACTIVATED',
    'EXPIRED',
    'REFUNDED',
    'WEBHOOK_RECEIVED',
    'MPESA_STK_INITIATED',
    'MPESA_STK_SUCCESS',
    'MPESA_STK_FAILED',
    'MPESA_RETRY_SCHEDULED',
    'GRACE_PERIOD_STARTED',
    'GRACE_PERIOD_EXPIRED',
    'RENEWAL_REMINDER_SENT'
  );
EXCEPTION WHEN duplicate_object THEN
  RAISE NOTICE 'SubscriptionEvent already exists — skipping';
END $$;

-- 1d. Extend SubscriptionStatus (assumed to exist from the original schema).
--     IF NOT EXISTS is supported in PG 9.6+.
ALTER TYPE "SubscriptionStatus" ADD VALUE IF NOT EXISTS 'GRACE_PERIOD';
ALTER TYPE "SubscriptionStatus" ADD VALUE IF NOT EXISTS 'INCOMPLETE';
ALTER TYPE "SubscriptionStatus" ADD VALUE IF NOT EXISTS 'INCOMPLETE_EXPIRED';
ALTER TYPE "SubscriptionStatus" ADD VALUE IF NOT EXISTS 'PAUSED';


-- ============================================================
-- STEP 2 — users TABLE
-- ============================================================

-- 2a. Drop Stripe column
ALTER TABLE users DROP COLUMN IF EXISTS stripe_customer_id;

-- 2b. Add Paystack / M-Pesa columns
ALTER TABLE users
  ADD COLUMN IF NOT EXISTS paystack_customer_code TEXT,
  ADD COLUMN IF NOT EXISTS mpesa_phone            TEXT,
  ADD COLUMN IF NOT EXISTS phone_verified         BOOLEAN      NOT NULL DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS phone_verified_at      TIMESTAMP(3);

-- 2c. Unique constraint on paystack_customer_code
DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.table_constraints
    WHERE table_name = 'users'
      AND constraint_name = 'users_paystack_customer_code_key'
  ) THEN
    ALTER TABLE users
      ADD CONSTRAINT users_paystack_customer_code_key
      UNIQUE (paystack_customer_code);
  END IF;
END $$;


-- ============================================================
-- STEP 3 — plans TABLE
-- ============================================================

-- 3a. Drop Stripe columns
ALTER TABLE plans DROP COLUMN IF EXISTS stripe_price_id_monthly;
ALTER TABLE plans DROP COLUMN IF EXISTS stripe_price_id_yearly;

-- 3b. Add Paystack / M-Pesa columns
ALTER TABLE plans
  ADD COLUMN IF NOT EXISTS mpesa_monthly_kes          INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS mpesa_yearly_kes           INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS paystack_plan_code_monthly TEXT,
  ADD COLUMN IF NOT EXISTS paystack_plan_code_yearly  TEXT;

-- 3c. Unique constraints on Paystack plan codes
DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.table_constraints
    WHERE table_name = 'plans'
      AND constraint_name = 'plans_paystack_plan_code_monthly_key'
  ) THEN
    ALTER TABLE plans
      ADD CONSTRAINT plans_paystack_plan_code_monthly_key
      UNIQUE (paystack_plan_code_monthly);
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.table_constraints
    WHERE table_name = 'plans'
      AND constraint_name = 'plans_paystack_plan_code_yearly_key'
  ) THEN
    ALTER TABLE plans
      ADD CONSTRAINT plans_paystack_plan_code_yearly_key
      UNIQUE (paystack_plan_code_yearly);
  END IF;
END $$;


-- ============================================================
-- STEP 4 — subscriptions TABLE
-- ============================================================

-- 4a. Drop Stripe columns
ALTER TABLE subscriptions DROP COLUMN IF EXISTS stripe_subscription_id;
ALTER TABLE subscriptions DROP COLUMN IF EXISTS stripe_checkout_session_id;

-- 4b. Add Paystack / M-Pesa / lifecycle columns
ALTER TABLE subscriptions
  ADD COLUMN IF NOT EXISTS provider                   "PaymentProvider" NOT NULL DEFAULT 'PAYSTACK',
  ADD COLUMN IF NOT EXISTS auto_renew                 BOOLEAN           NOT NULL DEFAULT TRUE,
  ADD COLUMN IF NOT EXISTS paystack_subscription_code TEXT,
  ADD COLUMN IF NOT EXISTS paystack_email_token       TEXT,
  ADD COLUMN IF NOT EXISTS paystack_reference         TEXT,
  ADD COLUMN IF NOT EXISTS paystack_customer_code     TEXT,
  ADD COLUMN IF NOT EXISTS cancelled_at               TIMESTAMP(3),
  ADD COLUMN IF NOT EXISTS cancellation_reason        TEXT,
  ADD COLUMN IF NOT EXISTS scheduled_plan_id          TEXT,
  ADD COLUMN IF NOT EXISTS scheduled_interval         "BillingInterval",
  ADD COLUMN IF NOT EXISTS mpesa_renewal_attempts     INTEGER           NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS mpesa_last_renewal_at      TIMESTAMP(3),
  ADD COLUMN IF NOT EXISTS grace_period_ends_at       TIMESTAMP(3),
  ADD COLUMN IF NOT EXISTS reminder_sent_at           TIMESTAMP(3),
  ADD COLUMN IF NOT EXISTS activated_at               TIMESTAMP(3),
  ADD COLUMN IF NOT EXISTS expired_at                 TIMESTAMP(3);

-- 4c. Unique constraint on paystack_subscription_code
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

-- 4d. FK — scheduled_plan_id → plans(id)  (nullable, SET NULL on delete)
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

-- 4e. Indexes
CREATE INDEX IF NOT EXISTS subscriptions_provider_idx
  ON subscriptions (provider);

CREATE INDEX IF NOT EXISTS subscriptions_paystack_subscription_code_idx
  ON subscriptions (paystack_subscription_code);

CREATE INDEX IF NOT EXISTS subscriptions_current_period_end_idx
  ON subscriptions (current_period_end);

CREATE INDEX IF NOT EXISTS subscriptions_grace_period_ends_at_idx
  ON subscriptions (grace_period_ends_at);


-- ============================================================
-- STEP 5 — payments TABLE
-- ============================================================

-- 5a. Drop Stripe columns
ALTER TABLE payments DROP COLUMN IF EXISTS stripe_invoice_id;
ALTER TABLE payments DROP COLUMN IF EXISTS stripe_payment_intent_id;

-- 5b. Add Paystack / M-Pesa columns
ALTER TABLE payments
  ADD COLUMN IF NOT EXISTS provider             "PaymentProvider" NOT NULL DEFAULT 'PAYSTACK',
  ADD COLUMN IF NOT EXISTS paystack_reference   TEXT,
  ADD COLUMN IF NOT EXISTS paid_at              TIMESTAMP(3),
  ADD COLUMN IF NOT EXISTS mpesa_transaction_id TEXT,
  ADD COLUMN IF NOT EXISTS mpesa_receipt_number TEXT,
  ADD COLUMN IF NOT EXISTS failure_message      TEXT,
  ADD COLUMN IF NOT EXISTS refunded_at          TIMESTAMP(3),
  ADD COLUMN IF NOT EXISTS refund_amount_cents  INTEGER;

-- 5c. Indexes
CREATE INDEX IF NOT EXISTS payments_provider_idx
  ON payments (provider);

CREATE INDEX IF NOT EXISTS payments_status_idx
  ON payments (status);

CREATE INDEX IF NOT EXISTS payments_paystack_reference_idx
  ON payments (paystack_reference);

CREATE INDEX IF NOT EXISTS payments_subscription_id_idx
  ON payments (subscription_id);


-- ============================================================
-- STEP 6 — phone_otps TABLE  (new)
-- ============================================================

CREATE TABLE IF NOT EXISTS phone_otps (
  id          TEXT         NOT NULL PRIMARY KEY DEFAULT gen_random_uuid()::TEXT,
  user_id     TEXT         NOT NULL,
  phone       TEXT         NOT NULL,
  code_hash   TEXT         NOT NULL,
  attempts    INTEGER      NOT NULL DEFAULT 0,
  expires_at  TIMESTAMP(3) NOT NULL,
  used_at     TIMESTAMP(3),
  created_at  TIMESTAMP(3) NOT NULL DEFAULT NOW(),

  CONSTRAINT phone_otps_user_id_fkey
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS phone_otps_user_id_idx    ON phone_otps (user_id);
CREATE INDEX IF NOT EXISTS phone_otps_phone_idx      ON phone_otps (phone);
CREATE INDEX IF NOT EXISTS phone_otps_expires_at_idx ON phone_otps (expires_at);


-- ============================================================
-- STEP 7 — notifications TABLE  (new)
-- ============================================================

CREATE TABLE IF NOT EXISTS notifications (
  id          TEXT         NOT NULL PRIMARY KEY DEFAULT gen_random_uuid()::TEXT,
  user_id     TEXT         NOT NULL,
  type        TEXT         NOT NULL,
  title       TEXT         NOT NULL,
  body        TEXT         NOT NULL,
  icon        TEXT         NOT NULL DEFAULT '🔔',
  link        TEXT,
  read_at     TIMESTAMP(3),
  created_at  TIMESTAMP(3) NOT NULL DEFAULT NOW(),

  CONSTRAINT notifications_user_id_fkey
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS notifications_user_id_idx   ON notifications (user_id);
CREATE INDEX IF NOT EXISTS notifications_read_at_idx   ON notifications (read_at);
CREATE INDEX IF NOT EXISTS notifications_created_at_idx ON notifications (created_at);


-- ============================================================
-- STEP 8 — mpesa_transactions TABLE  (new)
-- ============================================================

CREATE TABLE IF NOT EXISTS mpesa_transactions (
  id                   TEXT                    NOT NULL PRIMARY KEY DEFAULT gen_random_uuid()::TEXT,
  subscription_id      TEXT,
  plan_id              TEXT,
  user_id              TEXT                    NOT NULL,
  merchant_request_id  TEXT                    NOT NULL,
  checkout_request_id  TEXT                    NOT NULL,
  mpesa_receipt_number TEXT,
  phone_number         TEXT,
  amount_kes           INTEGER                 NOT NULL,
  status               "MpesaTransactionStatus" NOT NULL DEFAULT 'PENDING',
  result_code          TEXT,
  result_desc          TEXT,
  interval             "BillingInterval"       NOT NULL DEFAULT 'MONTHLY',
  attempt_number       INTEGER                 NOT NULL DEFAULT 1,
  is_renewal           BOOLEAN                 NOT NULL DEFAULT FALSE,
  initiated_at         TIMESTAMP(3)            NOT NULL DEFAULT NOW(),
  completed_at         TIMESTAMP(3),
  timeout_at           TIMESTAMP(3),

  CONSTRAINT mpesa_transactions_merchant_request_id_key UNIQUE (merchant_request_id),
  CONSTRAINT mpesa_transactions_checkout_request_id_key UNIQUE (checkout_request_id),
  CONSTRAINT mpesa_transactions_mpesa_receipt_number_key UNIQUE (mpesa_receipt_number),

  CONSTRAINT mpesa_transactions_subscription_id_fkey
    FOREIGN KEY (subscription_id) REFERENCES subscriptions(id) ON DELETE SET NULL,
  CONSTRAINT mpesa_transactions_plan_id_fkey
    FOREIGN KEY (plan_id) REFERENCES plans(id) ON DELETE SET NULL,
  CONSTRAINT mpesa_transactions_user_id_fkey
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS mpesa_transactions_subscription_id_idx
  ON mpesa_transactions (subscription_id);
CREATE INDEX IF NOT EXISTS mpesa_transactions_plan_id_idx
  ON mpesa_transactions (plan_id);
CREATE INDEX IF NOT EXISTS mpesa_transactions_user_id_idx
  ON mpesa_transactions (user_id);
CREATE INDEX IF NOT EXISTS mpesa_transactions_status_idx
  ON mpesa_transactions (status);
CREATE INDEX IF NOT EXISTS mpesa_transactions_checkout_request_id_idx
  ON mpesa_transactions (checkout_request_id);
CREATE INDEX IF NOT EXISTS mpesa_transactions_initiated_at_idx
  ON mpesa_transactions (initiated_at);


-- ============================================================
-- STEP 9 — subscription_logs TABLE  (new)
-- ============================================================

CREATE TABLE IF NOT EXISTS subscription_logs (
  id              TEXT                 NOT NULL PRIMARY KEY DEFAULT gen_random_uuid()::TEXT,
  subscription_id TEXT                 NOT NULL,
  event           "SubscriptionEvent"  NOT NULL,
  previous_status "SubscriptionStatus",
  new_status      "SubscriptionStatus",
  metadata        JSONB                NOT NULL DEFAULT '{}',
  ip_address      TEXT,
  created_at      TIMESTAMP(3)         NOT NULL DEFAULT NOW(),

  CONSTRAINT subscription_logs_subscription_id_fkey
    FOREIGN KEY (subscription_id) REFERENCES subscriptions(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS subscription_logs_subscription_id_idx
  ON subscription_logs (subscription_id);
CREATE INDEX IF NOT EXISTS subscription_logs_event_idx
  ON subscription_logs (event);
CREATE INDEX IF NOT EXISTS subscription_logs_created_at_idx
  ON subscription_logs (created_at);


-- ============================================================
-- STEP 10 — webhook_events TABLE  (new)
-- ============================================================

CREATE TABLE IF NOT EXISTS webhook_events (
  id              TEXT         NOT NULL PRIMARY KEY DEFAULT gen_random_uuid()::TEXT,
  external_id     TEXT         NOT NULL DEFAULT '' UNIQUE,
  provider        TEXT         NOT NULL DEFAULT 'paystack',
  event_type      TEXT         NOT NULL,
  processed_at    TIMESTAMP(3) NOT NULL DEFAULT NOW(),
  response_status INTEGER      NOT NULL DEFAULT 200,
  error           TEXT
);

CREATE INDEX IF NOT EXISTS webhook_events_external_id_idx   ON webhook_events (external_id);
CREATE INDEX IF NOT EXISTS webhook_events_provider_idx      ON webhook_events (provider);
CREATE INDEX IF NOT EXISTS webhook_events_processed_at_idx  ON webhook_events (processed_at);


-- ============================================================
-- STEP 11 — cron_locks TABLE  (new)
-- ============================================================

CREATE TABLE IF NOT EXISTS cron_locks (
  id         TEXT         NOT NULL PRIMARY KEY,
  locked_at  TIMESTAMP(3) NOT NULL,
  expires_at TIMESTAMP(3) NOT NULL
);


-- ============================================================
-- STEP 12 — otp_codes TABLE  (new)
-- ============================================================

CREATE TABLE IF NOT EXISTS otp_codes (
  id         TEXT         NOT NULL PRIMARY KEY DEFAULT gen_random_uuid()::TEXT,
  email      TEXT         NOT NULL,
  code_hash  TEXT         NOT NULL,
  purpose    TEXT         NOT NULL,
  created_at TIMESTAMP(3) NOT NULL DEFAULT NOW(),
  expires_at TIMESTAMP(3) NOT NULL,
  used_at    TIMESTAMP(3)
);

CREATE INDEX IF NOT EXISTS otp_codes_email_idx
  ON otp_codes (email);
CREATE INDEX IF NOT EXISTS otp_codes_email_purpose_idx
  ON otp_codes (email, purpose);


-- ============================================================
-- STEP 13 — embeddings TABLE  (new)
-- ============================================================

CREATE TABLE IF NOT EXISTS embeddings (
  id         TEXT         NOT NULL PRIMARY KEY DEFAULT gen_random_uuid()::TEXT,
  user_id    TEXT         NOT NULL,
  text       TEXT         NOT NULL,
  vector     JSONB        NOT NULL,
  created_at TIMESTAMP(3) NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS embeddings_user_id_idx
  ON embeddings (user_id);
CREATE INDEX IF NOT EXISTS embeddings_user_id_created_at_idx
  ON embeddings (user_id, created_at);


-- ============================================================
-- STEP 14 — user_memories TABLE  (new)
-- ============================================================

CREATE TABLE IF NOT EXISTS user_memories (
  id         TEXT         NOT NULL PRIMARY KEY DEFAULT gen_random_uuid()::TEXT,
  user_id    TEXT         NOT NULL UNIQUE,
  data       JSONB        NOT NULL DEFAULT '{}',
  updated_at TIMESTAMP(3) NOT NULL DEFAULT NOW()
);


-- ============================================================
-- STEP 15 — nutrition_logs TABLE  (new)
-- ============================================================

-- Note: Prisma uses cuid() for the id (app-generated), so there
-- is no DB-level default — Prisma always supplies the value.
CREATE TABLE IF NOT EXISTS nutrition_logs (
  id         TEXT             NOT NULL PRIMARY KEY,
  user_id    TEXT             NOT NULL,
  name       TEXT             NOT NULL,
  calories   DOUBLE PRECISION,
  protein    DOUBLE PRECISION,
  carbs      DOUBLE PRECISION,
  fat        DOUBLE PRECISION,
  meal_type  TEXT             NOT NULL DEFAULT 'OTHER',
  date       TIMESTAMP(3)     NOT NULL DEFAULT NOW(),
  created_at TIMESTAMP(3)     NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMP(3)     NOT NULL DEFAULT NOW(),

  CONSTRAINT nutrition_logs_user_id_fkey
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS nutrition_logs_user_id_idx
  ON nutrition_logs (user_id);
CREATE INDEX IF NOT EXISTS nutrition_logs_user_id_date_idx
  ON nutrition_logs (user_id, date);


-- ============================================================
-- DONE
-- ============================================================
-- After running this script, sync Prisma's shadow database so
-- it does not try to re-apply these changes:
--
--   npx prisma migrate resolve --applied "your_migration_name"
--
-- Or, if you generated the migration with prisma migrate dev,
-- simply move this file into the correct migration folder and
-- Prisma will mark it as applied automatically.
-- ============================================================
