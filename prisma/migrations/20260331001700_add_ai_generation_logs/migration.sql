-- Create AiGenerationLog table
CREATE TABLE "AiGenerationLog" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "userId" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "prompt" TEXT,
    "response" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AiGenerationLog_userId_fkey" 
    FOREIGN KEY ("userId") 
    REFERENCES ("id") 
    ON DELETE CASCADE 
    ON UPDATE CASCADE
);

-- Add index for performance (recommended)
CREATE INDEX "AiGenerationLog_userId_idx" ON "AiGenerationLog"("userId");

-- Optional: If you use @@map in schema
-- ALTER TABLE "AiGenerationLog" RENAME TO "ai_generation_logs";  -- Uncomment if you used @@map("ai_generation_logs")
