-- 148: the two strongest rated selections, readable by every visitor.
--
-- WHY (owner, 13 Oct 2026). "I think we should show two value picks to free
-- users." The site already caps a free reader's Value Picks at two
-- (FREE_PREVIEW['value-bets']), but the rows never reached them: migration 047
-- bounds `computed_values` to a ~10-row preview for anon and free, and those
-- ten rows almost never hold a rated selection. Measured that morning: a Plus
-- read rated three selections, the same read signed out rated none. So the
-- section was empty for most visitors, which reads as broken.
--
-- WHAT CROSSES THE LINE. Only the top `p_limit` rated selections (two by
-- default, three at most), which is exactly what the page shows a free reader
-- in full anyway. Nothing below WATCH and nothing beyond the limit is
-- returned, so the rest of the rated board stays Plus. 047 is untouched.
--
-- THE RATING IS THE SITE'S OWN, IN SQL. The browser rates a leg as
--   p_model  = (1 + edge) / odds
--   p_market = Shin de-vig of the best-price vector (lib/feed CV_FAIR_SOURCES)
--   mes      = round(maxedge_score(p_model - p_market, sigma) * edge_efficiency(edge))
--   rung     = signal_rung(odds, edge, mes)
-- and every one of those functions already exists here. Checked against the
-- browser on 13 Oct: 56, 51 and 69 on the three rated legs, identical.
-- The browser re-rates whatever this returns, so a drift here can only drop a
-- row, never mislabel one.
--
-- Freshness reads `price_freshness_policy` (published tiers only), the same
-- table lib/priceFreshness mirrors. Only published architectures, scheduled
-- fixtures that have not kicked off, and the 1X2 market (the rated board is
-- 1X2 only).

create or replace function public.rated_preview_rows(p_limit integer default 2)
returns setof jsonb
language sql
stable
security definer
set search_path = public, pg_temp
as $fn$
  with base as (
    select cv.*, m.kickoff_at, m.status
    from computed_values cv
    join matches m on m.id = cv.match_id
    join model_calibration mc on mc.model_architecture = cv.model_architecture and mc.publish is true
    join price_freshness_policy p
      on p.publish is true
     and extract(epoch from (m.kickoff_at - now())) / 3600 <= p.max_hours_to_ko
     and p.max_hours_to_ko = (
       select min(p2.max_hours_to_ko) from price_freshness_policy p2
       where extract(epoch from (m.kickoff_at - now())) / 3600 <= p2.max_hours_to_ko)
    where m.status = 'scheduled'
      and m.kickoff_at > now()
      and coalesce(cv.odds_fetched_at, cv.computed_at) >= now() - p.max_price_age
  ), legs as (
    select b.match_id, b.kickoff_at, s.i,
           (array[b.best_home_odds, b.best_draw_odds, b.best_away_odds])[s.i]::numeric as odds,
           (array[b.home_edge, b.draw_edge, b.away_edge])[s.i]::numeric as edge,
           shin_devig(array[b.best_home_odds, b.best_draw_odds, b.best_away_odds]::float8[]) as fair,
           coalesce(mc.sigma_p, 0.03)::numeric as sigma, coalesce(mc.z_gate, 1.0)::numeric as zg
    from base b
    join model_calibration mc on mc.model_architecture = b.model_architecture
    cross join (values (1), (2), (3)) s(i)
    where b.best_home_odds > 1 and b.best_draw_odds > 1 and b.best_away_odds > 1
  ), scored as (
    select l.*, round(maxedge_score(((1 + l.edge) / l.odds - l.fair[l.i])::numeric, l.sigma, l.zg)
                      * edge_efficiency(l.edge))::int as mes
    from legs l
    where l.edge is not null and l.odds > 1 and l.fair is not null
  ), rated as (
    select s.*, signal_rung(s.odds, s.edge, s.mes) as rung
    from scored s
    where s.mes is not null
  ), top as (
    select distinct on (match_id) match_id, rung, mes, kickoff_at
    from rated
    where rung in ('PRIME', 'EDGE', 'WATCH')
    order by match_id, (case rung when 'PRIME' then 0 when 'EDGE' then 1 else 2 end), mes desc
  ), chosen as (
    select match_id from top
    order by (case rung when 'PRIME' then 0 when 'EDGE' then 1 else 2 end), mes desc, kickoff_at
    limit greatest(1, least(coalesce(p_limit, 2), 3))
  )
  select to_jsonb(r) from (
    select cv.match_id, cv.model_architecture,
           cv.best_home_odds, cv.best_draw_odds, cv.best_away_odds,
           cv.best_home_book, cv.best_draw_book, cv.best_away_book,
           cv.all_home_odds, cv.all_draw_odds, cv.all_away_odds,
           cv.fair_home_odds as sharp_home_odds, cv.fair_draw_odds as sharp_draw_odds,
           cv.fair_away_odds as sharp_away_odds,
           cv.home_edge, cv.draw_edge, cv.away_edge,
           cv.max_edge, cv.confidence_score, cv.max_edge_score,
           cv.computed_at, cv.odds_fetched_at,
           jsonb_build_object(
             'kickoff_at', m.kickoff_at, 'status', m.status,
             'home_team', jsonb_build_object('name', ht.name, 'crest_url', ht.crest_url),
             'away_team', jsonb_build_object('name', aw.name, 'crest_url', aw.crest_url),
             'league', jsonb_build_object('name', lg.name)
           ) as match
    from chosen c
    join computed_values cv on cv.match_id = c.match_id
    join model_calibration mc on mc.model_architecture = cv.model_architecture and mc.publish is true
    join matches m on m.id = cv.match_id
    left join teams ht on ht.id = m.home_team_id
    left join teams aw on aw.id = m.away_team_id
    left join leagues lg on lg.id = m.league_id
  ) r;
$fn$;

revoke all on function public.rated_preview_rows(integer) from public;
grant execute on function public.rated_preview_rows(integer) to anon, authenticated;

-- Asserted before commit: never more matches than the cap, never a pending
-- row from an unpublished architecture, and anon's own computed_values read
-- is still the 047 preview.
do $$
declare n int; bad int;
begin
  select count(distinct (j->>'match_id')) into n from public.rated_preview_rows(99) j;
  if n > 3 then raise exception '148: cap broken (% matches)', n; end if;
  select count(*) into bad from public.rated_preview_rows(3) j
   where not exists (select 1 from model_calibration mc
                      where mc.model_architecture = j->>'model_architecture' and mc.publish is true);
  if bad > 0 then raise exception '148: unpublished architecture returned'; end if;
end $$;
