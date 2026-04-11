-- Safe enum change: MpesaStatus → MpesaTransactionStatus
-- Maps old "COMPLETED" → new "SUCCESS"

-- 1. Add new column with the correct enum type
ALTER TABLE "mpesa_transactions" 
ADD COLUMN "status_new" "MpesaTransactionStatus";

-- 2. Copy data with explicit mapping (this fixes the error)
UPDATE "mpesa_transactions" 
SET "status_new" = CASE 
    WHEN "status" = 'COMPLETED' THEN 'SUCCESS'::"MpesaTransactionStatus"
    WHEN "status" = 'PENDING'   THEN 'PENDING'::"MpesaTransactionStatus"
    WHEN "status" = 'SUCCESS'   THEN 'SUCCESS'::"MpesaTransactionStatus"
    WHEN "status" = 'FAILED'    THEN 'FAILED'::"MpesaTransactionStatus"
    -- Add more lines here if you have other old values
    ELSE 'PENDING'::"MpesaTransactionStatus"   -- fallback for any unknown value
  END;

-- 3. Drop the old column
ALTER TABLE "mpesa_transactions" 
DROP COLUMN "status";

-- 4. Rename the new column back to "status"
ALTER TABLE "mpesa_transactions" 
RENAME COLUMN "status_new" TO "status";

-- Optional: add default if you want one
-- ALTER TABLE "mpesa_transactions" ALTER COLUMN "status" SET DEFAULT 'PENDING';
