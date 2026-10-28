-- Adds user-owned Developer App credentials so each authenticated user can run
-- OAuth through their own Meta / Instagram / LinkedIn app instead of the shared
-- deployment app. The client secret is stored only as an AES-256-GCM envelope
-- (JSONB) bound to the owning user and provider; plaintext secrets are never
-- written here. A missing row means "use the shared environment credentials".
--
-- The new `app_credential_fingerprint` column pins the credential version that
-- started an authorization flow so a mid-flow edit can never swap the app that
-- finishes the exchange. It is nullable so in-flight sessions created before this
-- migration keep working.
--
-- This migration is additive only: no existing token, scheduled post, or OAuth
-- session is modified or deleted.

CREATE TABLE IF NOT EXISTS public.oauth_app_credentials (
  user_id TEXT NOT NULL,
  provider TEXT NOT NULL CHECK (provider IN ('instagram', 'facebook', 'linkedin')),
  client_id TEXT NOT NULL,
  client_secret_ciphertext JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (user_id, provider)
);

CREATE INDEX IF NOT EXISTS oauth_app_credentials_user_idx
  ON public.oauth_app_credentials (user_id);

ALTER TABLE public.oauth_app_credentials ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.oauth_app_credentials FROM PUBLIC, anon, authenticated;
GRANT ALL ON TABLE public.oauth_app_credentials TO service_role;

ALTER TABLE public.oauth_authorization_sessions
  ADD COLUMN IF NOT EXISTS app_credential_fingerprint TEXT;
