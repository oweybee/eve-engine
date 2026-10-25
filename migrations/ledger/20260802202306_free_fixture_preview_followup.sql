-- Backfilled from the Supabase migration ledger (supabase_migrations.schema_migrations)
-- version 20260802202306, name free_fixture_preview_followup. Applied directly to production; this file was
-- missing from the repo. Statements copied verbatim from the ledger on 25 Oct 2026.
-- DO NOT re-apply: it is already in the database. Nothing runs this folder.

-- 047a — two corrections to 047, both flagged by the Supabase linter.
--
-- 1. league_directory goes BACK to security_invoker=true. Making it owner-run
--    kept the catalogue whole for free readers, but it trips the linter's
--    ERROR-level `security_definer_view` rule, and a standing ERROR on a view
--    that bypasses RLS is the wrong thing to teach the next person who reads
--    the advisor list. The frontend instead stops quoting a number it cannot
--    trust at every tier — see components/FixtureBoard, which now says "every
--    competition the engine covers" rather than "all 43", which is the same
--    never-invent-a-total rule the preview notes already follow.
--
-- 2. free_fixture_limit() gets a pinned search_path, as every other function in
--    this schema has. free_preview_limit() from 034 was missing it too and is
--    fixed here in passing — both are IMMUTABLE constants so the exposure is
--    nil, but "nil" is not a reason to leave a mutable search_path behind.

alter view public.league_directory set (security_invoker = true);

create or replace function public.free_fixture_limit()
returns integer language sql immutable
set search_path = public, pg_catalog as $$ select 20 $$;

create or replace function public.free_preview_limit()
returns integer language sql immutable
set search_path = public, pg_catalog as $$ select 5 $$;
