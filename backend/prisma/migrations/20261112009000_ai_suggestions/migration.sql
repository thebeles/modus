BEGIN;
CREATE TYPE "AiSuggestionStatus" AS ENUM ('PENDING', 'ACCEPTED', 'REJECTED', 'EXPIRED');
CREATE TABLE "AiSuggestion" (
  "usageId" TEXT PRIMARY KEY REFERENCES "AiUsage" (id) ON DELETE RESTRICT,
  "organizationId" TEXT,
  "templateVersion" TEXT NOT NULL,
  provider TEXT NOT NULL,
  model TEXT NOT NULL,
  status "AiSuggestionStatus" NOT NULL DEFAULT 'PENDING',
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "expiresAt" TIMESTAMP(3) NOT NULL,
  "decidedAt" TIMESTAMP(3)
);
CREATE INDEX "AiSuggestion_status_expiresAt_idx" ON "AiSuggestion" (status, "expiresAt");
COMMIT;
