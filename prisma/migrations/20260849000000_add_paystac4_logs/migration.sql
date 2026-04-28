-- ============================================================
-- FLOWFIT — Complete Stripe → Paystack Migration (FINAL)
-- Consolidates main migration + all patches into one file.
-- Fully idempotent — safe to run on a fresh or partial DB.
-- PostgreSQL 13+ required (gen_random_uuid built-in).
-- ============================================================
-- ORDER OF OPERATIONS:
--   1. Enum types
--   2. Alter existing tables  (columns first, indexes last)
--   3. Create new tables      (table first, indexes last)
-- ============================================================


-- ============================================================
-- STEP 1 — ENUM TYPES
-- ============================================================

DO $$ BEGIN
  CREATE TYPE "PaymentProvider" AS ENUM ('PAYSTACK', 'MPESA', 'MANUAL');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

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
    'CANCEL_SCHEDULED', 'CANCELLED', 'REACTIVATED', 'EXPIRED',
    'REFUNDED', 'WEBHOOK_RECEIVED',
    'MPESA_STK_INITIATED', 'MPESA_STK_SUCCESS', 'MPESA_STK_FAILED',
    'MPESA_RETRY_SCHEDULED', 'GRACE_PERIOD_STARTED',
    'GRACE_PERIOD_EXPIRED', 'RENEWAL_REMINDER_SENT'
  );
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

ALTER TYPE "SubscriptionStatus" ADD VALUE IF NOT EXISTS 'GRACE_PERIOD';
ALTER TYPE "SubscriptionStatus" ADD VALUE IF NOT EXISTS 'INCOMPLETE';
ALTER TYPE "SubscriptionStatus" ADD VALUE IF NOT EXISTS 'INCOMPLETE_EXPIRED';
ALTER TYPE "SubscriptionStatus" ADD VALUE IF NOT EXISTS 'PAUSED';


-- ============================================================
-- STEP 2 — users TABLE
-- ============================================================

ALTER TABLE users DROP COLUMN IF EXISTS stripe_customer_id;

ALTER TABLE users
  ADD COLUMN IF NOT EXISTS paystack_customer_code TEXT,
  ADD COLUMN IF NOT EXISTS mpesa_phone            TEXT,
  ADD COLUMN IF NOT EXISTS phone_verified         BOOLEAN      NOT NULL DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS phone_verified_at      TIMESTAMP(3);

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

ALTER TABLE plans DROP COLUMN IF EXISTS stripe_price_id_monthly;
ALTER TABLE plans DROP COLUMN IF EXISTS stripe_price_id_yearly;

ALTER TABLE plans
  ADD COLUMN IF NOT EXISTS mpesa_monthly_kes          INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS mpesa_yearly_kes           INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS paystack_plan_code_monthly TEXT,
  ADD COLUMN IF NOT EXISTS paystack_plan_code_yearly  TEXT;

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
-- STEP 4 — subscriptions TABLE (columns first, indexes last)
-- ============================================================

ALTER TABLE subscriptions DROP COLUMN IF EXISTS stripe_subscription_id;
ALTER TABLE subscriptions DROP COLUMN IF EXISTS stripe_checkout_session_id;

ALTER TABLE subscriptions
  ADD COLUMN IF NOT EXISTS current_period_start        TIMESTAMP(3),
  ADD COLUMN IF NOT EXISTS current_period_end          TIMESTAMP(3),
  ADD COLUMN IF NOT EXISTS trial_started_at            TIMESTAMP(3),
  ADD COLUMN IF NOT EXISTS trial_ends_at               TIMESTAMP(3),
  ADD COLUMN IF NOT EXISTS provider                    "PaymentProvider" NOT NULL DEFAULT 'PAYSTACK',
  ADD COLUMN IF NOT EXISTS auto_renew                  BOOLEAN           NOT NULL DEFAULT TRUE,
  ADD COLUMN IF NOT EXISTS paystack_subscription_code  TEXT,
  ADD COLUMN IF NOT EXISTS paystack_email_token        TEXT,
  ADD COLUMN IF NOT EXISTS paystack_reference          TEXT,
  ADD COLUMN IF NOT EXISTS paystack_customer_code      TEXT,
  ADD COLUMN IF NOT EXISTS cancelled_at                TIMESTAMP(3),
  ADD COLUMN IF NOT EXISTS cancellation_reason         TEXT,
  ADD COLUMN IF NOT EXISTS scheduled_plan_id           TEXT,
  ADD COLUMN IF NOT EXISTS scheduled_interval          "BillingInterval",
  ADD COLUMN IF NOT EXISTS mpesa_renewal_attempts      INTEGER           NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS mpesa_last_renewal_at       TIMESTAMP(3),
  ADD COLUMN IF NOT EXISTS grace_period_ends_at        TIMESTAMP(3),
  ADD COLUMN IF NOT EXISTS reminder_sent_at            TIMESTAMP(3),
  ADD COLUMN IF NOT EXISTS activated_at                TIMESTAMP(3),
  ADD COLUMN IF NOT EXISTS expired_at                  TIMESTAMP(3);

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

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.table_constraints
    WHERE table_name = 'subscriptions'
      AND constraint_name = 'subscriptions_scheduled_plan_id_fkey'
  ) THEN
    ALTER TABLE subscriptions
      ADD CONSTRAINT subscriptions_scheduled_plan_id_fkey
      FOREIGN KEY (scheduled_plan_id) REFERENCES plans(id) ON DELETE SET NULL;
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS subscriptions_provider_idx
  ON subscriptions (provider);
