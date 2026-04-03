-- Migration: add notifications table
-- Place at: prisma/migrations/20260403000000_add_notifications/migration.sql

CREATE TABLE IF NOT EXISTS "notifications" (
    "id"        TEXT         NOT NULL,
    "userId"    TEXT         NOT NULL,
    "type"      TEXT         NOT NULL,
    "title"     TEXT         NOT NULL,
    "body"      TEXT         NOT NULL,
    "icon"      TEXT         NOT NULL DEFAULT '🔔',
    "link"      TEXT,
    "readAt"    TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "notifications_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "notifications_userId_fkey"
        FOREIGN KEY ("userId")
        REFERENCES "users"("id")
        ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS "notifications_userId_idx"    ON "notifications"("userId");
CREATE INDEX IF NOT EXISTS "notifications_readAt_idx"    ON "notifications"("readAt");
CREATE INDEX IF NOT EXISTS "notifications_createdAt_idx" ON "notifications"("createdAt");
