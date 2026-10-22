-- Adds per-user ownership to scheduled posts and stored OAuth tokens so a single
-- deployment can host multiple applications users without sharing credentials.
--
-- Existing single-user rows are backfilled to the MCP owner identity
-- (MCP_OWNER_USER_ID, default "local-owner") so no data or credentials are lost
-- and the stdio MCP server keeps working unchanged.

ALTER TABLE public.scheduled_posts
  ADD COLUMN IF NOT EXISTS user_id TEXT NOT NULL DEFAULT 'local-owner';

CREATE INDEX IF NOT EXISTS scheduled_posts_user_due_idx
  ON public.scheduled_posts (user_id, scheduled_at);

ALTER TABLE public.oauth_tokens
  ADD COLUMN IF NOT EXISTS user_id TEXT NOT NULL DEFAULT 'local-owner';

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'public.oauth_tokens'::regclass
      AND conname = 'oauth_tokens_pkey'
      AND pg_get_constraintdef(oid) NOT ILIKE '%user_id%'
  ) THEN
    ALTER TABLE public.oauth_tokens DROP CONSTRAINT oauth_tokens_pkey;
    ALTER TABLE public.oauth_tokens
      ADD CONSTRAINT oauth_tokens_pkey PRIMARY KEY (user_id, platform);
  END IF;
END
$$;

CREATE INDEX IF NOT EXISTS oauth_tokens_user_idx
  ON public.oauth_tokens (user_id);
