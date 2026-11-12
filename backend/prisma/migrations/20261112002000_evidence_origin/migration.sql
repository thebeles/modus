BEGIN;
CREATE TYPE "EvidenceOrigin" AS ENUM ('USER_ACTION', 'DEMO_FIXTURE', 'IMPORTED', 'SYSTEM', 'UNKNOWN');
ALTER TABLE "Appeal" ADD COLUMN "resolutionOrigin" "EvidenceOrigin", ADD COLUMN "firstResponseOrigin" "EvidenceOrigin";
ALTER TABLE "Comment" ADD COLUMN "origin" "EvidenceOrigin" NOT NULL DEFAULT 'UNKNOWN';
ALTER TABLE "Measurement" ADD COLUMN "origin" "EvidenceOrigin" NOT NULL DEFAULT 'UNKNOWN';
ALTER TABLE "AuditEvent" ADD COLUMN "origin" "EvidenceOrigin" NOT NULL DEFAULT 'UNKNOWN';

UPDATE "AuditEvent" SET "origin" = 'DEMO_FIXTURE' WHERE id LIKE 'seed-%';
UPDATE "Comment" SET "origin" = 'DEMO_FIXTURE' WHERE id LIKE 'seed-%';
UPDATE "Comment" c SET "origin" = 'USER_ACTION'
WHERE c."origin" = 'UNKNOWN' AND EXISTS (
  SELECT 1 FROM "AuditEvent" e WHERE e.entity = 'appeal' AND e."entityId" = c."appealId"
    AND e."actorId" = c."authorId" AND e.action = c.kind
    AND e."origin" <> 'DEMO_FIXTURE' AND abs(extract(epoch FROM e."createdAt" - c."createdAt")) < 2
);
UPDATE "AuditEvent" SET "origin" = 'USER_ACTION' WHERE "origin" = 'UNKNOWN' AND "actorId" IS NOT NULL;
UPDATE "Measurement" m SET "origin" = 'DEMO_FIXTURE'
FROM "Improvement" i WHERE m."improvementId" = i.id AND i.number LIKE 'DEMO-%';

-- Seed events and source snapshots are preserved. Only the inferred response timestamp is removed.
UPDATE "Appeal" a SET "firstHumanResponseAt" = NULL
WHERE a."seedOrigin" = 'ORIGINAL_DOCX' AND a."firstHumanResponseAt" = a."createdAt" + interval '24 hours'
  AND NOT EXISTS (SELECT 1 FROM "AuditEvent" e WHERE e.entity = 'appeal' AND e."entityId" = a.id
    AND e."actorId" <> a."authorId" AND e."origin" = 'USER_ACTION' AND e."authorVisible"
    AND e.action IN ('COMMENT', 'CLARIFICATION', 'RESOLVED_EVENT')
    AND abs(extract(epoch FROM e."createdAt" - a."firstHumanResponseAt")) < 2);
UPDATE "Appeal" a SET "firstResponseOrigin" = CASE WHEN EXISTS (
  SELECT 1 FROM "AuditEvent" e WHERE e.entity = 'appeal' AND e."entityId" = a.id
    AND e."actorId" <> a."authorId" AND e."origin" = 'USER_ACTION' AND e."authorVisible"
    AND e.action IN ('COMMENT', 'CLARIFICATION', 'RESOLVED_EVENT')
    AND abs(extract(epoch FROM e."createdAt" - a."firstHumanResponseAt")) < 2
) THEN 'USER_ACTION'::"EvidenceOrigin" ELSE 'UNKNOWN'::"EvidenceOrigin" END
WHERE a."firstHumanResponseAt" IS NOT NULL;
UPDATE "Appeal" a SET "resolutionOrigin" = COALESCE((
  SELECT e."origin" FROM "AuditEvent" e WHERE e.entity = 'appeal' AND e."entityId" = a.id
    AND e.action = 'RESOLVED_EVENT' AND abs(extract(epoch FROM e."createdAt" - a."closedAt")) < 2
  ORDER BY e."createdAt" DESC, e.id LIMIT 1
), 'UNKNOWN'::"EvidenceOrigin") WHERE a."status" = 'CLOSED';

-- Correct the legacy synthetic actor without rewriting the source or losing the original value.
UPDATE "AuditEvent" e SET "actorId" = u.id, details = COALESCE(e.details, '{}'::jsonb) ||
  jsonb_build_object('previousActorId', e."actorId", 'correction', 'D04', 'seedOrigin', 'DEMO_SYNTHETIC')
FROM "Appeal" a, "User" u
WHERE a."sourceId" = 'A-017' AND e.id = 'seed-result-A-017' AND e."entityId" = a.id
  AND u.email = 'manager@demo.local' AND u.demo AND e."actorId" IS DISTINCT FROM u.id;
COMMIT;
