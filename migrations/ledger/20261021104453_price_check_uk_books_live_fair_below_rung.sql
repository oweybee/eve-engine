-- Backfilled from the Supabase migration ledger (supabase_migrations.schema_migrations)
-- version 20261021104453, name price_check_uk_books_live_fair_below_rung. Applied directly to production; this file was
-- missing from the repo. Statements copied verbatim from the ledger on 25 Oct 2026.
-- DO NOT re-apply: it is already in the database. Nothing runs this folder.

-- 21 Oct 2026: PRIME/EDGE cards showed flag-time prices. Price check now:
--  * best price from UK books only (owner rulings 14 + 16 Oct), not 1xbet/marathonbet/pinnacle
--  * fair re-derived from CURRENT Shin-devigged Pinnacle for MARKET_ANCHORED rows
--    (DIXON_COLES keeps its model_prob), falling back to flag-time model_prob
--  * new status 'below_rung': a PRIME/EDGE whose live edge is under the 5% floor
alter table public.value_signals
  add column if not exists live_best_book text,
  add column if not exists live_fair_prob numeric,
  add column if not exists live_rung text;

create or replace view public.v_signal_price_check as
WITH p AS (
  SELECT v.id, v.match_id, v.market, v.outcome, v.detected_edge, v.detected_odds,
         v.model_prob, v.mxs, v.kickoff_at, v.rung, v.model_architecture, v.market_line,
         COALESCE(price_max_age((EXTRACT(epoch FROM (v.kickoff_at - now())) / 3600.0)), '00:15:00'::interval) AS max_age
    FROM value_signals v
   WHERE COALESCE(v.result, 'pending') = 'pending'
     AND v.kickoff_at > now()
     AND COALESCE(v.phase, 'prematch') = 'prematch'
     AND v.model_prob IS NOT NULL
), q AS (
  SELECT p.*,
    (SELECT ol.bookmaker || '|' || quote_for(p.outcome, ol.home_odds, ol.draw_odds, ol.away_odds)
       FROM v_all_quotes_latest ol
      WHERE ol.match_id = p.match_id
        AND ol.market = COALESCE(p.market, 'h2h')
        AND NOT (ol.market_line IS DISTINCT FROM p.market_line)
        AND ol.bookmaker IN ('bet365','williamhill','betvictor','betfair_sb_uk','betano')
        AND ol.confirmed_at > now() - p.max_age
        AND (ol.extra OR NOT odds_latest_is_frozen(ol.match_id, ol.bookmaker, ol.market, ol.market_line, ol.price_since))
        AND quote_for(p.outcome, ol.home_odds, ol.draw_odds, ol.away_odds) IS NOT NULL
      ORDER BY quote_for(p.outcome, ol.home_odds, ol.draw_odds, ol.away_odds) DESC, ol.bookmaker
      LIMIT 1) AS best_pair,
    CASE WHEN p.model_architecture LIKE 'MARKET_ANCHORED%' THEN (
      SELECT CASE
               WHEN COALESCE(p.market,'h2h') = 'h2h' THEN
                 (shin_devig(ARRAY[pl.home_odds, pl.draw_odds, pl.away_odds]::float8[]))
                   [CASE p.outcome WHEN 'home' THEN 1 WHEN 'draw' THEN 2 WHEN 'away' THEN 3 END]
               WHEN pl.draw_odds IS NULL THEN
                 (shin_devig(ARRAY[pl.home_odds, pl.away_odds]::float8[]))
                   [CASE WHEN quote_for(p.outcome, 1, NULL, 2) = 1 THEN 1 ELSE 2 END]
             END
        FROM v_all_quotes_latest pl
       WHERE pl.match_id = p.match_id
         AND pl.bookmaker = 'pinnacle'
         AND pl.market = COALESCE(p.market, 'h2h')
         AND NOT (pl.market_line IS DISTINCT FROM p.market_line)
         AND pl.confirmed_at > now() - p.max_age
       LIMIT 1)
    END AS pin_prob
  FROM p
), r AS (
  SELECT q.*,
    split_part(best_pair, '|', 1) AS best_book,
    NULLIF(split_part(best_pair, '|', 2), '')::numeric AS best,
    COALESCE(pin_prob::numeric, model_prob) AS fair_prob
  FROM q
), s AS (
  SELECT r.*,
    CASE WHEN best IS NULL THEN NULL ELSE round(fair_prob * best - 1, 4) END AS edge
  FROM r
)
SELECT id, match_id, market, outcome, detected_edge, detected_odds, model_prob, mxs, kickoff_at,
  best, edge,
  CASE
    WHEN best IS NULL THEN 'stale'
    WHEN edge <= 0 THEN 'edge_gone'
    WHEN rung IN ('PRIME','EDGE') AND edge < 0.05 THEN 'below_rung'
    WHEN best < detected_odds AND edge < 0.5 * COALESCE(detected_edge, 0) THEN 'shrunk'
    ELSE 'live'
  END AS st,
  best_book,
  round(fair_prob, 5) AS fair_prob,
  CASE WHEN best IS NULL THEN NULL ELSE signal_rung(best, edge, mxs) END AS live_rung
FROM s;

create or replace function public.revalidate_value_signals()
 returns jsonb
 language plpgsql
 security definer
 set search_path to 'public', 'pg_catalog'
as $function$
declare r jsonb;
begin
  update public.value_signals v
     set price_status = s.st, price_checked_at = now(), live_best_odds = s.best, live_edge = s.edge,
         live_best_book = nullif(s.best_book, ''), live_fair_prob = s.fair_prob, live_rung = s.live_rung,
         last_seen_at = case when s.st = 'live' then now() else v.last_seen_at end
    from public.v_signal_price_check s
   where v.id = s.id;
  select jsonb_object_agg(st, n) into r from (select st, count(*) n from public.v_signal_price_check group by st) x;
  return coalesce(r, '{}'::jsonb);
end $function$;
