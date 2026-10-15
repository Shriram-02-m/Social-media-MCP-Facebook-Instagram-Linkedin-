ALTER TABLE public.scheduled_posts
  ADD COLUMN IF NOT EXISTS document_path TEXT NOT NULL DEFAULT '';

ALTER TABLE public.scheduled_posts
  ADD COLUMN IF NOT EXISTS document_storage_path TEXT;

ALTER TABLE public.scheduled_posts
  ADD COLUMN IF NOT EXISTS document_content_type TEXT;

ALTER TABLE public.scheduled_posts
  ADD COLUMN IF NOT EXISTS document_title TEXT;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'public.scheduled_posts'::regclass
      AND conname = 'scheduled_posts_failure_stage_check'
      AND pg_get_constraintdef(oid) ILIKE '%document_validation%'
  ) THEN
    ALTER TABLE public.scheduled_posts
      DROP CONSTRAINT IF EXISTS scheduled_posts_failure_stage_check;
    ALTER TABLE public.scheduled_posts
      ADD CONSTRAINT scheduled_posts_failure_stage_check
      CHECK (failure_stage IS NULL OR failure_stage IN ('token_validation', 'image_validation', 'document_validation', 'publishing')) NOT VALID;
  END IF;
END
$$;

ALTER TABLE public.scheduled_posts
  VALIDATE CONSTRAINT scheduled_posts_failure_stage_check;

UPDATE storage.buckets
SET allowed_mime_types = ARRAY['image/jpeg', 'image/png', 'image/gif', 'application/pdf']
WHERE id = 'social-media-images';
