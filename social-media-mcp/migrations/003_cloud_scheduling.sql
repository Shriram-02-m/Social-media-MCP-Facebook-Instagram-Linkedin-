ALTER TABLE public.scheduled_posts
  ADD COLUMN IF NOT EXISTS image_storage_path TEXT;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'public.scheduled_posts'::regclass
      AND conname = 'scheduled_posts_status_check'
      AND pg_get_constraintdef(oid) ILIKE '%cancelled%'
  ) THEN
    ALTER TABLE public.scheduled_posts
      DROP CONSTRAINT IF EXISTS scheduled_posts_status_check;
    ALTER TABLE public.scheduled_posts
      ADD CONSTRAINT scheduled_posts_status_check
      CHECK (status IN ('scheduled', 'publishing', 'published', 'failed', 'cancelled')) NOT VALID;
  END IF;
END
$$;

ALTER TABLE public.scheduled_posts
  VALIDATE CONSTRAINT scheduled_posts_status_check;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'public.scheduled_posts'::regclass
      AND conname = 'scheduled_posts_failure_stage_check'
      AND pg_get_constraintdef(oid) ILIKE '%token_validation%'
  ) THEN
    ALTER TABLE public.scheduled_posts
      DROP CONSTRAINT IF EXISTS scheduled_posts_failure_stage_check;
    ALTER TABLE public.scheduled_posts
      ADD CONSTRAINT scheduled_posts_failure_stage_check
      CHECK (failure_stage IS NULL OR failure_stage IN ('token_validation', 'image_validation', 'publishing')) NOT VALID;
  END IF;
END
$$;

ALTER TABLE public.scheduled_posts
  VALIDATE CONSTRAINT scheduled_posts_failure_stage_check;

CREATE TABLE IF NOT EXISTS public.oauth_tokens (
  platform TEXT PRIMARY KEY CHECK (platform IN ('instagram', 'facebook', 'linkedin')),
  token_ciphertext JSONB NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

ALTER TABLE public.oauth_tokens ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.oauth_tokens FROM PUBLIC, anon, authenticated;
GRANT ALL ON TABLE public.oauth_tokens TO service_role;

INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
VALUES (
  'social-media-images',
  'social-media-images',
  FALSE,
  10485760,
  ARRAY['image/jpeg', 'image/png', 'image/gif']
)
ON CONFLICT (id) DO NOTHING;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM storage.buckets
    WHERE id = 'social-media-images' AND public = TRUE
  ) THEN
    RAISE EXCEPTION 'The social-media-images bucket is public. Make it private before using cloud scheduled images.';
  END IF;
END
$$;
