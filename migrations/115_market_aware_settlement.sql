-- 115: market-aware settlement.
--
-- RECORD ONLY. Applied directly to production via the Supabase MCP on
-- 16 Oct 2026. Must NOT be re-run. pg_get_functiondef() (and pg_get_viewdef()
-- for the views) in the database is the source of truth; if it disagrees with
-- this file, the database wins.
--
-- Applied as (schema_migrations version, name):
--   20261016164506  market_aware_settlement_115
--
-- Objects:
--   public.grade_selection(market, outcome, line, gh, ga, corners, cards)
--       one grading rule for every market; null means cannot grade yet
--   public.settle_match_signals(uuid)       grades each pending signal by its
--       own market via grade_selection; CLV from closing_lines_valid, else
--       closing_lines_thin for the thinly quoted markets
--   public.settle_pending_signals()         hourly sweep (pg_cron
--       'settle-pending-signals', 46 * * * *); 117d later adds the 3-day void
--       for corners/cards with no stats
--   value_signals_market_check / value_signals_outcome_check   widened to
--       h2h, totals, btts, bookings, corners, dc, dnb, ah and the dc_*, dnb_*,
--       ah_* outcomes
--
-- THE BUG IT FIXED. settle_match_signals used to grade only home/draw/away:
-- every pending non-h2h signal (over/under, BTTS) was written as a LOSS when
-- its match completed, whatever the score. 44 totals/BTTS rows were regraded
-- loss -> win after this landed; the before/after audit is in
-- research.regrade_16oct (44 rows).
--
-- The applied statements are reproduced below for reference only, verbatim
-- from supabase_migrations.schema_migrations, each preceded by its version and
-- name and checked against md5(statements[1]) at the time of recording.

-- 20261016164506 market_aware_settlement_115
-- 115: settlement understands every market, and value_signals accepts the new ones.
-- Until now settle_match_signals graded only home/draw/away: any other pending
-- signal (over/under, BTTS) was written as a LOSS when the match completed.

alter table public.value_signals drop constraint value_signals_market_check;
alter table public.value_signals add constraint value_signals_market_check
  check (market is null or market = any (array['h2h','totals','btts','bookings','corners','dc','dnb','ah']));
alter table public.value_signals drop constraint value_signals_outcome_check;
alter table public.value_signals add constraint value_signals_outcome_check
  check (outcome = any (array['home','draw','away','over','under','btts_yes','btts_no',
                              'dc_1x','dc_12','dc_x2','dnb_home','dnb_away','ah_home','ah_away']));

-- One grading rule for every market. null = cannot grade yet (e.g. no corners stats).
create or replace function public.grade_selection(p_market text, p_outcome text, p_line numeric,
                                                  p_gh int, p_ga int, p_corners int, p_cards int)
returns text language sql immutable
set search_path to 'public', 'pg_catalog'
as $f$
  select case
    when p_gh is null or p_ga is null then null
    when coalesce(p_market, 'h2h') = 'h2h' then
      case when (p_outcome = 'home' and p_gh > p_ga) or (p_outcome = 'away' and p_ga > p_gh)
                or (p_outcome = 'draw' and p_gh = p_ga) then 'win' else 'loss' end
    when p_market = 'totals' then
      case when p_line is null then null
           when p_gh + p_ga = p_line then 'void'
           when (p_outcome = 'over') = (p_gh + p_ga > p_line) then 'win' else 'loss' end
    when p_market = 'btts' then
      case when (p_outcome = 'btts_yes') = (p_gh > 0 and p_ga > 0) then 'win' else 'loss' end
    when p_market = 'dc' then
      case when (p_outcome = 'dc_1x' and p_gh >= p_ga) or (p_outcome = 'dc_12' and p_gh <> p_ga)
                or (p_outcome = 'dc_x2' and p_ga >= p_gh) then 'win' else 'loss' end
    when p_market = 'dnb' then
      case when p_gh = p_ga then 'void'
           when (p_outcome = 'dnb_home') = (p_gh > p_ga) then 'win' else 'loss' end
    when p_market = 'ah' then
      case when p_line is null then null
           when (p_gh - p_ga + p_line) * (case when p_outcome = 'ah_home' then 1 else -1 end) = 0 then 'void'
           when (p_gh - p_ga + p_line) * (case when p_outcome = 'ah_home' then 1 else -1 end) > 0 then 'win' else 'loss' end
    when p_market in ('corners', 'bookings') then
      case when p_line is null then null
           when (case p_market when 'corners' then p_corners else p_cards end) is null then null
           when (case p_market when 'corners' then p_corners else p_cards end) = p_line then 'void'
           when (p_outcome = 'over') = ((case p_market when 'corners' then p_corners else p_cards end) > p_line) then 'win'
           else 'loss' end
  end
