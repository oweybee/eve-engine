-- 087_closing_lines_conflict_target.sql
--
-- THE CLOSING-LINE WRITER HAS NEVER WRITTEN A ROW, AND NOTHING SAID SO.
--
-- `/performance` shows an em-dash in the ADJ CLV column for every signal
-- settled on or after 19 Aug 2026 — 49 of them by the time this was found.
-- The cause is one line, and it is not in the arithmetic.
--
-- Migration 061 created the natural key as an EXPRESSION index:
--
--     create unique index closing_lines_unique
--       on public.closing_lines (match_id, market, coalesce(market_line, -1), selection);
--
-- The COALESCE is there for a real reason — `market_line` is null on h2h and
-- BTTS, and before Postgres 15 a null never equalled a null in a unique index,
-- so two h2h closing lines for one fixture would not have collided.
--
-- But `captureClosingLines.js` upserts with
--
--     onConflict: 'match_id,market,market_line,selection'
--
-- and Postgres cannot infer an expression index from a plain column list. So
-- every run computes the vector correctly and then throws it away:
--
--     [closing] 10 kicked off, 0 already captured, 10 to do
--     [closing] 70 lines from 10 fixtures (no odds: 0, no usable vector: 0)
--     [closing] closing_lines insert: there is no unique or exclusion
--               constraint matching the ON CONFLICT specification
--
-- "0 already captured" is the tell: it re-reads the same fixtures every 15
-- minutes and fails on every one of them. The 4,607 rows in the table did not
-- come from the writer at all — they came from migration 062, a one-off SQL
-- backfill using a bare `on conflict do nothing`, which needs no target and is
-- therefore always legal. That backfill is why the data stops dead on the day
-- it ran, and why this looked like a feed going quiet rather than a broken
-- insert.
--
-- `closing_lines_independent` (migration 073) carries the IDENTICAL index and
-- the IDENTICAL upsert, so the Pinnacle-excluded anchor is dead the same way —
-- and migration 074 made `paper_trade_gate()` REQUIRE it. The gate has been
-- opening on a table nothing can write to.
--
-- THE FIX IS THE INDEX, NOT THE WRITER. Postgres 15 added NULLS NOT DISTINCT,
-- which expresses exactly what the COALESCE was emulating, on the plain column
-- list — so the target the writers already send becomes inferable and no
-- application code changes. This database is on 17.
--
-- Semantics are equivalent or stricter. Two rows with a null `market_line`
-- still collide. A literal `market_line = -1` no longer collides with a null
-- one, which the old index wrongly merged; no such row exists, and a real -1
-- line is not the same thing as no line.
--
-- Probed in a rolled-back transaction against production before it was
-- written: the writer's ON CONFLICT is rejected with the production error
-- against the old index, accepted against the new one, and de-duplicates both
-- a null `market_line` and a `totals 2.5` line on re-insert.
--
-- Reversible: drop the new index and re-create the COALESCE one, both printed
-- below.
--
--     drop index public.closing_lines_natural_key;
--     create unique index closing_lines_unique
--       on public.closing_lines (match_id, market, coalesce(market_line, -1), selection);

begin;

-- ── 1. A conflict target the writers can name ───────────────────────────────

create unique index if not exists closing_lines_natural_key
  on public.closing_lines (match_id, market, market_line, selection)
  nulls not distinct;

create unique index if not exists closing_lines_independent_natural_key
  on public.closing_lines_independent (match_id, market, market_line, selection)
  nulls not distinct;

-- The COALESCE indexes are now redundant duplicates of the above, and a second
-- unique index over the same key is a second write cost and a second thing to
-- keep in step. Dropped AFTER the replacements exist, so uniqueness is never
-- unenforced for an instant.
drop index if exists public.closing_lines_unique;
drop index if exists public.closing_lines_independent_unique;

