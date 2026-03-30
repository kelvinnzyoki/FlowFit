-- Add AiGenerationLog table for AI usage tracking
CREATE TABLE "ai_generation_logs" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "userId" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "prompt" TEXT,
    "response" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- Add foreign key constraint correctly
ALTER TABLE "ai_generation_logs"
ADD CONSTRAINT "AiGenerationLog_userId_fkey"
FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Add index for better performance
CREATE INDEX "AiGenerationLog_userId_idx" ON "AiGenerationLog"("userId");
