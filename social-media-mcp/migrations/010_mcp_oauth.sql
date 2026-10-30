-- Remote MCP OAuth 2.1 state. The Render worker is both the authorization
-- server and the resource server for `MCP_PUBLIC_URL`; Vercel only renders the
-- consent screen and creates a one-time authorization code bound to the signed-in
-- better-auth user.
--
-- Every bearer-style value (authorization code, access token, refresh token,
-- client secret) is stored only as a SHA-256 digest. Plaintext values are
-- returned once to the caller and never written here, logged, or exposed by the
-- status APIs. Redirect URIs are exact-match strings, and clients are registered
-- through Dynamic Client Registration with an origin allowlist enforced in code.
--
-- Additive only: no existing post, token, OAuth session, or credential row is
-- modified or deleted.

CREATE TABLE IF NOT EXISTS public.mcp_oauth_clients (
  client_id TEXT PRIMARY KEY,
  client_secret_hash TEXT,
  client_name TEXT,
  redirect_uris TEXT[] NOT NULL,
  grant_types TEXT[] NOT NULL DEFAULT ARRAY['authorization_code', 'refresh_token']::TEXT[],
  response_types TEXT[] NOT NULL DEFAULT ARRAY['code']::TEXT[],
  token_endpoint_auth_method TEXT NOT NULL DEFAULT 'none'
    CHECK (token_endpoint_auth_method IN ('none', 'client_secret_basic', 'client_secret_post')),
  scope TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_used_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS mcp_oauth_clients_created_idx
  ON public.mcp_oauth_clients (created_at DESC);

CREATE TABLE IF NOT EXISTS public.mcp_oauth_authorization_codes (
  code_hash TEXT PRIMARY KEY,
  client_id TEXT NOT NULL REFERENCES public.mcp_oauth_clients (client_id) ON DELETE CASCADE,
  user_id TEXT NOT NULL,
  redirect_uri TEXT NOT NULL,
  scope TEXT NOT NULL,
  resource TEXT NOT NULL,
  code_challenge TEXT NOT NULL,
  code_challenge_method TEXT NOT NULL CHECK (code_challenge_method = 'S256'),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  expires_at TIMESTAMPTZ NOT NULL,
  consumed_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS mcp_oauth_authorization_codes_expires_idx
  ON public.mcp_oauth_authorization_codes (expires_at);

CREATE INDEX IF NOT EXISTS mcp_oauth_authorization_codes_user_idx
  ON public.mcp_oauth_authorization_codes (user_id, created_at DESC);

CREATE TABLE IF NOT EXISTS public.mcp_oauth_access_tokens (
  token_hash TEXT PRIMARY KEY,
  client_id TEXT NOT NULL REFERENCES public.mcp_oauth_clients (client_id) ON DELETE CASCADE,
  user_id TEXT NOT NULL,
  scope TEXT NOT NULL,
  resource TEXT NOT NULL,
  family_id TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  expires_at TIMESTAMPTZ NOT NULL,
  revoked_at TIMESTAMPTZ,
  last_used_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS mcp_oauth_access_tokens_user_idx
  ON public.mcp_oauth_access_tokens (user_id, created_at DESC);

CREATE INDEX IF NOT EXISTS mcp_oauth_access_tokens_family_idx
  ON public.mcp_oauth_access_tokens (family_id);

CREATE INDEX IF NOT EXISTS mcp_oauth_access_tokens_expires_idx
  ON public.mcp_oauth_access_tokens (expires_at);

CREATE TABLE IF NOT EXISTS public.mcp_oauth_refresh_tokens (
  token_hash TEXT PRIMARY KEY,
  client_id TEXT NOT NULL REFERENCES public.mcp_oauth_clients (client_id) ON DELETE CASCADE,
  user_id TEXT NOT NULL,
  scope TEXT NOT NULL,
  resource TEXT NOT NULL,
  family_id TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  expires_at TIMESTAMPTZ NOT NULL,
  revoked_at TIMESTAMPTZ,
  rotated_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS mcp_oauth_refresh_tokens_user_idx
  ON public.mcp_oauth_refresh_tokens (user_id, created_at DESC);

CREATE INDEX IF NOT EXISTS mcp_oauth_refresh_tokens_family_idx
  ON public.mcp_oauth_refresh_tokens (family_id);

CREATE INDEX IF NOT EXISTS mcp_oauth_refresh_tokens_expires_idx
  ON public.mcp_oauth_refresh_tokens (expires_at);

ALTER TABLE public.mcp_oauth_clients ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.mcp_oauth_authorization_codes ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.mcp_oauth_access_tokens ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.mcp_oauth_refresh_tokens ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON TABLE public.mcp_oauth_clients FROM PUBLIC, anon, authenticated;
REVOKE ALL ON TABLE public.mcp_oauth_authorization_codes FROM PUBLIC, anon, authenticated;
REVOKE ALL ON TABLE public.mcp_oauth_access_tokens FROM PUBLIC, anon, authenticated;
REVOKE ALL ON TABLE public.mcp_oauth_refresh_tokens FROM PUBLIC, anon, authenticated;

GRANT ALL ON TABLE public.mcp_oauth_clients TO service_role;
GRANT ALL ON TABLE public.mcp_oauth_authorization_codes TO service_role;
GRANT ALL ON TABLE public.mcp_oauth_access_tokens TO service_role;
GRANT ALL ON TABLE public.mcp_oauth_refresh_tokens TO service_role;
