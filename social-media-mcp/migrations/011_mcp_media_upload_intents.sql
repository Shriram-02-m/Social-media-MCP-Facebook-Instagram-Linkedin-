-- Single-use media upload intents for MCP clients (Claude.ai, Claude Code).
--
-- Remote MCP tools receive neither file bytes nor a browser file handle, so a
-- tool mints a short-lived, single-use upload intent bound to the authenticated
-- better-auth user. The tool returns an HTTPS upload endpoint plus a raw upload
-- token exactly once; only the SHA-256 digest of the token is persisted here.
-- The cloud worker endpoint (POST /media/upload) claims the intent atomically
-- before accepting bytes, validates the file server-side, writes it into the
-- private Supabase Storage bucket under the owner's per-user prefix, and
-- returns the permanent object path (`storagePath`). Only that permanent path
-- is ever persisted or returned; an expiring signed URL is never stored.
--
-- Additive only: no existing post, token, OAuth session, or credential row is
-- modified or deleted. Expired/failed intents are swept by application code.

CREATE TABLE IF NOT EXISTS public.mcp_media_upload_intents (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  client_id TEXT,
  -- Plaintext upload tokens are returned once and never written here.
  token_hash TEXT NOT NULL UNIQUE,
  original_filename TEXT NOT NULL DEFAULT '',
  content_type TEXT NOT NULL,
  expected_bytes INTEGER NOT NULL DEFAULT 0 CHECK (expected_bytes >= 0),
  kind TEXT NOT NULL CHECK (kind IN ('image', 'video', 'document')),
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'uploaded', 'failed')),
  storage_path TEXT,
  uploaded_bytes INTEGER,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  expires_at TIMESTAMPTZ NOT NULL,
  consumed_at TIMESTAMPTZ,
  uploaded_at TIMESTAMPTZ,
  CHECK (status <> 'uploaded' OR (storage_path IS NOT NULL AND consumed_at IS NOT NULL))
);

CREATE INDEX IF NOT EXISTS mcp_media_upload_intents_user_idx
  ON public.mcp_media_upload_intents (user_id, created_at DESC);

CREATE INDEX IF NOT EXISTS mcp_media_upload_intents_expires_idx
  ON public.mcp_media_upload_intents (expires_at);

CREATE INDEX IF NOT EXISTS mcp_media_upload_intents_status_idx
  ON public.mcp_media_upload_intents (status)
  WHERE status <> 'uploaded';

ALTER TABLE public.mcp_media_upload_intents ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON TABLE public.mcp_media_upload_intents FROM PUBLIC, anon, authenticated;

GRANT ALL ON TABLE public.mcp_media_upload_intents TO service_role;
