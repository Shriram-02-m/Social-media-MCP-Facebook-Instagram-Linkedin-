-- Adds ordered multi-media support (images + video) to scheduled posts.

ALTER TABLE public.scheduled_posts
  ADD COLUMN IF NOT EXISTS media_type TEXT;

UPDATE public.scheduled_posts
SET media_type = CASE
  WHEN COALESCE(document_storage_path, '') <> '' OR COALESCE(document_path, '') <> '' THEN 'document'
  ELSE 'image'
END
WHERE media_type IS NULL;

ALTER TABLE public.scheduled_posts
  ALTER COLUMN media_type SET DEFAULT 'image';

ALTER TABLE public.scheduled_posts
  ALTER COLUMN media_type SET NOT NULL;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'public.scheduled_posts'::regclass
      AND conname = 'scheduled_posts_media_type_check'
  ) THEN
    ALTER TABLE public.scheduled_posts
      ADD CONSTRAINT scheduled_posts_media_type_check
      CHECK (media_type IN ('none', 'image', 'video', 'carousel', 'document')) NOT VALID;
  END IF;
END
$$;

ALTER TABLE public.scheduled_posts
  VALIDATE CONSTRAINT scheduled_posts_media_type_check;

CREATE TABLE IF NOT EXISTS public.scheduled_post_media (
  id TEXT PRIMARY KEY,
  post_id TEXT NOT NULL REFERENCES public.scheduled_posts(id) ON DELETE CASCADE,
  position INTEGER NOT NULL CHECK (position >= 0),
  kind TEXT NOT NULL CHECK (kind IN ('image', 'video')),
  image_token TEXT NOT NULL DEFAULT '',
  image_path TEXT NOT NULL DEFAULT '',
  storage_path TEXT,
  content_type TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (post_id, position)
);

CREATE INDEX IF NOT EXISTS scheduled_post_media_post_id_idx
  ON public.scheduled_post_media (post_id, position);

ALTER TABLE public.scheduled_post_media ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.scheduled_post_media FROM PUBLIC, anon, authenticated;
GRANT ALL ON TABLE public.scheduled_post_media TO service_role;

-- Backfill a single image media row for every pre-existing job that stored media.
INSERT INTO public.scheduled_post_media (id, post_id, position, kind, image_token, image_path, storage_path, content_type, created_at)
SELECT
  replace(gen_random_uuid()::text, '-', ''),
  sp.id,
  0,
  'image',
  COALESCE(sp.image_token, ''),
  COALESCE(sp.image_path, ''),
  sp.image_storage_path,
  COALESCE(sp.content_type, 'image/jpeg'),
  sp.created_at
FROM public.scheduled_posts sp
WHERE NOT EXISTS (SELECT 1 FROM public.scheduled_post_media m WHERE m.post_id = sp.id)
  AND (COALESCE(sp.image_path, '') <> '' OR COALESCE(sp.image_storage_path, '') <> '');

-- Allow video uploads in the private media bucket and raise its size limit.
UPDATE storage.buckets
SET allowed_mime_types = ARRAY['image/jpeg', 'image/png', 'image/gif', 'application/pdf', 'video/mp4', 'video/quicktime'],
    file_size_limit = 52428800
WHERE id = 'social-media-images';
