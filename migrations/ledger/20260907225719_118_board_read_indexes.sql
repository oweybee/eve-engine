-- Backfilled from the Supabase migration ledger (supabase_migrations.schema_migrations)
-- version 20260907225719, name 118_board_read_indexes. Applied directly to production; this file was
-- missing from the repo. Statements copied verbatim from the ledger on 25 Oct 2026.
-- DO NOT re-apply: it is already in the database. Nothing runs this folder.


-- 118: Support the board read.
-- v_board_rows takes DISTINCT ON (match_id) ORDER BY match_id, computed_at DESC,
-- which without this index is a full scan of computed_values plus a sort.
create index if not exists computed_values_match_computed_desc
  on public.computed_values (match_id, computed_at desc);

-- The freshness gate filters on odds_fetched_at; keep it cheap as the table grows.
create index if not exists computed_values_odds_fetched_at
  on public.computed_values (odds_fetched_at desc);

analyze public.computed_values;