CREATE INDEX IF NOT EXISTS subscriptions_paystack_subscription_code_idx
  ON subscriptions (paystack_subscription_code);
CREATE INDEX IF NOT EXISTS subscriptions_current_period_end_idx
  ON subscriptions (current_period_end);
CREATE INDEX IF NOT EXISTS subscriptions_grace_period_ends_at_idx
  ON subscriptions (grace_period_ends_at);


-- ============================================================
-- STEP 5 — payments TABLE (columns first, indexes last)
-- ============================================================

ALTER TABLE payments DROP COLUMN IF EXISTS stripe_invoice_id;
ALTER TABLE payments DROP COLUMN IF EXISTS stripe_payment_intent_id;

ALTER TABLE payments
  ADD COLUMN IF NOT EXISTS subscription_id       TEXT,
  ADD COLUMN IF NOT EXISTS provider              "PaymentProvider" NOT NULL DEFAULT 'PAYSTACK',
  ADD COLUMN IF NOT EXISTS paystack_reference    TEXT,
  ADD COLUMN IF NOT EXISTS paid_at               TIMESTAMP(3),
  ADD COLUMN IF NOT EXISTS mpesa_transaction_id  TEXT,
  ADD COLUMN IF NOT EXISTS mpesa_receipt_number  TEXT,
  ADD COLUMN IF NOT EXISTS amount_cents          INTEGER          NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS currency              TEXT             NOT NULL DEFAULT 'KES',
  ADD COLUMN IF NOT EXISTS status                TEXT             NOT NULL DEFAULT 'succeeded',
  ADD COLUMN IF NOT EXISTS failure_message       TEXT,
  ADD COLUMN IF NOT EXISTS refunded_at           TIMESTAMP(3),
  ADD COLUMN IF NOT EXISTS refund_amount_cents   INTEGER,
  ADD COLUMN IF NOT EXISTS created_at            TIMESTAMP(3)     NOT NULL DEFAULT NOW();

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.table_constraints
    WHERE table_name = 'payments'
      AND constraint_name = 'payments_subscription_id_fkey'
  ) THEN
    ALTER TABLE payments
      ADD CONSTRAINT payments_subscription_id_fkey
      FOREIGN KEY (subscription_id) REFERENCES subscriptions(id) ON DELETE CASCADE;
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS payments_subscription_id_idx
  ON payments (subscription_id);
CREATE INDEX IF NOT EXISTS payments_provider_idx
  ON payments (provider);
CREATE INDEX IF NOT EXISTS payments_status_idx
  ON payments (status);
CREATE INDEX IF NOT EXISTS payments_paystack_reference_idx
  ON payments (paystack_reference);


-- ============================================================
-- STEP 6 — phone_otps TABLE
-- ============================================================

CREATE TABLE IF NOT EXISTS phone_otps (
  id         TEXT         NOT NULL PRIMARY KEY DEFAULT gen_random_uuid()::TEXT,
  user_id    TEXT         NOT NULL,
  phone      TEXT         NOT NULL,
  code_hash  TEXT         NOT NULL,
  attempts   INTEGER      NOT NULL DEFAULT 0,
  expires_at TIMESTAMP(3) NOT NULL,
  used_at    TIMESTAMP(3),
  created_at TIMESTAMP(3) NOT NULL DEFAULT NOW()
);

