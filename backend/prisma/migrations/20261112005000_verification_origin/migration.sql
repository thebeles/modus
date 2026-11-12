BEGIN;
ALTER TABLE "Verification" ADD COLUMN "origin" "EvidenceOrigin" NOT NULL DEFAULT 'UNKNOWN';
UPDATE "Verification" v SET origin = 'USER_ACTION'
WHERE EXISTS (SELECT 1 FROM "AuditEvent" e WHERE e.entity = 'improvement' AND e."entityId" = v."improvementId"
  AND e.action = 'VERIFICATION' AND e."actorId" = v."verifierId" AND e.origin = 'USER_ACTION'
  AND abs(extract(epoch FROM e."createdAt" - v."verifiedAt")) < 2);
UPDATE "Verification" v SET origin = 'DEMO_FIXTURE' FROM "Improvement" i
WHERE v."improvementId" = i.id AND i.number LIKE 'DEMO-%' AND v.origin = 'UNKNOWN';
COMMIT;
