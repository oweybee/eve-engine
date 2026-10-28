-- Backfilled from the Supabase migration ledger (supabase_migrations.schema_migrations)
-- version 20261010092017, name odds_index_in_board_order. Applied directly to production; this file was
-- missing from the repo. Statements copied verbatim from the ledger on 25 Oct 2026.
-- DO NOT re-apply: it is already in the database. Nothing runs this folder.

-- Page speed, 10 Oct 2026. fixture_board keeps the latest pre-kickoff quote per
-- (match, market, line, bookmaker) out of the odds change log. The only index
-- was (match_id, fetched_at desc), so every call sorted ~1,400 rows per fixture
-- (158k rows for a six-hour Saturday window) to throw all but ~58 away.
-- This index is already in that order, so the read becomes an ordered scan.
create index if not exists idx_odds_board_order
  on public.odds (match_id, market, market_line, bookmaker, fetched_at desc);