-- ── 2. Attaching a close to a signal that settled without one ───────────────
--
-- `settle_match_signals()` attaches the close AT SETTLE TIME and there is
-- deliberately no fallback (migration 063). A row that settled while the
-- writer was broken therefore keeps a null CLV for ever, even once the closing
-- line arrives — the settle path will not revisit it.
--
-- This is that second pass, as a FUNCTION rather than a one-off statement,
-- because the recovery is two steps that cannot be run together: the closing
-- lines have to be captured first (`captureClosingLines.js --backfill`) and
-- only then is there anything to attach.
--
-- It only ever FILLS a null. It never revises a CLV already measured, because
-- a settled row is a record — the same rule `/performance` is built on.

create or replace function public.attach_missing_closing_lines()
  returns table (signals_repaired bigint)
  language plpgsql
  security definer
  set search_path to 'public', 'pg_catalog'
as $$
declare
  v_repaired bigint;
begin
  with repaired as (
    update public.value_signals vs
    set closing_odds = cl.closing_odds,
        -- clv        vs the closing PRICE, margin still in it
        -- no_vig_clv vs the Shin-de-vigged FAIR close — the measure
        --            `paper_trade_gate()` opens the publication gate on
        clv          = round(ln(vs.detected_odds / cl.closing_odds), 4),
        no_vig_clv   = round(ln(vs.detected_odds / cl.no_vig_odds), 4)
    from public.closing_lines cl
    where cl.match_id  = vs.match_id
      and cl.market    = coalesce(vs.market, 'h2h')
      and cl.selection = vs.outcome
      and coalesce(cl.market_line, -1) = coalesce(vs.market_line, -1)
      -- CLV is undefined for an in-play signal: the line closed at kickoff, so
      -- a pre-kickoff benchmark is not one.
      and coalesce(vs.phase, 'prematch') <> 'inplay'
      and vs.result in ('win', 'loss')
      and vs.detected_odds > 1
      and vs.no_vig_clv is null          -- fill only; never revise a record
      and cl.closing_odds > 1
      and cl.no_vig_odds  > 1
    returning vs.id
  )
  select count(*) into v_repaired from repaired;

  -- `signal_label` is DERIVED from no_vig_clv by settle_match_signals(), so a
  -- row that just gained one needs the word its number now supports.
  update public.value_signals
  set signal_label = case
        when no_vig_clv is null then null
        when no_vig_clv > 0     then 'Market Steamer'
        when result = 'win'     then 'Sharp Contrarian Edge'
        when result = 'loss'    then 'Market Confirmed'
      end
  where result in ('win', 'loss')
    and no_vig_clv is not null
    and signal_label is null;

  return query select v_repaired;
end;
$$;

revoke all on function public.attach_missing_closing_lines() from public, anon, authenticated;

-- ── 3. Assert the target is inferable before this commits ───────────────────
--
-- The whole point of the migration is that one specific ON CONFLICT clause
-- stops being rejected. Asserting it here means the next reader does not have
-- to trust this header.
do $$
declare v_match_id uuid;
begin
  select id into v_match_id from public.matches where status = 'completed' limit 1;
  if v_match_id is null then
    raise notice '087: no completed fixture to probe against; skipping assertion';
    return;
  end if;

  begin
    insert into public.closing_lines
      (match_id, market, market_line, selection, kickoff_at, quoted_at,
       closing_odds, no_vig_odds, no_vig_prob, overround, basis, book_count)
    select v_match_id, 'h2h', null, '__migration_087_probe__',
           m.kickoff_at, m.kickoff_at - interval '1 minute',
           2.00, 2.10, 0.476, 1.05, 'anchor', 6
    from public.matches m where m.id = v_match_id
    on conflict (match_id, market, market_line, selection) do nothing;
  exception when others then
    raise exception '087 FAILED: the writers'' ON CONFLICT is still not inferable — %', sqlerrm;
  end;

  delete from public.closing_lines where selection = '__migration_087_probe__';
end $$;

commit;
