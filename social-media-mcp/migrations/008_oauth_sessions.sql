-- Persists browser OAuth authorization sessions so any cloud worker instance can
-- complete a provider callback. In local mode the equivalent state lives in
-- process memory; in cloud mode (OAUTH_CALLBACK_MODE=cloud) the frontend creates
-- a row, the provider redirects to the public worker, and the worker atomically
-- claims the row exactly once.
--
-- Only the SHA-256 digest of the `state` value is stored so a database reader can
-- never reuse the bearer-style state to complete an authorization. OAuth codes,
-- access tokens, refresh tokens, and client secrets are never written here.

CREATE TABLE IF NOT EXISTS public.oauth_authorization_sessions (
  session_id TEXT PRIMARY KEY,
  state_hash TEXT NOT NULL UNIQUE,
  user_id TEXT NOT NULL,
  platform TEXT NOT NULL CHECK (platform IN ('instagram', 'facebook', 'linkedin')),
  redirect_uri TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'processing', 'connected', 'cancelled', 'failed', 'expired')),
  error TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  claimed_at TIMESTAMPTZ,
  completed_at TIMESTAMPTZ,
  expires_at TIMESTAMPTZ NOT NULL
);

CREATE INDEX IF NOT EXISTS oauth_authorization_sessions_user_idx
  ON public.oauth_authorization_sessions (user_id, created_at DESC);

CREATE INDEX IF NOT EXISTS oauth_authorization_sessions_expires_idx
  ON public.oauth_authorization_sessions (expires_at);

ALTER TABLE public.oauth_authorization_sessions ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.oauth_authorization_sessions FROM PUBLIC, anon, authenticated;
GRANT ALL ON TABLE public.oauth_authorization_sessions TO service_role;
