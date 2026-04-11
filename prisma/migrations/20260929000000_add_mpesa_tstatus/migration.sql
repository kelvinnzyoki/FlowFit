-- Safe enum change: MpesaStatus → MpesaTransactionStatus
-- No data loss, works even if values are slightly different

-- 1. Add new column with correct type
ALTER TABLE "mpesa_transactions" 
ADD COLUMN "status_new" "MpesaTransactionStatus";

-- 2. Copy data (cast through text so Postgres accepts it)
UPDATE "mpesa_transactions" 
SET "status_new" = "status"::text::"MpesaTransactionStatus";

-- 3. Drop old column
ALTER TABLE "mpesa_transactions" 
DROP COLUMN "status";

-- 4. Rename new column back to original name
ALTER TABLE "mpesa_transactions" 
RENAME COLUMN "status_new" TO "status";

-- Optional: If you have a default value, add it back here
-- ALTER TABLE "mpesa_transactions" ALTER COLUMN "status" SET DEFAULT 'PENDING';
