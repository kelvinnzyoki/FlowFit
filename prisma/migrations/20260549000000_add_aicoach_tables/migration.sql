CREATE TABLE "embeddings" (
     "id"         TEXT NOT NULL DEFAULT gen_random_uuid(),
     "userId"     TEXT NOT NULL,
    "text"       TEXT NOT NULL,
    "vector"     JSONB NOT NULL,
    "createdAt"  TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
     PRIMARY KEY ("id")
   );
  CREATE INDEX "embeddings_userId_idx"           ON "embeddings"("userId");
  CREATE INDEX "embeddings_userId_createdAt_idx" ON "embeddings"("userId","createdAt");

  CREATE TABLE "user_memories" (
     "id"        TEXT NOT NULL DEFAULT gen_random_uuid(),
     "userId"    TEXT NOT NULL UNIQUE,
    "data"      JSONB NOT NULL DEFAULT '{}',
    "updatedAt" TIMESTAMP(3) NOT NULL,
     PRIMARY KEY ("id")
   );
