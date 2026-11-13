BEGIN;
ALTER TABLE "SlaPolicy" ADD COLUMN "resolutionHours" INTEGER CHECK ("resolutionHours" BETWEEN 1 AND 1440);
ALTER TABLE "Appeal"
    ADD COLUMN "resolutionVersion" INTEGER NOT NULL DEFAULT 0,
    ADD COLUMN "resolutionConfirmedAt" TIMESTAMP(3),
    ADD COLUMN "resolutionDueAt" TIMESTAMP(3),
    ADD CONSTRAINT "Appeal_implemented_result" CHECK ("status" <> 'IMPLEMENTED' OR (
        "authorId" IS NOT NULL AND "resolutionBy" IS NOT NULL AND "resolutionBy" <> "authorId"
        AND "resolutionText" IS NOT NULL AND length(trim("resolutionText")) >= 5
        AND "resolutionType" = 'RESOLVED' AND "resolutionVersion" > 0 AND "closedAt" IS NULL
    ));
CREATE INDEX "Appeal_status_resolutionDueAt_idx" ON "Appeal"("status", "resolutionDueAt");
CREATE TABLE "AppealResolutionReview" (
    "appealId" TEXT NOT NULL REFERENCES "Appeal"(id) ON DELETE RESTRICT ON UPDATE CASCADE,
    "version" INTEGER NOT NULL,
    "authorId" TEXT NOT NULL,
    "confirmed" BOOLEAN NOT NULL,
    "reason" TEXT,
    "snapshot" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY ("appealId", "version"),
    CHECK ("confirmed" OR ("reason" IS NOT NULL AND length(trim("reason")) >= 5))
);

COMMIT;
