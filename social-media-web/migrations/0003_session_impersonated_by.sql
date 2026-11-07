-- 0003_session_impersonated_by.sql
--
-- Better Auth 1.7.9 admin plugin schema completion.
--
-- The admin plugin (verified in
-- node_modules/better-auth/dist/plugins/admin/schema.mjs) expects a nullable
-- string column `impersonatedBy` on the session table: it is set when an
-- admin starts impersonation and tells the plugin which admin session owns
-- the impersonated one. Migration 0002 predates this discovery and did not
-- include it, so it is added here as its own idempotent step.
--
-- Snake_case column name matches the package's field-naming convention
-- (email_verified, ip_address, ban_reason, ...). The column is nullable so
-- every existing session row keeps its meaning: nobody is impersonating.
-- Nothing is dropped or modified.

ALTER TABLE "session" ADD COLUMN IF NOT EXISTS "impersonated_by" text;
