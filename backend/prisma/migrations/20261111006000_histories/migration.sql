BEGIN;
CREATE TYPE "AppealWorkPhase" AS ENUM ('ACTIVE', 'WAITING_AUTHOR');
CREATE TABLE "AppealWorkPeriod" (
  "appealId" TEXT NOT NULL REFERENCES "Appeal"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  "startedAt" TIMESTAMP(3) NOT NULL,
  "endedAt" TIMESTAMP(3),
  "phase" "AppealWorkPhase" NOT NULL,
  PRIMARY KEY ("appealId", "startedAt"),
  CHECK ("endedAt" >= "startedAt")
);
CREATE UNIQUE INDEX "AppealWorkPeriod_one_open" ON "AppealWorkPeriod" ("appealId") WHERE "endedAt" IS NULL;

CREATE FUNCTION appeal_work_phase(state "AppealStatus") RETURNS "AppealWorkPhase"
LANGUAGE SQL IMMUTABLE AS $$
  SELECT CASE WHEN state IN ('NEW','REVIEW','IN_PROGRESS') THEN 'ACTIVE'::"AppealWorkPhase"
    WHEN state = 'WAITING_AUTHOR' THEN 'WAITING_AUTHOR'::"AppealWorkPhase" END
$$;

WITH boundaries AS (
  SELECT id, "createdAt" AS at, 'ACTIVE'::"AppealWorkPhase" AS phase, 0 AS priority, ''::text AS tie FROM "Appeal"
  UNION ALL
  SELECT e."entityId", e."createdAt", appeal_work_phase((e.details->>'next')::"AppealStatus"), 1, e.id
  FROM "AuditEvent" e JOIN "Appeal" a ON a.id = e."entityId"
  WHERE e.entity = 'appeal' AND e."createdAt" >= a."createdAt"
    AND e.details->>'previous' <> e.details->>'next'
    AND e.details->>'next' IN ('NEW','REVIEW','IN_PROGRESS','WAITING_AUTHOR','CLOSED','WITHDRAWN')
  UNION ALL
  SELECT id, GREATEST("createdAt", COALESCE("waitingSince","closedAt","withdrawnAt")), appeal_work_phase(status), 2, ''
  FROM "Appeal" WHERE status IN ('WAITING_AUTHOR','CLOSED','WITHDRAWN')
), unique_times AS (
  SELECT DISTINCT ON (id, at) id, at, phase FROM boundaries ORDER BY id, at, priority DESC, tie DESC
), changes AS (
  SELECT id, at, phase, lag(phase) OVER (PARTITION BY id ORDER BY at) AS previous FROM unique_times
), periods AS (
  SELECT id, at, phase, lead(at) OVER (PARTITION BY id ORDER BY at) AS finish
  FROM changes WHERE phase IS DISTINCT FROM previous
)
INSERT INTO "AppealWorkPeriod" SELECT id, at, finish, phase FROM periods WHERE phase IS NOT NULL;

CREATE FUNCTION track_appeal_work_period() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  next_phase "AppealWorkPhase" := appeal_work_phase(NEW.status);
  boundary TIMESTAMP(3);
BEGIN
  IF TG_OP = 'INSERT' THEN
    boundary := NEW."createdAt";
    IF next_phase = 'WAITING_AUTHOR' THEN boundary := GREATEST(boundary, NEW."waitingSince"); END IF;
    IF boundary > NEW."createdAt" OR next_phase IS NULL THEN
      INSERT INTO "AppealWorkPeriod" VALUES (NEW.id, NEW."createdAt",
        GREATEST(boundary, COALESCE(NEW."closedAt", NEW."withdrawnAt")), 'ACTIVE');
    END IF;
  ELSE
    IF next_phase IS NOT DISTINCT FROM appeal_work_phase(OLD.status) THEN RETURN NEW; END IF;
    SELECT GREATEST(NEW."updatedAt", "startedAt" + INTERVAL '1 millisecond') INTO boundary
      FROM "AppealWorkPeriod" WHERE "appealId" = NEW.id ORDER BY "startedAt" DESC LIMIT 1;
    boundary := COALESCE(boundary, NEW."updatedAt");
    UPDATE "AppealWorkPeriod" SET "endedAt" = boundary WHERE "appealId" = NEW.id AND "endedAt" IS NULL;
  END IF;
  IF next_phase IS NOT NULL THEN INSERT INTO "AppealWorkPeriod" VALUES (NEW.id, boundary, NULL, next_phase); END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER "Appeal_track_work_period" AFTER INSERT OR UPDATE OF status ON "Appeal"
  FOR EACH ROW EXECUTE FUNCTION track_appeal_work_period();

CREATE TABLE "PublicationRevision" (
  "publicationId" TEXT NOT NULL REFERENCES "Publication"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  "version" INTEGER NOT NULL,
  "recordedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "actorId" TEXT,
  "action" TEXT NOT NULL,
  "snapshot" JSONB NOT NULL,
  PRIMARY KEY ("publicationId", "version")
);
INSERT INTO "PublicationRevision" ("publicationId","version","action","snapshot")
  SELECT id, version, 'BASELINE', to_jsonb(p) FROM "Publication" p;
ALTER TABLE "MeasurementPlan"
  ADD COLUMN "minimumSampleSize" INTEGER CHECK ("minimumSampleSize" > 0),
  ADD COLUMN "requireSameSource" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN "maxPeriodDifferencePercent" INTEGER CHECK ("maxPeriodDifferencePercent" BETWEEN 0 AND 100);
COMMIT;