-- Ensure columns exist even if table was partially created before
ALTER TABLE phone_otps
  ADD COLUMN IF NOT EXISTS user_id    TEXT         NOT NULL DEFAULT '',
  ADD COLUMN IF NOT EXISTS phone      TEXT         NOT NULL DEFAULT '',
  ADD COLUMN IF NOT EXISTS code_hash  TEXT         NOT NULL DEFAULT '',
  ADD COLUMN IF NOT EXISTS attempts   INTEGER      NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS expires_at TIMESTAMP(3),
  ADD COLUMN IF NOT EXISTS used_at    TIMESTAMP(3),
  ADD COLUMN IF NOT EXISTS created_at TIMESTAMP(3) NOT NULL DEFAULT NOW();

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.table_constraints
    WHERE table_name = 'phone_otps'
      AND constraint_name = 'phone_otps_user_id_fkey'
  ) THEN
    ALTER TABLE phone_otps
      ADD CONSTRAINT phone_otps_user_id_fkey
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE;
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS phone_otps_user_id_idx    ON phone_otps (user_id);
CREATE INDEX IF NOT EXISTS phone_otps_phone_idx      ON phone_otps (phone);
CREATE INDEX IF NOT EXISTS phone_otps_expires_at_idx ON phone_otps (expires_at);


-- ============================================================
-- STEP 7 — notifications TABLE
-- ============================================================

CREATE TABLE IF NOT EXISTS notifications (
  id         TEXT         NOT NULL PRIMARY KEY DEFAULT gen_random_uuid()::TEXT,
  user_id    TEXT         NOT NULL,
  type       TEXT         NOT NULL,
  title      TEXT         NOT NULL,
  body       TEXT         NOT NULL,
  icon       TEXT         NOT NULL DEFAULT '🔔',
  link       TEXT,
  read_at    TIMESTAMP(3),
  created_at TIMESTAMP(3) NOT NULL DEFAULT NOW()
);

ALTER TABLE notifications
  ADD COLUMN IF NOT EXISTS user_id    TEXT         NOT NULL DEFAULT '',
  ADD COLUMN IF NOT EXISTS type       TEXT         NOT NULL DEFAULT '',
  ADD COLUMN IF NOT EXISTS title      TEXT         NOT NULL DEFAULT '',
  ADD COLUMN IF NOT EXISTS body       TEXT         NOT NULL DEFAULT '',
  ADD COLUMN IF NOT EXISTS icon       TEXT         NOT NULL DEFAULT '🔔',
  ADD COLUMN IF NOT EXISTS link       TEXT,
  ADD COLUMN IF NOT EXISTS read_at    TIMESTAMP(3),
  ADD COLUMN IF NOT EXISTS created_at TIMESTAMP(3) NOT NULL DEFAULT NOW();

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.table_constraints
    WHERE table_name = 'notifications'
      AND constraint_name = 'notifications_user_id_fkey'
  ) THEN
    ALTER TABLE notifications
      ADD CONSTRAINT notifications_user_id_fkey
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE;
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS notifications_user_id_idx    ON notifications (user_id);
CREATE INDEX IF NOT EXISTS notifications_read_at_idx    ON notifications (read_at);
CREATE INDEX IF NOT EXISTS notifications_created_at_idx ON notifications (created_at);


-- ============================================================
-- STEP 8 — mpesa_transactions TABLE
-- ============================================================

CREATE TABLE IF NOT EXISTS mpesa_transactions (
  id                   TEXT                     NOT NULL PRIMARY KEY DEFAULT gen_random_uuid()::TEXT,
  subscription_id      TEXT,
  plan_id              TEXT,
  user_id              TEXT                     NOT NULL,
  merchant_request_id  TEXT                     NOT NULL,
  checkout_request_id  TEXT                     NOT NULL,
  mpesa_receipt_number TEXT,
  phone_number         TEXT,
  amount_kes           INTEGER                  NOT NULL,
  status               "MpesaTransactionStatus" NOT NULL DEFAULT 'PENDING',
  result_code          TEXT,
  result_desc          TEXT,
  interval             "BillingInterval"        NOT NULL DEFAULT 'MONTHLY',
  attempt_number       INTEGER                  NOT NULL DEFAULT 1,
  is_renewal           BOOLEAN                  NOT NULL DEFAULT FALSE,
  initiated_at         TIMESTAMP(3)             NOT NULL DEFAULT NOW(),
  completed_at         TIMESTAMP(3),
  timeout_at           TIMESTAMP(3)
);

