BEGIN;
ALTER TABLE "Appeal" ADD COLUMN "firstResponseSeconds" DOUBLE PRECISION GENERATED ALWAYS AS (
  CASE WHEN "firstHumanResponseAt" >= "createdAt"
    THEN EXTRACT(EPOCH FROM ("firstHumanResponseAt" - "createdAt"))::double precision
  END
) STORED;
ALTER TABLE "Appeal" ADD COLUMN "lastMeaningfulActionAt" TIMESTAMP(3);
UPDATE "Appeal" AS appeal SET "lastMeaningfulActionAt" = GREATEST(
  appeal."createdAt",
  (SELECT max(event."createdAt") FROM "AuditEvent" event
   WHERE event."entity" = 'appeal' AND event."entityId" = appeal."id"
     AND event."action" IN ('REVIEW', 'IN_PROGRESS', 'COMMENT', 'INTERNAL_NOTE', 'CLARIFICATION',
       'AUTHOR_RESPONSE', 'RESUME', 'RESOLVED_EVENT', 'WITHDRAWN', 'REVIEW_DECISION'))
);
ALTER TABLE "Appeal"
  ALTER COLUMN "lastMeaningfulActionAt" SET DEFAULT CURRENT_TIMESTAMP,
  ALTER COLUMN "lastMeaningfulActionAt" SET NOT NULL;
ALTER TABLE "Appeal" ADD COLUMN "controlDueAt" TIMESTAMP(3) GENERATED ALWAYS AS (
  CASE WHEN "slaVersion" IS NOT NULL AND "status" IN ('NEW', 'REVIEW', 'IN_PROGRESS')
    THEN LEAST("dueAt", CASE WHEN "firstHumanResponseAt" IS NULL THEN "firstResponseDueAt" END)
  END
) STORED;
CREATE INDEX "Appeal_controlDueAt_idx" ON "Appeal" ("controlDueAt");
COMMIT;
