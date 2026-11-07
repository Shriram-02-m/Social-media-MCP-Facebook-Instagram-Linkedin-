-- 0002_admin_multitenant.sql
--
-- Single Super Admin + multi-user management foundation (Phase 2).
--
-- Extends the Better Auth user table in place; nothing existing is dropped or
-- reset. Complements Better Auth 1.7.9's admin plugin, which supplies the
-- `role`, `banned`, `ban_reason`, and `ban_expires` columns.
--
-- approval_status semantics:
--   pending  - registration awaiting admin approval (default for NEW users)
--   approved - full access
--   rejected - registration denied
--   suspended / deleted are expressed through the admin plugin's `banned`
--   flag and the `deleted_at` column respectively (no duplicate mechanism).
--
-- Existing users are explicitly marked approved so no production account
-- loses access when this migration runs. The default is set to 'pending'
-- afterwards so every newly created user starts unapproved.

ALTER TABLE "user" ADD COLUMN IF NOT EXISTS "role" text NOT NULL DEFAULT 'user';
ALTER TABLE "user" ADD COLUMN IF NOT EXISTS "banned" boolean NOT NULL DEFAULT false;
ALTER TABLE "user" ADD COLUMN IF NOT EXISTS "ban_reason" text;
ALTER TABLE "user" ADD COLUMN IF NOT EXISTS "ban_expires" timestamp with time zone;

-- 1. Add without affecting existing rows, 2. mark every existing user
-- approved, 3. switch the default so new signups start pending.
ALTER TABLE "user" ADD COLUMN IF NOT EXISTS "approval_status" text NOT NULL DEFAULT 'approved';
UPDATE "user" SET "approval_status" = 'approved' WHERE "approval_status" IS NULL;
ALTER TABLE "user" ALTER COLUMN "approval_status" DROP DEFAULT;
ALTER TABLE "user" ALTER COLUMN "approval_status" SET DEFAULT 'pending';

ALTER TABLE "user" ADD COLUMN IF NOT EXISTS "deleted_at" timestamp with time zone;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'user_role_check'
  ) THEN
    ALTER TABLE "user"
      ADD CONSTRAINT user_role_check CHECK (role IN ('admin', 'user')) NOT VALID;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'user_approval_status_check'
  ) THEN
    ALTER TABLE "user"
      ADD CONSTRAINT user_approval_status_check
      CHECK (approval_status IN ('pending', 'approved', 'rejected')) NOT VALID;
  END IF;
END
$$;

ALTER TABLE "user"
  VALIDATE CONSTRAINT user_role_check,
  VALIDATE CONSTRAINT user_approval_status_check;

CREATE INDEX IF NOT EXISTS "user_approval_status_idx" ON "user" ("approval_status");

-- Database-level single-Super-Admin invariant: the partial unique index makes
-- a second row with role='admin' impossible even under concurrent seeds or a
-- manipulated admin API call, independently of any application logic.
CREATE UNIQUE INDEX IF NOT EXISTS "user_single_admin_idx"
  ON "user" ("role")
  WHERE "role" = 'admin';

-- Activity / audit log. DDL mirrors social-media-mcp/migrations/013_account_hold.sql
-- so both packages converge on the same table regardless of which migration
-- runs first (both are idempotent). Writers must never store passwords,
-- tokens, secrets, or encryption keys in metadata.
CREATE TABLE IF NOT EXISTS "activity_log" (
  "id" text PRIMARY KEY,
  "actor_user_id" text,
  "target_user_id" text,
  "action" text NOT NULL CHECK ("action" <> ''),
  "resource_type" text NOT NULL CHECK ("resource_type" <> ''),
  "resource_id" text,
  "metadata" jsonb NOT NULL DEFAULT '{}'::jsonb,
  "created_at" timestamp with time zone NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS "activity_log_created_at_idx" ON "activity_log" ("created_at" DESC);
CREATE INDEX IF NOT EXISTS "activity_log_target_user_idx" ON "activity_log" ("target_user_id", "created_at" DESC);
CREATE INDEX IF NOT EXISTS "activity_log_actor_user_idx" ON "activity_log" ("actor_user_id", "created_at" DESC);

ALTER TABLE "activity_log" ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE "activity_log" FROM PUBLIC, anon, authenticated;
GRANT ALL ON TABLE "activity_log" TO service_role;