$f$;

create or replace function public.settle_match_signals(p_match_id uuid)
returns void language plpgsql security definer
set search_path to 'public', 'pg_catalog'
as $function$
declare
  v_match record;
begin
  select m.status, m.goals_home, m.goals_away, s.corners, s.cards into v_match
  from matches m left join match_extra_stats s on s.match_id = m.id
  where m.id = p_match_id;

  if v_match.status <> 'completed' then
    raise exception 'Match % is not completed (status: %)', p_match_id, v_match.status;
  end if;

  -- Grade every pending signal by its own market (grade_selection). A signal that
  -- cannot be graded yet (corners/cards before the stats arrive) stays pending and
  -- is picked up by settle_pending_signals(). Closing line: closing_lines_valid,
  -- or closing_lines_thin for the thinly quoted markets. Never a fallback beyond
  -- those; in-play signals settle with no CLV.
  update value_signals vs
  set
    result = cl.grade,
    closing_odds = cl.closing_odds,
    clv = case
      when cl.closing_odds > 1 and vs.detected_odds > 1
      then round(ln(vs.detected_odds / cl.closing_odds), 4) end,
    no_vig_clv = case
      when cl.no_vig_odds > 1 and vs.detected_odds > 1
      then round(ln(vs.detected_odds / cl.no_vig_odds), 4) end
  from (
    select vs2.id,
           public.grade_selection(coalesce(vs2.market, 'h2h'), vs2.outcome, vs2.market_line,
                                  v_match.goals_home, v_match.goals_away, v_match.corners, v_match.cards) as grade,
           case when coalesce(vs2.phase, 'prematch') = 'inplay' then null else coalesce(c.closing_odds, t.closing_odds) end as closing_odds,
           case when coalesce(vs2.phase, 'prematch') = 'inplay' then null else coalesce(c.no_vig_odds, t.no_vig_odds) end as no_vig_odds
    from value_signals vs2
    left join lateral (
      select cl2.closing_odds, cl2.no_vig_odds
      from public.closing_lines_valid cl2
      where cl2.match_id  = vs2.match_id
        and cl2.market    = coalesce(vs2.market, 'h2h')
        and cl2.selection = vs2.outcome
        and coalesce(cl2.market_line, -1) = coalesce(vs2.market_line, -1)
      limit 1
    ) c on true
    left join lateral (
      select ct.closing_odds, ct.no_vig_odds
      from public.closing_lines_thin ct
      where ct.match_id = vs2.match_id
        and ct.market = case vs2.market when 'bookings' then 'cards' else vs2.market end
        and ct.selection = vs2.outcome
        and ct.market_line is not distinct from vs2.market_line
        and ct.lead_minutes <= public.closing_line_max_lead_minutes()
      limit 1
    ) t on true
    where vs2.match_id = p_match_id
      and vs2.result = 'pending'
  ) cl
  where vs.id = cl.id and cl.grade is not null;

  update value_signals
  set signal_label = case
    when no_vig_clv is null then null
    when no_vig_clv > 0     then 'Market Steamer'
    when result = 'win'     then 'Sharp Contrarian Edge'
    when result = 'loss'    then 'Market Confirmed'
  end
  where match_id = p_match_id and result in ('win','loss');

  update recommendations r
  set
    settled = true,
    won = case
      when r.selection = 'home_win' and v_match.goals_home > v_match.goals_away then true
      when r.selection = 'away_win' and v_match.goals_away > v_match.goals_home then true
      when r.selection = 'draw'     and v_match.goals_home = v_match.goals_away  then true
      else false
    end,
    clv_pct = case
      when r.recommended_odds is not null and r.pre_kickoff_odds is not null and r.pre_kickoff_odds > 0
      then round(ln(r.recommended_odds / r.pre_kickoff_odds), 4)
      else r.clv_pct
    end
  where r.match_id = p_match_id and r.settled = false;
end;
$function$;

-- Sweeps completed matches that still hold pending prematch signals (late stats,
-- a missed trigger). Hourly.
create or replace function public.settle_pending_signals()
returns integer language plpgsql security definer
set search_path to 'public', 'pg_catalog'
as $f$
declare r record; n int := 0;
begin
  for r in
    select distinct v.match_id from public.value_signals v join public.matches m on m.id = v.match_id
    where v.result = 'pending' and m.status = 'completed' and m.goals_home is not null
      and coalesce(v.phase, 'prematch') = 'prematch'
  loop
    perform public.settle_match_signals(r.match_id);
    n := n + 1;
  end loop;
  return n;
end $f$;
revoke all on function public.settle_pending_signals() from public, anon, authenticated;
select cron.schedule('settle-pending-signals', '46 * * * *', 'select public.settle_pending_signals()');
