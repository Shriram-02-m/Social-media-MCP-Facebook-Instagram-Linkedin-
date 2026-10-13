CREATE TABLE IF NOT EXISTS scheduled_posts (
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

CREATE INDEX IF NOT EXISTS scheduled_posts_due_idx
  ON scheduled_posts (scheduled_at)
  WHERE status = 'scheduled';

ALTER TABLE scheduled_posts
  ADD COLUMN IF NOT EXISTS retry_count INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS failure_stage TEXT CHECK (failure_stage IN ('image_validation', 'publishing')),
  ADD COLUMN IF NOT EXISTS image_validation JSONB;