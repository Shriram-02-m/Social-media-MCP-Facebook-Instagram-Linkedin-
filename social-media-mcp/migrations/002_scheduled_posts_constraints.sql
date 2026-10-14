DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'public.scheduled_posts'::regclass
      AND conname = 'scheduled_posts_platform_check'
  ) THEN
    ALTER TABLE public.scheduled_posts
      ADD CONSTRAINT scheduled_posts_platform_check
      CHECK (platform IN ('instagram', 'facebook', 'linkedin')) NOT VALID;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'public.scheduled_posts'::regclass
      AND conname = 'scheduled_posts_status_check'
  ) THEN
    ALTER TABLE public.scheduled_posts
      ADD CONSTRAINT scheduled_posts_status_check
      CHECK (status IN ('scheduled', 'publishing', 'published', 'failed')) NOT VALID;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'public.scheduled_posts'::regclass
      AND conname = 'scheduled_posts_failure_stage_check'
  ) THEN
    ALTER TABLE public.scheduled_posts
      ADD CONSTRAINT scheduled_posts_failure_stage_check
      CHECK (failure_stage IS NULL OR failure_stage IN ('image_validation', 'publishing')) NOT VALID;
  END IF;
END
$$;

ALTER TABLE public.scheduled_posts
  VALIDATE CONSTRAINT scheduled_posts_platform_check,
  VALIDATE CONSTRAINT scheduled_posts_status_check,
  VALIDATE CONSTRAINT scheduled_posts_failure_stage_check;
