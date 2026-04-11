-- Safe rename of enum type for mpesa_transactions.status
-- Maps old values (including COMPLETED) to new enum

-- Step 1: Create the new column using the target enum
ALTER TABLE "mpesa_transactions" 
ADD COLUMN "status_new" "MpesaTransactionStatus";

-- Step 2: Copy data with explicit mapping through TEXT (safest way)
UPDATE "mpesa_transactions" 
SET "status_new" = CASE 
    WHEN status::text = 'COMPLETED' THEN 'SUCCESS'::"MpesaTransactionStatus"
    WHEN status::text = 'PENDING'   THEN 'PENDING'::"MpesaTransactionStatus"
    WHEN status::text = 'SUCCESS'   THEN 'SUCCESS'::"MpesaTransactionStatus"
    WHEN status::text = 'FAILED'    THEN 'FAILED'::"MpesaTransactionStatus"
    -- Add any other values you see in your table here
    ELSE 'PENDING'::"MpesaTransactionStatus"   -- safe fallback
END;

-- Step 3: Drop the old column
ALTER TABLE "mpesa_transactions" 
DROP COLUMN "status";

-- Step 4: Rename new column to original name
ALTER TABLE "mpesa_transactions" 
RENAME COLUMN "status_new" TO "status";

-- Optional: Set default if needed
-- ALTER TABLE "mpesa_transactions" ALTER COLUMN "status" SET DEFAULT 'PENDING';