ALTER TABLE mpesa_transactions
  ADD COLUMN IF NOT EXISTS subscription_id      TEXT,
  ADD COLUMN IF NOT EXISTS plan_id              TEXT,
  ADD COLUMN IF NOT EXISTS user_id              TEXT         NOT NULL DEFAULT '',
  ADD COLUMN IF NOT EXISTS merchant_request_id  TEXT         NOT NULL DEFAULT '',
  ADD COLUMN IF NOT EXISTS checkout_request_id  TEXT         NOT NULL DEFAULT '',
  ADD COLUMN IF NOT EXISTS mpesa_receipt_number TEXT,
  ADD COLUMN IF NOT EXISTS phone_number         TEXT,
  ADD COLUMN IF NOT EXISTS amount_kes           INTEGER      NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS result_code          TEXT,
  ADD COLUMN IF NOT EXISTS result_desc          TEXT,
  ADD COLUMN IF NOT EXISTS interval             "BillingInterval" NOT NULL DEFAULT 'MONTHLY',
  ADD COLUMN IF NOT EXISTS attempt_number       INTEGER      NOT NULL DEFAULT 1,
  ADD COLUMN IF NOT EXISTS is_renewal           BOOLEAN      NOT NULL DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS initiated_at         TIMESTAMP(3) NOT NULL DEFAULT NOW(),
  ADD COLUMN IF NOT EXISTS completed_at         TIMESTAMP(3),
  ADD COLUMN IF NOT EXISTS timeout_at           TIMESTAMP(3);

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.table_constraints
    WHERE table_name = 'mpesa_transactions'
      AND constraint_name = 'mpesa_transactions_merchant_request_id_key'
  ) THEN
    ALTER TABLE mpesa_transactions
      ADD CONSTRAINT mpesa_transactions_merchant_request_id_key
      UNIQUE (merchant_request_id);
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.table_constraints
    WHERE table_name = 'mpesa_transactions'
      AND constraint_name = 'mpesa_transactions_checkout_request_id_key'
  ) THEN
    ALTER TABLE mpesa_transactions
      ADD CONSTRAINT mpesa_transactions_checkout_request_id_key
      UNIQUE (checkout_request_id);
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.table_constraints
    WHERE table_name = 'mpesa_transactions'
      AND constraint_name = 'mpesa_transactions_mpesa_receipt_number_key'
  ) THEN
    ALTER TABLE mpesa_transactions
      ADD CONSTRAINT mpesa_transactions_mpesa_receipt_number_key
      UNIQUE (mpesa_receipt_number);
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.table_constraints
    WHERE table_name = 'mpesa_transactions'
      AND constraint_name = 'mpesa_transactions_subscription_id_fkey'
  ) THEN
    ALTER TABLE mpesa_transactions
      ADD CONSTRAINT mpesa_transactions_subscription_id_fkey
      FOREIGN KEY (subscription_id) REFERENCES subscriptions(id) ON DELETE SET NULL;
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.table_constraints
    WHERE table_name = 'mpesa_transactions'
      AND constraint_name = 'mpesa_transactions_plan_id_fkey'
  ) THEN
    ALTER TABLE mpesa_transactions
      ADD CONSTRAINT mpesa_transactions_plan_id_fkey
      FOREIGN KEY (plan_id) REFERENCES plans(id) ON DELETE SET NULL;
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.table_constraints
    WHERE table_name = 'mpesa_transactions'
      AND constraint_name = 'mpesa_transactions_user_id_fkey'
  ) THEN
    ALTER TABLE mpesa_transactions
      ADD CONSTRAINT mpesa_transactions_user_id_fkey
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE;
  END IF;
END $$;

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
-- STEP 9 — subscription_logs TABLE
-- ============================================================

CREATE TABLE IF NOT EXISTS subscription_logs (
  id              TEXT                 NOT NULL PRIMARY KEY DEFAULT gen_random_uuid()::TEXT,
  subscription_id TEXT                 NOT NULL,
  event           "SubscriptionEvent"  NOT NULL,
  previous_status "SubscriptionStatus",
  new_status      "SubscriptionStatus",
  metadata        JSONB                NOT NULL DEFAULT '{}',
  ip_address      TEXT,
  created_at      TIMESTAMP(3)         NOT NULL DEFAULT NOW()
);

