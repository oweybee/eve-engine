-- Backfilled from the Supabase migration ledger (supabase_migrations.schema_migrations)
-- version 20260829204105, name performance_signals_split. Applied directly to production; this file was
-- missing from the repo. Statements copied verbatim from the ledger on 25 Oct 2026.
-- DO NOT re-apply: it is already in the database. Nothing runs this folder.

-- Split the performance signal feed so the settled record can be public.
-- performance_signals          settled only, SECURITY DEFINER  -> public proof
-- performance_signals_pending  pending only, SECURITY INVOKER  -> RLS unchanged
-- security_definer_view WILL be flagged by the advisor. That is the intended,
-- accepted exception: bypassing RLS is the mechanism by which the settled
-- record becomes publicly readable. Do NOT restore security_invoker on the
-- settled view - it silently empties the public record with no error anywhere.
-- No architecture filter, deliberately: refresh_performance_by_band has none
-- either, so filtering here would make the view disagree with the table it is
-- reconciled against.

create or replace view public.performance_signals as
  select
    vs.id,
    vs.detected_at,
    vs.kickoff_at,
    (ht.name || ' v '::text) || at.name                     as fixture,
    ht.name                                                 as home_team,
    at.name                                                 as away_team,
    coalesce(l.name, vs.league_tag)                         as league,
    vs.market,
    vs.market_line,
    vs.outcome,
    vs.detected_odds                                        as advised_odds,
    vs.closing_odds,
    round(vs.detected_edge * 100::numeric, 2)               as edge_pct,
    round(vs.no_vig_clv * 100::numeric, 2)                  as no_vig_clv_pct,
    vs.result,
    vs.bookmaker,
    round(vs.model_prob * 100::numeric, 1)                  as model_prob_pct,
    round(vs.market_prob * 100::numeric, 1)                 as market_prob_pct,
    vs.mxs,
    vs.mxs_band,
    vs.score_withheld_reason,
    vs.model_architecture,
    ( select p.band_key
        from performance_band p
       where p.published = true
         and vs.detected_edge >= p.edge_min and vs.detected_edge < p.edge_max
         and vs.detected_odds >= p.odds_min and vs.detected_odds < p.odds_max
       order by (case p.band_key when 'prime' then 1 when 'edge' then 2 else 3 end)
       limit 1)                                             as band
  from value_signals vs
    join matches m  on m.id  = vs.match_id
    left join teams ht on ht.id = m.home_team_id
    left join teams at on at.id = m.away_team_id
    left join leagues l on l.id = m.league_id
  where coalesce(vs.result, 'pending') <> 'pending';

alter view public.performance_signals set (security_invoker = false);
grant select on public.performance_signals to anon, authenticated;

create or replace view public.performance_signals_pending as
  select
    vs.id,
    vs.detected_at,
    vs.kickoff_at,
    (ht.name || ' v '::text) || at.name                     as fixture,
    ht.name                                                 as home_team,
    at.name                                                 as away_team,
    coalesce(l.name, vs.league_tag)                         as league,
    vs.market,
    vs.market_line,
    vs.outcome,
    vs.detected_odds                                        as advised_odds,
    vs.closing_odds,
    round(vs.detected_edge * 100::numeric, 2)               as edge_pct,
    round(vs.no_vig_clv * 100::numeric, 2)                  as no_vig_clv_pct,
    vs.result,
    vs.bookmaker,
    round(vs.model_prob * 100::numeric, 1)                  as model_prob_pct,
    round(vs.market_prob * 100::numeric, 1)                 as market_prob_pct,
    vs.mxs,
    vs.mxs_band,
    vs.score_withheld_reason,
    vs.model_architecture,
    ( select p.band_key
        from performance_band p
       where p.published = true
         and vs.detected_edge >= p.edge_min and vs.detected_edge < p.edge_max
         and vs.detected_odds >= p.odds_min and vs.detected_odds < p.odds_max
       order by (case p.band_key when 'prime' then 1 when 'edge' then 2 else 3 end)
       limit 1)                                             as band
  from value_signals vs
    join matches m  on m.id  = vs.match_id
    left join teams ht on ht.id = m.home_team_id
    left join teams at on at.id = m.away_team_id
    left join leagues l on l.id = m.league_id
  where coalesce(vs.result, 'pending') = 'pending';

alter view public.performance_signals_pending set (security_invoker = true);
grant select on public.performance_signals_pending to anon, authenticated;
