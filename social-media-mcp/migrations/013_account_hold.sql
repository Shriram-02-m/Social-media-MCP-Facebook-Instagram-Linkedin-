-- 013_account_hold.sql
--
-- Adds account-level hold support for the single Super Admin / multi-user
-- management system.
--
-- 1. `held` becomes a legal scheduled-post status. A held post is a post whose
--    owner was suspended or soft-deleted before it could publish. It keeps its
--    original scheduled_at, content, media references, and publishing history.
--    A held post is only ever returned to `scheduled` by an explicit admin
--    resume action (or a per-post reschedule) - never automatically, and
--    overdue held posts stay held until the admin explicitly reschedules them.
-- 2. The worker claim query is extended with a database-level guard function
--    `social_media_account_is_active`, so a suspended or soft-deleted account's
--    posts can never be claimed for publishing even if a hold transition and a
--    worker claim race each other. The function reads the Better Auth `user`
--    table (created by social-media-web migration 0002). When that table does
--    not exist (stdio-only installation), the guard allows posting so legacy
--    local single-owner deployments keep working unchanged.
-- 3. The `activity_log` table (single source of truth; social-media-web
--    migration 0002 creates the identical table for the web app). Best-effort
--    writers only ever insert non-sensitive metadata - never passwords,
--    tokens, secrets, or keys.

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'public.scheduled_posts'::regclass
      AND conname = 'scheduled_posts_status_check'
      AND pg_get_constraintdef(oid) ILIKE '%held%'
  ) THEN
    ALTER TABLE public.scheduled_posts
      DROP CONSTRAINT IF EXISTS scheduled_posts_status_check;
    ALTER TABLE public.scheduled_posts
      ADD CONSTRAINT scheduled_posts_status_check
      CHECK (status IN ('scheduled', 'publishing', 'published', 'failed', 'cancelled', 'held')) NOT VALID;
  END IF;
END
$$;

ALTER TABLE public.scheduled_posts
  VALIDATE CONSTRAINT scheduled_posts_status_check;

-- Accounts that may have posts claimed for publishing.
CREATE OR REPLACE FUNCTION public.social_media_account_is_active(owner_user_id TEXT)
RETURNS BOOLEAN
LANGUAGE plpgsql
STABLE
AS $$
DECLARE
  account_record RECORD;
BEGIN
  IF owner_user_id IS NULL OR owner_user_id = '' THEN
    RETURN FALSE;
  END IF;

  IF to_regclass('public."user"') IS NULL THEN
    -- The registration system (social-media-web) has not been migrated on this
    -- database, e.g. a stdio-only deployment. There is no account state to
    -- enforce; `local-owner` scheduling keeps working unchanged.
    RETURN TRUE;
  END IF;

  SELECT banned, deleted_at, approval_status
    INTO account_record
    FROM public."user"
   WHERE id = owner_user_id;

  IF NOT FOUND THEN
    -- Unknown ids that predate the web user table are only allowed for the
    -- legacy local MCP owner; other unknown ids are treated as inactive.
    RETURN owner_user_id = 'local-owner';
  END IF;

  RETURN account_record.deleted_at IS NULL
     AND NOT COALESCE(account_record.banned, FALSE)
     AND account_record.approval_status = 'approved';
EXCEPTION
  WHEN OTHERS THEN
    -- The explicit `held` status transition still protects suspended users;
    -- treat an unreadable account table as inactive for real web users so a
    -- misconfiguration can never silently publish against a held account.
    RETURN owner_user_id = 'local-owner';
END
$$;

-- Activity / audit log. DDL mirrors social-media-web/migrations/0002_admin_multitenant.sql.
CREATE TABLE IF NOT EXISTS public.activity_log (
  id TEXT PRIMARY KEY,
  actor_user_id TEXT,
  target_user_id TEXT,
  action TEXT NOT NULL CHECK (action <> ''),
  resource_type TEXT NOT NULL CHECK (resource_type <> ''),
  resource_id TEXT,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS activity_log_created_at_idx
  ON public.activity_log (created_at DESC);

CREATE INDEX IF NOT EXISTS activity_log_target_user_idx
  ON public.activity_log (target_user_id, created_at DESC);

CREATE INDEX IF NOT EXISTS activity_log_actor_user_idx
  ON public.activity_log (actor_user_id, created_at DESC);

ALTER TABLE public.activity_log ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.activity_log FROM PUBLIC, anon, authenticated;
GRANT ALL ON TABLE public.activity_log TO service_role;
