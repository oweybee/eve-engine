-- Backfilled from the Supabase migration ledger (supabase_migrations.schema_migrations)
-- version 20261023104959, name odds_board_takeable_covering_index. Applied directly to production; this file was
-- missing from the repo. Statements copied verbatim from the ledger on 25 Oct 2026.
-- DO NOT re-apply: it is already in the database. Nothing runs this folder.

-- fixture_board(): the per-fixture odds lookup read ~216 scattered heap rows per
-- match (index scan + is_takeable_book filter), ~15ms x 200 fixtures, and the
-- homepage's fixture_board_all intermittently hit the anon timeout (500).
-- Partial + covering, matching the function's predicate exactly, so the lateral
-- becomes an index-only scan over takeable rows. Additive; drop to revert.
set local statement_timeout = '10min';
create index if not exists idx_odds_board_takeable
  on public.odds (match_id, market, market_line, bookmaker, fetched_at desc)
  include (home_odds, draw_odds, away_odds)
  where market in ('h2h','totals','btts') and public.is_takeable_book(bookmaker);
analyze public.odds;
