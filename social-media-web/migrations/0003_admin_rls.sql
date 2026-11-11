-- 0003_admin_rls.sql
--
-- Additive row-level-security audit hardening for Phase 3.
--
-- IMPORTANT
-- ---------
-- This file is NOT part of the MCP auto-migration list and is NOT applied by
-- `npm run db:migrate` unless an operator explicitly points the migration
-- runner at it. Review the application's database role before running it.
--
-- What it does:
--   1. Enables RLS on the scheduler table and the Better Auth tables that did
--      not previously have it (`scheduled_posts`, `user`, `session`, `account`,
--      `verification`).
--   2. Revokes access from PUBLIC and (when present) Supabase's `anon` and
--      `authenticated` roles, so browser-facing PostgREST access cannot read or
--      mutate these tables directly.
--   3. Grants the server-side `service_role` full access through an explicit
--      permissive policy.
--
-- What it deliberately does NOT do:
--   - It does not force row-level security. The table owner (the role the
--     application normally connects with) continues to bypass RLS exactly as
--     before, so a deployment that connects as the owner is unaffected.
--   - It does not drop, rename, or remove any data.
--   - It does not change existing `activity_log` policies.
--
-- If the application connects as a non-owner role other than `service_role`,
-- grant that role access (and add an explicit policy) before applying this
-- file, or skip it. Enabling RLS without grants would deny that role access.

DO $$
DECLARE
  target_table text;
BEGIN
  FOREACH target_table IN ARRAY ARRAY[
    'scheduled_posts',
    'user',
    'session',
    'account',
    'verification'
  ]
  LOOP
    IF NOT EXISTS (
      SELECT 1
        FROM pg_tables
       WHERE schemaname = 'public'
         AND tablename = target_table
    ) THEN
      CONTINUE;
    END IF;

    -- Enabling RLS without FORCE keeps the owner's bypass behaviour intact.
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', target_table);
    EXECUTE format('REVOKE ALL ON TABLE public.%I FROM PUBLIC', target_table);

    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
      EXECUTE format('REVOKE ALL ON TABLE public.%I FROM anon', target_table);
    END IF;

    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
      EXECUTE format('REVOKE ALL ON TABLE public.%I FROM authenticated', target_table);
    END IF;

    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') THEN
      EXECUTE format('GRANT ALL ON TABLE public.%I TO service_role', target_table);

      IF NOT EXISTS (
        SELECT 1
          FROM pg_policies
         WHERE schemaname = 'public'
           AND tablename = target_table
           AND policyname = target_table || '_service_role'
      ) THEN
        EXECUTE format(
          'CREATE POLICY %I ON public.%I FOR ALL TO service_role USING (true) WITH CHECK (true)',
          target_table || '_service_role',
          target_table
        );
      END IF;
    END IF;
  END LOOP;
END
$$;

-- Keep the existing audit table locked down; re-assert idempotently in case an
-- earlier deployment skipped the grants.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1
      FROM pg_tables
     WHERE schemaname = 'public'
       AND tablename = 'activity_log'
  ) THEN
    EXECUTE 'ALTER TABLE public.activity_log ENABLE ROW LEVEL SECURITY';
    EXECUTE 'REVOKE ALL ON TABLE public.activity_log FROM PUBLIC';

    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
      EXECUTE 'REVOKE ALL ON TABLE public.activity_log FROM anon';
    END IF;

    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
      EXECUTE 'REVOKE ALL ON TABLE public.activity_log FROM authenticated';
    END IF;

    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') THEN
      EXECUTE 'GRANT ALL ON TABLE public.activity_log TO service_role';
    END IF;
  END IF;
END
$$;
