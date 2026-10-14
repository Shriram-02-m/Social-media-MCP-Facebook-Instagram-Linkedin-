CREATE EXTENSION IF NOT EXISTS pg_cron;
CREATE EXTENSION IF NOT EXISTS pg_net WITH SCHEMA extensions;

CREATE SCHEMA IF NOT EXISTS private;
REVOKE ALL ON SCHEMA private FROM PUBLIC, anon, authenticated;

CREATE OR REPLACE FUNCTION private.invoke_social_media_worker()
RETURNS BIGINT
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, vault, net
AS $$
DECLARE
  worker_url TEXT;
  worker_secret TEXT;
  request_id BIGINT;
BEGIN
  SELECT decrypted_secret INTO worker_url
  FROM vault.decrypted_secrets
  WHERE name = 'social_worker_url';

  SELECT decrypted_secret INTO worker_secret
  FROM vault.decrypted_secrets
  WHERE name = 'social_worker_secret';

  IF worker_url IS NULL OR worker_url !~ '^https://[^/]+/?$' THEN
    RAISE EXCEPTION 'Set the Supabase Vault secret social_worker_url to the deployed HTTPS Render service base URL.';
  END IF;
  IF worker_secret IS NULL OR length(worker_secret) < 32 THEN
    RAISE EXCEPTION 'Set the Supabase Vault secret social_worker_secret to the worker trigger secret.';
  END IF;

  SELECT net.http_post(
    url := rtrim(worker_url, '/') || '/worker/run',
    headers := jsonb_build_object(
      'content-type', 'application/json',
      'authorization', 'Bearer ' || worker_secret
    ),
    body := '{}'::jsonb,
    timeout_milliseconds := 10000
  ) INTO request_id;

  RETURN request_id;
END;
$$;

REVOKE ALL ON FUNCTION private.invoke_social_media_worker() FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION private.invoke_social_media_worker() TO postgres;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM vault.decrypted_secrets WHERE name = 'social_worker_url'
  ) OR NOT EXISTS (
    SELECT 1 FROM vault.decrypted_secrets WHERE name = 'social_worker_secret'
  ) THEN
    RAISE EXCEPTION 'Add social_worker_url and social_worker_secret to Supabase Vault before enabling this Cron migration.';
  END IF;
END
$$;

SELECT cron.unschedule(jobid)
FROM cron.job
WHERE jobname = 'social-media-cloud-worker';

SELECT cron.schedule(
  'social-media-cloud-worker',
  '* * * * *',
  'SELECT private.invoke_social_media_worker();'
);
