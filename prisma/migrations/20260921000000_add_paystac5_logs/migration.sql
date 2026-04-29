-- ── 1. Wipe any STRIPE values before type change (PaymentProvider has no STRIPE)
UPDATE subscriptions SET provider = 'PAYSTACK' WHERE provider::text = 'STRIPE';
UPDATE payments     SET provider = 'PAYSTACK' WHERE provider::text = 'STRIPE';

-- ── 2. Alter subscriptions.provider from old Provider enum → new PaymentProvider
ALTER TABLE subscriptions
  ALTER COLUMN provider TYPE "PaymentProvider"
  USING provider::text::"PaymentProvider";

-- ── 3. Alter payments.provider from old Provider enum → new PaymentProvider
ALTER TABLE payments
  ALTER COLUMN provider TYPE "PaymentProvider"
  USING provider::text::"PaymentProvider";

-- ── 4. Alter webhook_events.provider if it also uses the old enum
ALTER TABLE webhook_events
  ALTER COLUMN provider TYPE TEXT
  USING provider::text;

-- ── 5. Drop the now-orphaned old Provider enum
DROP TYPE IF EXISTS "Provider";

-- ── 6. Drop the old stripe_ columns if they still exist
ALTER TABLE subscriptions DROP COLUMN IF EXISTS stripe_subscription_id;
ALTER TABLE subscriptions DROP COLUMN IF EXISTS stripe_checkout_session_id;
ALTER TABLE payments      DROP COLUMN IF EXISTS stripe_invoice_id;
ALTER TABLE payments      DROP COLUMN IF EXISTS stripe_payment_intent_id;
ALTER TABLE users         DROP COLUMN IF EXISTS stripe_customer_id;
ALTER TABLE plans         DROP COLUMN IF EXISTS stripe_price_id_monthly;
ALTER TABLE plans         DROP COLUMN IF EXISTS stripe_price_id_yearly;