ALTER TABLE subscription_logs
  ADD COLUMN IF NOT EXISTS subscription_id TEXT                NOT NULL DEFAULT '',
  ADD COLUMN IF NOT EXISTS event           "SubscriptionEvent",
  ADD COLUMN IF NOT EXISTS previous_status "SubscriptionStatus",
  ADD COLUMN IF NOT EXISTS new_status      "SubscriptionStatus",
  ADD COLUMN IF NOT EXISTS metadata        JSONB               NOT NULL DEFAULT '{}',
  ADD COLUMN IF NOT EXISTS ip_address      TEXT,
  ADD COLUMN IF NOT EXISTS created_at      TIMESTAMP(3)        NOT NULL DEFAULT NOW();

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.table_constraints
    WHERE table_name = 'subscription_logs'
      AND constraint_name = 'subscription_logs_subscription_id_fkey'
  ) THEN
    ALTER TABLE subscription_logs
      ADD CONSTRAINT subscription_logs_subscription_id_fkey
      FOREIGN KEY (subscription_id) REFERENCES subscriptions(id) ON DELETE CASCADE;
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS subscription_logs_subscription_id_idx
  ON subscription_logs (subscription_id);
CREATE INDEX IF NOT EXISTS subscription_logs_event_idx
  ON subscription_logs (event);
CREATE INDEX IF NOT EXISTS subscription_logs_created_at_idx
  ON subscription_logs (created_at);


-- ============================================================
-- STEP 10 — webhook_events TABLE
-- ============================================================

CREATE TABLE IF NOT EXISTS webhook_events (
  id              TEXT         NOT NULL PRIMARY KEY DEFAULT gen_random_uuid()::TEXT,
  external_id     TEXT         NOT NULL DEFAULT '',
  provider        TEXT         NOT NULL DEFAULT 'paystack',
  event_type      TEXT         NOT NULL,
  processed_at    TIMESTAMP(3) NOT NULL DEFAULT NOW(),
  response_status INTEGER      NOT NULL DEFAULT 200,
  error           TEXT
);

ALTER TABLE webhook_events
  ADD COLUMN IF NOT EXISTS external_id     TEXT         NOT NULL DEFAULT '',
  ADD COLUMN IF NOT EXISTS provider        TEXT         NOT NULL DEFAULT 'paystack',
  ADD COLUMN IF NOT EXISTS event_type      TEXT         NOT NULL DEFAULT '',
  ADD COLUMN IF NOT EXISTS processed_at    TIMESTAMP(3) NOT NULL DEFAULT NOW(),
  ADD COLUMN IF NOT EXISTS response_status INTEGER      NOT NULL DEFAULT 200,
  ADD COLUMN IF NOT EXISTS error           TEXT;

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.table_constraints
    WHERE table_name = 'webhook_events'
      AND constraint_name = 'webhook_events_external_id_key'
  ) THEN
    ALTER TABLE webhook_events
      ADD CONSTRAINT webhook_events_external_id_key UNIQUE (external_id);
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS webhook_events_external_id_idx   ON webhook_events (external_id);
CREATE INDEX IF NOT EXISTS webhook_events_provider_idx      ON webhook_events (provider);
CREATE INDEX IF NOT EXISTS webhook_events_processed_at_idx  ON webhook_events (processed_at);


-- ============================================================
-- STEP 11 — cron_locks TABLE
-- ============================================================

CREATE TABLE IF NOT EXISTS cron_locks (
  id         TEXT         NOT NULL PRIMARY KEY,
  locked_at  TIMESTAMP(3) NOT NULL,
  expires_at TIMESTAMP(3) NOT NULL
);

ALTER TABLE cron_locks
  ADD COLUMN IF NOT EXISTS locked_at  TIMESTAMP(3),
  ADD COLUMN IF NOT EXISTS expires_at TIMESTAMP(3);


-- ============================================================
-- STEP 12 — otp_codes TABLE
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

ALTER TABLE otp_codes
  ADD COLUMN IF NOT EXISTS email      TEXT         NOT NULL DEFAULT '',
  ADD COLUMN IF NOT EXISTS code_hash  TEXT         NOT NULL DEFAULT '',
  ADD COLUMN IF NOT EXISTS purpose    TEXT         NOT NULL DEFAULT '',
  ADD COLUMN IF NOT EXISTS created_at TIMESTAMP(3) NOT NULL DEFAULT NOW(),
  ADD COLUMN IF NOT EXISTS expires_at TIMESTAMP(3),
  ADD COLUMN IF NOT EXISTS used_at    TIMESTAMP(3);

