ALTER TABLE "mpesa_transactions"
ADD COLUMN IF NOT EXISTS "interval" "BillingInterval" NOT NULL DEFAULT 'MONTHLY';

ALTER TABLE "mpesa_transactions"
ALTER COLUMN "planId" DROP NOT NULL;

DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 
        FROM pg_constraint 
        WHERE conname = 'mpesa_transactions_planId_fkey'
        AND conrelid = 'mpesa_transactions'::regclass
    ) THEN
        ALTER TABLE "mpesa_transactions"
        ADD CONSTRAINT "mpesa_transactions_planId_fkey" 
        FOREIGN KEY ("planId") REFERENCES "plans"("id") ON DELETE SET NULL;
    END IF;
END
$$;

CREATE INDEX IF NOT EXISTS "mpesa_transactions_planId_idx" 
ON "mpesa_transactions"("planId");

CREATE INDEX IF NOT EXISTS "mpesa_transactions_subscriptionId_idx" 
ON "mpesa_transactions"("subscriptionId");

CREATE INDEX IF NOT EXISTS "mpesa_transactions_userId_idx" 
ON "mpesa_transactions"("userId");

CREATE INDEX IF NOT EXISTS "mpesa_transactions_status_idx" 
ON "mpesa_transactions"("status");
