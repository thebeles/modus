BEGIN;
ALTER TABLE "Appeal" ALTER COLUMN "queueId" DROP NOT NULL;
ALTER TABLE "Appeal"
  ADD COLUMN "routingReason" TEXT,
  ADD COLUMN "routingRetryAt" TIMESTAMP(3),
  ADD COLUMN "routingAttempts" INTEGER NOT NULL DEFAULT 0,
  ADD CONSTRAINT "Appeal_routing_integrity" CHECK (
    ("queueId" IS NULL AND "assigneeId" IS NULL AND "routingReason" IS NOT NULL
      AND ("routingRetryAt" IS NOT NULL OR "status" IN ('CLOSED', 'WITHDRAWN')))
    OR ("queueId" IS NOT NULL AND "routingReason" IS NULL AND "routingRetryAt" IS NULL)
  );
CREATE INDEX "Appeal_routingRetryAt_idx" ON "Appeal" ("routingRetryAt");
COMMIT;
