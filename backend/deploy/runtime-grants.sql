-- Run as the migration/table owner with psql -v runtime_role=... -f runtime-grants.sql.
\set ON_ERROR_STOP on
BEGIN;
GRANT USAGE ON SCHEMA public TO :"runtime_role";
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO :"runtime_role";
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO :"runtime_role";
REVOKE INSERT, UPDATE, DELETE ON public."_prisma_migrations" FROM :"runtime_role";
REVOKE UPDATE, DELETE, TRUNCATE ON public."AuditEvent", public."AppealNextAction",
  public."VerificationRevision", public."PublicationRevision" FROM :"runtime_role";
COMMIT;
