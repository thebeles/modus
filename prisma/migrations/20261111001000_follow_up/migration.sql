ALTER TABLE "User" ADD COLUMN "notifyRegistration" BOOLEAN NOT NULL DEFAULT true;
ALTER TABLE "Measurement" ADD COLUMN "supersededAt" TIMESTAMP(3);
ALTER TYPE "Relation" ADD VALUE 'POSSIBLE_RECURRENCE';

CREATE EXTENSION IF NOT EXISTS pg_trgm;
CREATE INDEX "Appeal_title_search_idx" ON "Appeal" USING GIN ("title" gin_trgm_ops);
CREATE INDEX "Appeal_description_search_idx" ON "Appeal" USING GIN ("description" gin_trgm_ops);
CREATE INDEX "Appeal_number_search_idx" ON "Appeal" USING GIN ("number" gin_trgm_ops);

CREATE FUNCTION preserve_appeal_origin() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW."authorId" IS DISTINCT FROM OLD."authorId"
    OR NEW."descriptionOriginal" IS DISTINCT FROM OLD."descriptionOriginal"
    OR NEW."sourceId" IS DISTINCT FROM OLD."sourceId"
    OR NEW."sourceSnapshot" IS DISTINCT FROM OLD."sourceSnapshot"
    OR NEW."seedOrigin" IS DISTINCT FROM OLD."seedOrigin"
    OR NEW."isSynthetic" IS DISTINCT FROM OLD."isSynthetic" THEN
    RAISE EXCEPTION 'Appeal origin is immutable';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER "Appeal_preserve_origin" BEFORE UPDATE ON "Appeal"
FOR EACH ROW EXECUTE FUNCTION preserve_appeal_origin();
