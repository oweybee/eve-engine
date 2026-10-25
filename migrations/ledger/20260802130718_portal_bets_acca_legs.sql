-- Backfilled from the Supabase migration ledger (supabase_migrations.schema_migrations)
-- version 20260802130718, name portal_bets_acca_legs. Applied directly to production; this file was
-- missing from the repo. Statements copied verbatim from the ledger on 25 Oct 2026.
-- DO NOT re-apply: it is already in the database. Nothing runs this folder.

-- Accumulator support for the member portal's ledger.
--
-- An acca is ONE row in public.bets, not one row per leg: the ticket has one
-- stake, one combined price and one outcome, so every existing aggregate in
-- lib/portal/stats.js (P&L, ROI, win rate, open liability, the free-tier row
-- cap) stays correct with no change to the math. The legs live here as an
-- ordered jsonb array, purely for display and for a future settlement pass.
--
-- settle_my_bets() already skips is_acca rows, so accas settle by hand from the
-- ledger's Won / Lost / Void controls, as they must until every leg's match is
-- linked and resolvable.

alter table public.bets add column if not exists acca_legs jsonb;

comment on column public.bets.acca_legs is
  'Ordered array of accumulator legs for an is_acca ticket row: '
  '[{ match_label, competition, kickoff_at, market, selection, market_line, '
  'odds_taken, bookmaker, match_id, signal_id, mes_at_record, edge_at_record, '
  'model_tag }]. Null on singles.';

alter table public.bets drop constraint if exists bets_acca_legs_shape;
alter table public.bets add constraint bets_acca_legs_shape check (
  case when is_acca
    then jsonb_typeof(acca_legs) = 'array' and jsonb_array_length(acca_legs) >= 2
    else acca_legs is null
  end
);
