-- Durable rate-limit hit history for MCP media upload intent creation.
--
-- The in-process sliding-window limiter resets on scale-to-zero and multiplies
-- across worker instances. This table gives every cloud worker a shared view of
-- recent intent-creation hits per authenticated user so the configured limit
-- holds across restarts, cold starts, and multiple instances. The limiter still
-- applies in-process first; the database check is best-effort and fails open
-- while the database is unavailable (the in-process window remains the guard).
--
-- Additive only: no existing table, row, constraint, or policy is modified.
-- Old hits are removed by application code (the intent-creation path) in the
-- same rolling window they are checked against, so the table stays small.

CREATE TABLE IF NOT EXISTS public.mcp_media_intent_rate_hits (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  hit_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS mcp_media_intent_rate_hits_window_idx
  ON public.mcp_media_intent_rate_hits (user_id, hit_at);

ALTER TABLE public.mcp_media_intent_rate_hits ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON TABLE public.mcp_media_intent_rate_hits FROM PUBLIC, anon, authenticated;

GRANT ALL ON TABLE public.mcp_media_intent_rate_hits TO service_role;
