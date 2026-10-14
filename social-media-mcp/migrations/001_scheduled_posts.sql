CREATE TABLE IF NOT EXISTS public.scheduled_posts (
  id TEXT PRIMARY KEY,
  platform TEXT NOT NULL CHECK (platform IN ('instagram', 'facebook', 'linkedin')),
  scheduled_at TIMESTAMPTZ NOT NULL,
  text TEXT NOT NULL,
  image_token TEXT NOT NULL UNIQUE,
  image_path TEXT NOT NULL,
  content_type TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('scheduled', 'publishing', 'published', 'failed')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  claimed_at TIMESTAMPTZ,
  published_at TIMESTAMPTZ,
  result JSONB,
  error TEXT
);

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_indexes
    WHERE schemaname = 'public'
      AND tablename = 'scheduled_posts'
      AND indexdef ILIKE 'CREATE%INDEX%ON public.scheduled_posts USING btree (scheduled_at)%WHERE (status = ''scheduled''::text)%'
  ) THEN
    CREATE INDEX scheduled_posts_due_idx
      ON public.scheduled_posts (scheduled_at)
      WHERE status = 'scheduled';
  END IF;
END
$$;

ALTER TABLE public.scheduled_posts
  ADD COLUMN IF NOT EXISTS retry_count INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS failure_stage TEXT CHECK (failure_stage IN ('image_validation', 'publishing')),
  ADD COLUMN IF NOT EXISTS image_validation JSONB;