BEGIN;
CREATE TABLE "AppealNextAction" (
  "appealId" TEXT NOT NULL REFERENCES "Appeal" (id) ON DELETE RESTRICT,
  revision INTEGER NOT NULL,
  kind TEXT NOT NULL,
  state TEXT NOT NULL,
  "ownerId" TEXT,
  "queueId" TEXT,
  "dueAt" TIMESTAMP(3),
  reason TEXT,
  "assignedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY ("appealId", revision),
  CHECK ("ownerId" IS NULL OR "queueId" IS NULL)
);

CREATE FUNCTION record_appeal_next_action(item "Appeal", assigned_at TIMESTAMP)
RETURNS void LANGUAGE plpgsql AS $$
DECLARE
  previous "AppealNextAction"%ROWTYPE;
  next_action "AppealNextAction"%ROWTYPE;
BEGIN
  SELECT * INTO previous FROM "AppealNextAction"
    WHERE "appealId" = item.id ORDER BY revision DESC LIMIT 1;
  next_action."appealId" := item.id;
  next_action.revision := COALESCE(previous.revision, 0) + 1;
  next_action."assignedAt" := assigned_at;
  IF item.status IN ('CLOSED', 'WITHDRAWN') THEN
    next_action.kind := 'NONE';
    next_action.state := 'DONE';
    next_action.reason := 'TERMINAL';
  ELSIF item.status = 'WAITING_AUTHOR' THEN
    next_action.kind := 'AUTHOR_RESPONSE';
    next_action.state := 'WAITING';
    next_action."ownerId" := item."authorId";
    next_action.reason := 'CLARIFICATION_REQUESTED';
  ELSIF item."queueId" IS NULL THEN
    next_action.kind := 'ROUTING';
    next_action.state := 'WAITING';
    next_action.reason := item."routingReason";
  ELSE
    next_action.kind := CASE item.status WHEN 'NEW' THEN 'TRIAGE' WHEN 'IN_PROGRESS' THEN 'EXECUTION' ELSE 'DECISION' END;
    next_action.state := 'OPEN';
    next_action."ownerId" := item."assigneeId";
    IF next_action."ownerId" IS NULL THEN next_action."queueId" := item."queueId"; END IF;
    next_action."dueAt" := item."controlDueAt";
    IF next_action."dueAt" IS NULL THEN next_action.reason := 'NO_SLA'; END IF;
  END IF;
  IF ROW(next_action.kind, next_action.state, next_action."ownerId", next_action."queueId", next_action."dueAt", next_action.reason)
    IS DISTINCT FROM ROW(previous.kind, previous.state, previous."ownerId", previous."queueId", previous."dueAt", previous.reason) THEN
    INSERT INTO "AppealNextAction" SELECT (next_action).*;
  END IF;
END;
$$;

SELECT record_appeal_next_action(a, a."lastMeaningfulActionAt") FROM "Appeal" a;
CREATE FUNCTION track_appeal_next_action() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  PERFORM record_appeal_next_action(NEW, CASE WHEN TG_OP = 'INSERT' THEN NEW."createdAt" ELSE timezone('UTC', clock_timestamp()) END);
  RETURN NEW;
END;
$$;
CREATE TRIGGER "Appeal_track_next_action"
AFTER INSERT OR UPDATE OF status, "queueId", "assigneeId", "routingReason", "dueAt", "firstResponseDueAt", "firstHumanResponseAt", "slaVersion" ON "Appeal"
FOR EACH ROW EXECUTE FUNCTION track_appeal_next_action();
COMMIT;
