-- Backfilled from the Supabase migration ledger (supabase_migrations.schema_migrations)
-- version 20261023095810, name live_rung_no_demote_on_better_price. Applied directly to production; this file was
-- missing from the repo. Statements copied verbatim from the ledger on 25 Oct 2026.
-- DO NOT re-apply: it is already in the database. Nothing runs this folder.

-- 23 Oct 2026: the live rung follows the live price, but a PRIME/EDGE whose price got BETTER
-- (live edge above its box, odds still 1.40 to under 3.00) keeps its stored rung instead of being capped at WATCH.
create or replace function public.live_signal_rung(p_rung text, p_odds numeric, p_edge numeric, p_mxs integer)
returns text language sql immutable parallel safe set search_path to 'public','pg_catalog' as $$
  select case
    when p_odds is null or p_edge is null then null
    when p_rung in ('PRIME','EDGE') and p_edge >= 0.05 and p_odds >= 1.40 and p_odds < 3.00 then
      case when p_rung = 'PRIME' or public.signal_rung(p_odds, p_edge, p_mxs) = 'PRIME' then 'PRIME' else 'EDGE' end
    else public.signal_rung(p_odds, p_edge, p_mxs)
  end;
$$;

create or replace view public.v_signal_price_check as
 WITH p AS (
         SELECT v.id, v.match_id, v.market, v.outcome, v.detected_edge, v.detected_odds, v.model_prob, v.mxs, v.kickoff_at, v.rung,
            v.model_architecture, v.market_line,
            COALESCE(price_max_age(EXTRACT(epoch FROM v.kickoff_at - now()) / 3600.0), '00:15:00'::interval) AS max_age
           FROM value_signals v
          WHERE COALESCE(v.result, 'pending'::text) = 'pending'::text AND v.kickoff_at > now() AND COALESCE(v.phase, 'prematch'::text) = 'prematch'::text AND v.model_prob IS NOT NULL
        ), q AS (
         SELECT p.id, p.match_id, p.market, p.outcome, p.detected_edge, p.detected_odds, p.model_prob, p.mxs, p.kickoff_at, p.rung,
            p.model_architecture, p.market_line, p.max_age,
            ( SELECT (ol.bookmaker || '|'::text) || quote_for(p.outcome, ol.home_odds, ol.draw_odds, ol.away_odds)
                   FROM v_all_quotes_latest ol
                  WHERE ol.match_id = p.match_id AND ol.market = COALESCE(p.market, 'h2h'::text) AND NOT ol.market_line IS DISTINCT FROM p.market_line AND (ol.bookmaker = ANY (ARRAY['bet365'::text, 'williamhill'::text, 'betvictor'::text, 'betfair_sb_uk'::text, 'betano'::text])) AND ol.confirmed_at > (now() - p.max_age) AND quote_is_trusted(ol.match_id, ol.bookmaker, ol.market, ol.market_line, ol.price_since, ol.extra, ol.home_odds, ol.away_odds) AND quote_for(p.outcome, ol.home_odds, ol.draw_odds, ol.away_odds) IS NOT NULL
                  ORDER BY (quote_for(p.outcome, ol.home_odds, ol.draw_odds, ol.away_odds)) DESC, ol.bookmaker
                 LIMIT 1) AS best_pair,
                CASE
                    WHEN p.model_architecture ~~ 'MARKET_ANCHORED%'::text THEN ( SELECT
                            CASE
                                WHEN COALESCE(p.market, 'h2h'::text) = 'h2h'::text THEN (shin_devig(ARRAY[pl.home_odds::double precision, pl.draw_odds::double precision, pl.away_odds::double precision]))[
                                CASE p.outcome
                                    WHEN 'home'::text THEN 1
                                    WHEN 'draw'::text THEN 2
                                    WHEN 'away'::text THEN 3
                                    ELSE NULL::integer
                                END]
                                WHEN pl.draw_odds IS NULL THEN (shin_devig(ARRAY[pl.home_odds::double precision, pl.away_odds::double precision]))[
                                CASE
                                    WHEN quote_for(p.outcome, 1::numeric, NULL::numeric, 2::numeric) = 1::numeric THEN 1
                                    ELSE 2
                                END]
                                ELSE NULL::double precision
                            END AS "case"
                       FROM v_all_quotes_latest pl
                      WHERE pl.match_id = p.match_id AND pl.bookmaker = 'pinnacle'::text AND pl.market = COALESCE(p.market, 'h2h'::text) AND NOT pl.market_line IS DISTINCT FROM p.market_line AND pl.confirmed_at > (now() - p.max_age)
                     LIMIT 1)
                    ELSE NULL::double precision
                END AS pin_prob
           FROM p
        ), r AS (
         SELECT q.*, split_part(q.best_pair, '|'::text, 1) AS best_book,
            NULLIF(split_part(q.best_pair, '|'::text, 2), ''::text)::numeric AS best,
            COALESCE(q.pin_prob::numeric, q.model_prob) AS fair_prob
           FROM q
        ), s AS (
         SELECT r.*,
                CASE WHEN r.best IS NULL THEN NULL::numeric ELSE round(r.fair_prob * r.best - 1::numeric, 4) END AS edge
           FROM r
        )
 SELECT id, match_id, market, outcome, detected_edge, detected_odds, model_prob, mxs, kickoff_at, best, edge,
        CASE
            WHEN best IS NULL THEN 'stale'::text
            WHEN edge <= 0::numeric THEN 'edge_gone'::text
            WHEN (rung = ANY (ARRAY['PRIME'::text, 'EDGE'::text])) AND edge < 0.05 THEN 'below_rung'::text
            WHEN best < detected_odds AND edge < (0.5 * COALESCE(detected_edge, 0::numeric)) THEN 'shrunk'::text
            ELSE 'live'::text
        END AS st,
    best_book,
    round(fair_prob, 5) AS fair_prob,
        CASE WHEN best IS NULL THEN NULL::text ELSE public.live_signal_rung(rung, best, edge, mxs) END AS live_rung
   FROM s;
