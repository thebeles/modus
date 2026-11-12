BEGIN;
ALTER TABLE "Verification" ADD COLUMN revision INTEGER NOT NULL DEFAULT 1;
CREATE TABLE "VerificationAmendment" (
  id TEXT PRIMARY KEY,
  "improvementId" TEXT NOT NULL REFERENCES "Verification" ("improvementId") ON DELETE RESTRICT,
  "requestedBy" TEXT NOT NULL,
  "reviewerId" TEXT NOT NULL,
  reason TEXT NOT NULL,
  "requestedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "resolvedAt" TIMESTAMP(3),
  approved BOOLEAN,
  decision TEXT
);
CREATE INDEX "VerificationAmendment_improvementId_requestedAt_idx" ON "VerificationAmendment" ("improvementId", "requestedAt");
CREATE UNIQUE INDEX "VerificationAmendment_open_idx" ON "VerificationAmendment" ("improvementId") WHERE "resolvedAt" IS NULL;
CREATE TABLE "VerificationRevision" (
  "improvementId" TEXT NOT NULL REFERENCES "Verification" ("improvementId") ON DELETE RESTRICT,
  revision INTEGER NOT NULL,
  snapshot JSONB NOT NULL,
  reason TEXT NOT NULL,
  "archivedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY ("improvementId", revision)
);
COMMIT;
