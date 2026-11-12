BEGIN;
ALTER TABLE "MeasurementPlan" ADD COLUMN "targetMaximum" DOUBLE PRECISION;
ALTER TABLE "Verification" ADD COLUMN "effect" JSONB;

WITH pairs AS (
  SELECT v."improvementId", p.method, p.unit, p.hypothesis, p.direction, p."targetValue",
    b.value::numeric AS baseline, a.value::numeric AS final,
    b.id IS NOT NULL AND a.id IS NOT NULL AS paired
  FROM "Verification" v JOIN "Improvement" i ON i.id = v."improvementId"
  JOIN "MeasurementPlan" p ON p."improvementId" = i.id AND p.version = v."planVersion"
  LEFT JOIN LATERAL (
    SELECT m.id, m.value FROM "Measurement" m WHERE m."improvementId" = i.id AND m.phase = 'BEFORE'
      AND m."planVersion" = v."planVersion" AND (m.id = ANY(v."measurementIds") OR (i.number LIKE 'DEMO-%' AND m."supersededAt" IS NULL))
    ORDER BY m."periodEnd" DESC, m.id LIMIT 1
  ) b ON TRUE
  LEFT JOIN LATERAL (
    SELECT m.id, m.value FROM "Measurement" m WHERE m."improvementId" = i.id AND m.phase = 'AFTER'
      AND m."planVersion" = v."planVersion" AND (m.id = ANY(v."measurementIds") OR (i.number LIKE 'DEMO-%' AND m."supersededAt" IS NULL))
    ORDER BY m."periodEnd" DESC, m.id LIMIT 1
  ) a ON TRUE
)
UPDATE "Verification" v SET effect = jsonb_build_object(
  'before', baseline, 'after', final, 'delta', final - baseline,
  'relativePercent', CASE WHEN abs(baseline) > 0 AND abs((final - baseline) / abs(baseline)) < 1e300::numeric
    THEN 100 * (final - baseline) / abs(baseline) END,
  'direction', direction, 'target', "targetValue", 'maximum', NULL, 'maintained', false,
  'meetsTarget', CASE direction WHEN 'DECREASE' THEN final <= "targetValue"
    WHEN 'INCREASE' THEN final >= "targetValue" WHEN 'TARGET' THEN final = "targetValue" END,
  'improved', CASE direction WHEN 'DECREASE' THEN final < baseline WHEN 'INCREASE' THEN final > baseline
    WHEN 'TARGET' THEN abs(final - "targetValue"::numeric) < abs(baseline - "targetValue"::numeric) END,
  'method', method, 'unit', unit, 'hypothesis', hypothesis, 'hasBothObservations', paired,
  'evaluatedAsDeterminate', v.outcome <> 'INCONCLUSIVE'
) FROM pairs WHERE v."improvementId" = pairs."improvementId";

CREATE TEMP TABLE verification_recheck ON COMMIT DROP AS
SELECT v."improvementId", to_jsonb(v) AS previous FROM "Verification" v
WHERE v.outcome = 'VERIFIED' AND (
  v.effect IS NULL OR (v.effect->>'method' <> 'QUALITATIVE' AND
    (v.effect->>'improved' IS DISTINCT FROM 'true' OR v.effect->>'meetsTarget' IS DISTINCT FROM 'true'))
);
INSERT INTO "AuditEvent" (id, entity, "entityId", action, origin, details)
SELECT 'verification-recheck-' || "improvementId", 'improvement', "improvementId", 'VERIFICATION_RECHECK_REQUIRED',
  'SYSTEM', jsonb_build_object('previous', previous)
FROM verification_recheck;
UPDATE "Verification" v SET outcome = 'INCONCLUSIVE', effect = CASE WHEN v.effect IS NOT NULL
  THEN jsonb_set(v.effect, '{evaluatedAsDeterminate}', 'false') END,
  limitations = v.limitations || E'\nТребуется повторная проверка по действующему критерию эффекта.'
FROM verification_recheck r WHERE v."improvementId" = r."improvementId";

WITH retracted AS (
  UPDATE "Publication" p SET state = 'RETRACTED', version = version + 1
  FROM verification_recheck r WHERE p."improvementId" = r."improvementId" AND p.state IN ('APPROVED', 'PUBLISHED')
  RETURNING p.*
)
INSERT INTO "PublicationRevision" ("publicationId", version, action, snapshot)
SELECT id, version, 'VERIFICATION_RECHECK_REQUIRED', to_jsonb(retracted) FROM retracted;
COMMIT;
