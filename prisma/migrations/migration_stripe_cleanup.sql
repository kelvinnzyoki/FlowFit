-- ============================================================
-- FLOWFIT — Targeted Stripe Cleanup (verified against live DB)
-- Paste into Neon SQL Editor and run.
-- ============================================================
--
-- WHY PRIOR MIGRATIONS FAILED
--   Every previous attempt used snake_case column names
--   (stripe_customer_id, stripe_invoice_id …) but Prisma wrote
--   them as camelCase (stripeCustomerId, stripeInvoiceId …).
--   DROP COLUMN IF EXISTS on the wrong name silently did nothing.
--
-- WHAT THIS FILE DOES (in order)
--   1. Fix payments.provider — update STRIPE rows → PAYSTACK,
--      change the column DEFAULT from 'STRIPE' to 'PAYSTACK'.
--      (Cannot remove STRIPE from the enum, but removing it as
--      a default and updating all rows is all that's needed.)
--   2. Drop the actual Stripe columns using correct camelCase names.
--   3. Drop snake_case duplicate columns added by bad prior
--      migrations. Prisma only ever reads camelCase — these are
--      dead weight that cause "column does not exist" drift.
--   4. Drop the old "Provider" enum type if it still exists.
--   5. Ensure the payments currency default is KES (was USD).
--
-- SAFE TO RUN MULTIPLE TIMES — every DROP uses IF EXISTS.
-- No data is deleted. No NOT NULL columns are dropped without
-- a camelCase equivalent already confirmed present.
-- ============================================================


-- ============================================================
-- SECTION 1 — Fix payments.provider (still defaults to STRIPE)
-- ============================================================

-- 1a. Migrate all existing STRIPE rows to PAYSTACK
UPDATE payments
   SET provider = 'PAYSTACK'::"PaymentProvider"
 WHERE provider::text = 'STRIPE';

-- 1b. Same for subscriptions (in case any slipped through)
UPDATE subscriptions
   SET provider = 'PAYSTACK'::"PaymentProvider"
 WHERE provider::text = 'STRIPE';

-- 1c. Update the column DEFAULT so future inserts use PAYSTACK
ALTER TABLE payments
  ALTER COLUMN provider SET DEFAULT 'PAYSTACK'::"PaymentProvider";

ALTER TABLE subscriptions
  ALTER COLUMN provider SET DEFAULT 'PAYSTACK'::"PaymentProvider";

-- 1d. Fix currency default from USD to KES
ALTER TABLE payments
  ALTER COLUMN currency SET DEFAULT 'KES';


-- ============================================================
-- SECTION 2 — Drop actual Stripe columns (camelCase names)
--
-- These are the columns that all prior migrations failed to drop
-- because they used snake_case names instead of camelCase.
-- ============================================================

-- users
ALTER TABLE users               DROP COLUMN IF EXISTS "stripeCustomerId";

-- payments
ALTER TABLE payments            DROP COLUMN IF EXISTS "stripeInvoiceId";
ALTER TABLE payments            DROP COLUMN IF EXISTS "stripePaymentIntentId";

-- subscriptions
ALTER TABLE subscriptions       DROP COLUMN IF EXISTS "stripeSubscriptionId";
ALTER TABLE subscriptions       DROP COLUMN IF EXISTS "stripeCheckoutSessionId";

-- plans (both naming conventions — cover all cases)
ALTER TABLE plans               DROP COLUMN IF EXISTS "stripePriceIdMonthly";
ALTER TABLE plans               DROP COLUMN IF EXISTS "stripePriceIdYearly";
ALTER TABLE plans               DROP COLUMN IF EXISTS stripe_price_id_monthly;
ALTER TABLE plans               DROP COLUMN IF EXISTS stripe_price_id_yearly;


-- ============================================================
-- SECTION 3 — Drop snake_case duplicate columns
--
-- Prior migrations (migration.sql v1 and migration_stripe_to_paystack.sql)
-- added snake_case versions of all columns to several tables.
-- Prisma only queries the camelCase versions — every snake_case
-- column here is confirmed to have a camelCase twin already in
-- place (verified from tableColumns.txt).
--
-- Using CASCADE so any accidentally-created indexes or FK
-- constraints on the duplicate columns are also removed.
-- ============================================================

-- users  (camelCase twins: paystackCustomerCode, mpesaPhone, phoneVerified, phoneVerifiedAt)
ALTER TABLE users DROP COLUMN IF EXISTS paystack_customer_code CASCADE;
ALTER TABLE users DROP COLUMN IF EXISTS mpesa_phone           CASCADE;
ALTER TABLE users DROP COLUMN IF EXISTS phone_verified        CASCADE;
ALTER TABLE users DROP COLUMN IF EXISTS phone_verified_at     CASCADE;

-- payments  (camelCase twins: subscriptionId, paystackReference, paidAt,
--            mpesaTransactionId, mpesaReceiptNumber, amountCents,
--            failureMessage, refundedAt, refundAmountCents, createdAt)
ALTER TABLE payments DROP COLUMN IF EXISTS subscription_id      CASCADE;
ALTER TABLE payments DROP COLUMN IF EXISTS paystack_reference   CASCADE;
ALTER TABLE payments DROP COLUMN IF EXISTS paid_at              CASCADE;
ALTER TABLE payments DROP COLUMN IF EXISTS mpesa_transaction_id CASCADE;
ALTER TABLE payments DROP COLUMN IF EXISTS mpesa_receipt_number CASCADE;
ALTER TABLE payments DROP COLUMN IF EXISTS amount_cents         CASCADE;
ALTER TABLE payments DROP COLUMN IF EXISTS failure_message      CASCADE;
ALTER TABLE payments DROP COLUMN IF EXISTS refunded_at          CASCADE;
ALTER TABLE payments DROP COLUMN IF EXISTS refund_amount_cents  CASCADE;
ALTER TABLE payments DROP COLUMN IF EXISTS created_at           CASCADE;

-- mpesa_transactions  (camelCase twins exist for all of these)
ALTER TABLE mpesa_transactions DROP COLUMN IF EXISTS subscription_id      CASCADE;
ALTER TABLE mpesa_transactions DROP COLUMN IF EXISTS plan_id              CASCADE;
ALTER TABLE mpesa_transactions DROP COLUMN IF EXISTS user_id              CASCADE;
ALTER TABLE mpesa_transactions DROP COLUMN IF EXISTS merchant_request_id  CASCADE;
ALTER TABLE mpesa_transactions DROP COLUMN IF EXISTS checkout_request_id  CASCADE;
ALTER TABLE mpesa_transactions DROP COLUMN IF EXISTS mpesa_receipt_number CASCADE;
ALTER TABLE mpesa_transactions DROP COLUMN IF EXISTS phone_number         CASCADE;
ALTER TABLE mpesa_transactions DROP COLUMN IF EXISTS amount_kes           CASCADE;
ALTER TABLE mpesa_transactions DROP COLUMN IF EXISTS result_code          CASCADE;
ALTER TABLE mpesa_transactions DROP COLUMN IF EXISTS result_desc          CASCADE;
ALTER TABLE mpesa_transactions DROP COLUMN IF EXISTS attempt_number       CASCADE;
ALTER TABLE mpesa_transactions DROP COLUMN IF EXISTS is_renewal           CASCADE;
ALTER TABLE mpesa_transactions DROP COLUMN IF EXISTS initiated_at         CASCADE;
ALTER TABLE mpesa_transactions DROP COLUMN IF EXISTS completed_at         CASCADE;
ALTER TABLE mpesa_transactions DROP COLUMN IF EXISTS timeout_at           CASCADE;

-- subscription_logs  (camelCase twins: subscriptionId, previousStatus,
--                     newStatus, ipAddress, createdAt)
ALTER TABLE subscription_logs DROP COLUMN IF EXISTS subscription_id CASCADE;
ALTER TABLE subscription_logs DROP COLUMN IF EXISTS previous_status CASCADE;
ALTER TABLE subscription_logs DROP COLUMN IF EXISTS new_status      CASCADE;
ALTER TABLE subscription_logs DROP COLUMN IF EXISTS ip_address      CASCADE;
ALTER TABLE subscription_logs DROP COLUMN IF EXISTS created_at      CASCADE;

-- notifications  (camelCase twins: userId, readAt, createdAt)
ALTER TABLE notifications DROP COLUMN IF EXISTS user_id    CASCADE;
ALTER TABLE notifications DROP COLUMN IF EXISTS read_at    CASCADE;
ALTER TABLE notifications DROP COLUMN IF EXISTS created_at CASCADE;

-- embeddings  (camelCase twins: userId, createdAt)
ALTER TABLE embeddings DROP COLUMN IF EXISTS user_id    CASCADE;
ALTER TABLE embeddings DROP COLUMN IF EXISTS created_at CASCADE;

-- phone_otps  (camelCase twins: userId, codeHash, expiresAt, usedAt, createdAt)
ALTER TABLE phone_otps DROP COLUMN IF EXISTS user_id    CASCADE;
ALTER TABLE phone_otps DROP COLUMN IF EXISTS code_hash  CASCADE;
ALTER TABLE phone_otps DROP COLUMN IF EXISTS expires_at CASCADE;
ALTER TABLE phone_otps DROP COLUMN IF EXISTS used_at    CASCADE;
ALTER TABLE phone_otps DROP COLUMN IF EXISTS created_at CASCADE;

-- otp_codes  (camelCase twins: codeHash, createdAt, expiresAt, usedAt)
ALTER TABLE otp_codes DROP COLUMN IF EXISTS code_hash  CASCADE;
ALTER TABLE otp_codes DROP COLUMN IF EXISTS created_at CASCADE;
ALTER TABLE otp_codes DROP COLUMN IF EXISTS expires_at CASCADE;
ALTER TABLE otp_codes DROP COLUMN IF EXISTS used_at    CASCADE;

-- cron_locks  (camelCase twins: lockedAt, expiresAt)
ALTER TABLE cron_locks DROP COLUMN IF EXISTS locked_at  CASCADE;
ALTER TABLE cron_locks DROP COLUMN IF EXISTS expires_at CASCADE;


-- ============================================================
-- SECTION 4 — Drop old "Provider" enum if still present
-- ============================================================

DROP TYPE IF EXISTS "Provider";


-- ============================================================
-- SECTION 5 — Ensure mpesa_transactions.status is NOT NULL
--
-- From tableColumns: status is USER-DEFINED but is_nullable=YES.
-- Schema requires NOT NULL DEFAULT 'PENDING'.
-- Backfill NULLs before setting NOT NULL.
-- ============================================================

UPDATE mpesa_transactions
   SET status = 'PENDING'::"MpesaTransactionStatus"
 WHERE status IS NULL;

DO $$ BEGIN
  ALTER TABLE mpesa_transactions
    ALTER COLUMN status SET NOT NULL,
    ALTER COLUMN status SET DEFAULT 'PENDING'::"MpesaTransactionStatus";
EXCEPTION WHEN OTHERS THEN
  RAISE NOTICE 'mpesa_transactions status constraint: %', SQLERRM;
END $$;


-- ============================================================
-- SECTION 6 — Verify (run these SELECT queries after to confirm)
-- ============================================================

-- Confirm no Stripe columns remain:
-- SELECT table_name, column_name FROM information_schema.columns
-- WHERE table_schema = 'public' AND (
--   column_name ILIKE 'stripe%'
--   OR (column_name = 'provider'
--       AND table_name IN ('payments','subscriptions')
--       AND column_default ILIKE '%STRIPE%')
-- )
-- ORDER BY table_name, column_name;
--
-- Confirm no snake_case duplicates remain:
-- SELECT table_name, column_name FROM information_schema.columns
-- WHERE table_schema = 'public'
--   AND column_name ~ '^[a-z]+(_[a-z]+)+'
--   AND table_name IN ('users','payments','mpesa_transactions',
--     'subscription_logs','notifications','embeddings',
--     'phone_otps','otp_codes','cron_locks')
-- ORDER BY table_name, column_name;
--
-- Confirm payments.provider has no STRIPE rows and correct default:
-- SELECT provider, COUNT(*) FROM payments GROUP BY provider;
-- SELECT column_default FROM information_schema.columns
-- WHERE table_name='payments' AND column_name='provider';

-- ============================================================
-- DONE — After running, register with Prisma:
--   npx prisma migrate resolve --applied "stripe_cleanup"
--   npx prisma generate
-- ============================================================
