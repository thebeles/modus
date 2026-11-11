BEGIN;
ALTER TABLE "Attachment"
  ADD COLUMN "improvementId" TEXT REFERENCES "Improvement"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD COLUMN "readyAt" TIMESTAMP(3),
  ADD COLUMN "purgeAt" TIMESTAMP(3),
  ADD CONSTRAINT "Attachment_single_owner" CHECK (num_nonnulls("appealId", "improvementId") <= 1);
UPDATE "Attachment" SET "readyAt" = "createdAt";
CREATE INDEX "Attachment_improvementId_idx" ON "Attachment" ("improvementId");
CREATE INDEX "Attachment_unclaimed_idx" ON "Attachment" ("createdAt", "id")
  WHERE "appealId" IS NULL AND "improvementId" IS NULL;

ALTER TABLE "MeasurementPlan" ADD COLUMN "version" INTEGER NOT NULL DEFAULT 1;
ALTER TABLE "Measurement"
  ADD COLUMN "planVersion" INTEGER NOT NULL DEFAULT 1,
  ADD COLUMN "sourceType" TEXT NOT NULL DEFAULT 'OTHER',
  ADD COLUMN "evidenceIds" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[];
ALTER TABLE "Verification"
  ADD COLUMN "planVersion" INTEGER NOT NULL DEFAULT 1,
  ADD COLUMN "measurementIds" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
  ADD COLUMN "evidenceIds" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[];
UPDATE "Verification" AS verification
  SET "measurementIds" = ARRAY(
    SELECT measurement."id" FROM "Measurement" AS measurement
    WHERE measurement."improvementId" = verification."improvementId"
      AND measurement."createdAt" <= verification."verifiedAt" AND measurement."supersededAt" IS NULL
    ORDER BY measurement."periodEnd" DESC, measurement."id" ASC
  );
ALTER TABLE "Publication" ADD COLUMN "reviewNote" TEXT;
COMMIT;