CREATE INDEX IF NOT EXISTS otp_codes_email_idx         ON otp_codes (email);
CREATE INDEX IF NOT EXISTS otp_codes_email_purpose_idx ON otp_codes (email, purpose);


-- ============================================================
-- STEP 13 — embeddings TABLE
-- ============================================================

CREATE TABLE IF NOT EXISTS embeddings (
  id         TEXT         NOT NULL PRIMARY KEY DEFAULT gen_random_uuid()::TEXT,
  user_id    TEXT         NOT NULL,
  text       TEXT         NOT NULL,
  vector     JSONB        NOT NULL,
  created_at TIMESTAMP(3) NOT NULL DEFAULT NOW()
);

ALTER TABLE embeddings
  ADD COLUMN IF NOT EXISTS user_id    TEXT         NOT NULL DEFAULT '',
  ADD COLUMN IF NOT EXISTS text       TEXT         NOT NULL DEFAULT '',
  ADD COLUMN IF NOT EXISTS vector     JSONB,
  ADD COLUMN IF NOT EXISTS created_at TIMESTAMP(3) NOT NULL DEFAULT NOW();

CREATE INDEX IF NOT EXISTS embeddings_user_id_idx
  ON embeddings (user_id);
CREATE INDEX IF NOT EXISTS embeddings_user_id_created_at_idx
  ON embeddings (user_id, created_at);


-- ============================================================
-- STEP 14 — user_memories TABLE
-- ============================================================

CREATE TABLE IF NOT EXISTS user_memories (
  id         TEXT         NOT NULL PRIMARY KEY DEFAULT gen_random_uuid()::TEXT,
  user_id    TEXT         NOT NULL,
  data       JSONB        NOT NULL DEFAULT '{}',
  updated_at TIMESTAMP(3) NOT NULL DEFAULT NOW()
);

ALTER TABLE user_memories
  ADD COLUMN IF NOT EXISTS user_id    TEXT         NOT NULL DEFAULT '',
  ADD COLUMN IF NOT EXISTS data       JSONB        NOT NULL DEFAULT '{}',
  ADD COLUMN IF NOT EXISTS updated_at TIMESTAMP(3) NOT NULL DEFAULT NOW();

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.table_constraints
    WHERE table_name = 'user_memories'
      AND constraint_name = 'user_memories_user_id_key'
  ) THEN
    ALTER TABLE user_memories
      ADD CONSTRAINT user_memories_user_id_key UNIQUE (user_id);
  END IF;
END $$;


-- ============================================================
-- STEP 15 — nutrition_logs TABLE
-- ============================================================

-- id uses Prisma cuid() (app-generated) so no DB default needed
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
  updated_at TIMESTAMP(3)     NOT NULL DEFAULT NOW()
);

ALTER TABLE nutrition_logs
  ADD COLUMN IF NOT EXISTS user_id    TEXT             NOT NULL DEFAULT '',
  ADD COLUMN IF NOT EXISTS name       TEXT             NOT NULL DEFAULT '',
  ADD COLUMN IF NOT EXISTS calories   DOUBLE PRECISION,
  ADD COLUMN IF NOT EXISTS protein    DOUBLE PRECISION,
  ADD COLUMN IF NOT EXISTS carbs      DOUBLE PRECISION,
  ADD COLUMN IF NOT EXISTS fat        DOUBLE PRECISION,
  ADD COLUMN IF NOT EXISTS meal_type  TEXT             NOT NULL DEFAULT 'OTHER',
  ADD COLUMN IF NOT EXISTS date       TIMESTAMP(3)     NOT NULL DEFAULT NOW(),
  ADD COLUMN IF NOT EXISTS created_at TIMESTAMP(3)     NOT NULL DEFAULT NOW(),
  ADD COLUMN IF NOT EXISTS updated_at TIMESTAMP(3)     NOT NULL DEFAULT NOW();

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.table_constraints
    WHERE table_name = 'nutrition_logs'
      AND constraint_name = 'nutrition_logs_user_id_fkey'
  ) THEN
    ALTER TABLE nutrition_logs
      ADD CONSTRAINT nutrition_logs_user_id_fkey
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE;
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS nutrition_logs_user_id_idx
  ON nutrition_logs (user_id);
CREATE INDEX IF NOT EXISTS nutrition_logs_user_id_date_idx
  ON nutrition_logs (user_id, date);


-- ============================================================
-- DONE
-- ============================================================
-- Sync Prisma so it doesn't re-apply these changes:
--
--   npx prisma migrate resolve --applied "stripe_to_paystack"
-- ============================================================
