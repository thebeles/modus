BEGIN;
CREATE TYPE "ReviewRequestKind" AS ENUM ('RECONSIDERATION', 'WITHDRAWAL');
ALTER TABLE "ReviewRequest" ADD COLUMN "kind" "ReviewRequestKind" NOT NULL DEFAULT 'RECONSIDERATION';
UPDATE "ReviewRequest" r SET "kind" = 'WITHDRAWAL'
WHERE (
    SELECT a."action" FROM "AuditEvent" a
    WHERE a."entity" = 'appeal' AND a."entityId" = r."appealId" AND a."actorId" = r."authorId"
      AND a."createdAt" >= r."createdAt" AND a."action" IN ('WITHDRAWAL_REQUEST', 'REVIEW_REQUEST')
    ORDER BY a."createdAt", a."id" LIMIT 1
) = 'WITHDRAWAL';

ALTER TABLE "OutboxJob" ADD COLUMN "discardedAt" TIMESTAMP(3);
DROP INDEX "OutboxJob_deliveredAt_deadAt_availableAt_idx";
CREATE INDEX "OutboxJob_pending_idx" ON "OutboxJob" ("deliveredAt", "deadAt", "discardedAt", "availableAt");

ALTER TABLE "Appeal"
  ADD CONSTRAINT "Appeal_waiting_resume_required" CHECK ("status" <> 'WAITING_AUTHOR' OR "resumeState" IS NOT NULL),
  ADD CONSTRAINT "Appeal_resolution_actor_required" CHECK ("status" <> 'CLOSED' OR "resolutionBy" IS NOT NULL);
COMMIT;
