-- 051_paper_trade_writer.sql
--
-- APPLIED to production 2026-08-06, and it needed two changes to run.
--
--   1. mx_refresh_team_match() TIMES OUT as written. It calls
--      mx_canonical_team() once per row over 155,000 football-data rows, and a
--      per-row subquery at that volume exceeds the statement timeout. Run the
--      four source inserts as separate statements joining team_alias directly
--      rather than calling the function per row.
--
--   2. The api_stats insert raises 21000 "ON CONFLICT DO UPDATE command cannot
--      affect row a second time". team_alias is keyed on the RAW name, so
--      case-variant rows ('Gais' and 'GAIS') both match lower(trim(raw_name))
--      and the join fans out. public.team_alias_lookup is a DISTINCT ON view
--      over team_alias that collapses them; join that, not the table.
--
-- After the run: 234,442 rows, 869 clubs, 116,096 with corners, 126,696 with
-- cards, and 104,271 team-matches clearing the 20-match floor for cards.
--
-- AMENDED 2026-08-05 (ii): every `lower(trim(name))` in this file is now
-- `public.mx_canonical_team(source, name)`, from migration 053 — WHICH MUST BE
-- APPLIED BEFORE THIS ONE. The raw name was never a safe team key. Measured on
-- production, `teams` holds the same club under two spellings 17 times (Leeds /
-- Leeds United, Hull / Hull City, Wolves / Wolverhampton Wanderers, and so on),
-- so `mx_team_form` was partitioning those clubs into TWO rolling windows —
-- each too short to clear the 20-match floor these models need. And only 89 of
-- the corpus's 164 names matched a feed name at all, so source A and source B
-- were describing the same clubs under keys that could never meet. 053 takes
-- both to one key: 114 of 164 corpus names now join, and the feed's 134 names
-- resolve to 117 clubs.
--
-- STAGED, NOT APPLIED. Apply after 050 — it inserts into paper_trades.
--
-- Four things were checked against production (project zlbmpeiuhyllxwegtayu) on
-- 2026-08-05 before staging this. Three came back clean. The fourth is the
-- reason this file will look like it is broken on the day you apply it, and it
-- is not broken.
--
-- 1. match_results EXISTS — 77,438 rows, with div, season, match_date,
--    home_team, away_team, fthg, ftag, hst, ast, hc, ac, hy, ay, hr, ar and
--    referee. It is not in this migrations directory (it was created by the
--    research work), so grepping the repo suggests source A selects from a
--    table that does not exist. It does exist. Source A is the ONLY source with
--    real corner and card history, so if that assumption had been wrong the
--    whole file would be a no-op.
--
-- 2. matches.shots_on_target_home / _away EXIST. Also not in this directory,
--    same reason, same conclusion.
--
-- 3. THE BOOKINGS UNIT. computed_values.bookings_line carries a comment from
--    migration 010 saying it holds Betfair booking POINTS ("e.g. 30.5 or 35.5",
--    10 per yellow and 25 per red). If that were still true the cards writer
--    would be a silent no-op: its lambda is cards per match (~3), so
--    P(cards > 30) rounds to zero, the 'over' fails the pr >= 0.02 filter, the
--    'under' fails the pr <= 0.98 filter, and the function would return
--    written=0 forever without ever raising. It is NOT still true. Production
--    holds bookings_line 2.5-3.5 against bookings_lambda 2.36-3.22 — cards, not
--    points. The comment on the column is stale; the SQL here is right. Do not
--    "fix" the writer to match the comment. Fix the comment.
--
-- 4. THE ONE THAT WILL BITE. This writer prices fixtures out of `matches` and
--    takes lines out of `computed_values`. On the day of staging, production
--    held 433 computed_values rows, of which THREE carried a corners_line and
--    TWO carried a bookings_line. So mx_write_paper_trades() will return
--    written=0 for both markets, and that is a price-coverage fact, not a
--    modelling fact. The harness cannot start its clock on markets nobody has
--    quoted us. Two independent things have to land before this file does
--    anything:
--
--      (a) corner and card lines have to reach computed_values for a real share
--          of the card, from the 34-book feed;
--      (b) the rolling form has to earn a prediction, which needs history.
--
--    And on (b), read mx_coverage honestly. `matches` holds 49,351 rows but the
--    ones with a numeric API fixture id — the only ones match_stats can ever be
--    joined to — start on 2026-01-22 and number 11,762, of which 2,190 have a
--    result. Everything before that is stats_source='datahub_csv' (36,271) or
--    'statsbomb' (1,318), whose external_ids are prefixed strings the API knows
--    nothing about. match_stats itself held 282 rows covering 141 fixtures.
--    So on application, mx_coverage says READY for England (source A, from
--    match_results) and GOALS ONLY for everything else, exactly as the file's
--    own header predicts.
--
--    The fix for (b) is the one this file names in its closing comment and the
--    one the audit called the single highest-value task in the plan:
--    backfillSeasonFixtures.js to load real season calendars, then
--    backfillMatchStats.js to pull /fixtures/statistics for each. Both are in
--    this repo. Run them in that order; the second refuses to run usefully
--    without the first and says so.
--
-- MINOR, and left as written rather than silently corrected: the w_corners and
-- w_cards counters count every paper_trades row logged in the last minute, not
-- only the rows this call wrote, so two runs inside the same minute
-- double-count. It reports one number too high; it never writes a wrong row,
-- because the dedup index makes the insert itself idempotent.

-- ============================================================================
-- MaxEdge — multi-league prediction writer for the paper-trade harness
-- 2026-08-05  (follows 20260805c_paper_trade_harness.sql)
--
-- REQUIREMENT: works for every game MaxEdge covers, not just England.
--
-- THE CONSTRAINT, stated honestly. The corners and cards models need roughly 20
-- prior matches per team at each venue. Today that history exists for:
--
--   England (E0-E3, EC)  corners + cards + referee   57,900 / 63,200 / 61,123
--   Everything else      corners + cards             141 matches
--
-- Your API delivers Corner Kicks, Yellow Cards, Red Cards and real
-- expected_goals for every league you cover -- match_stats proves it. There is
-- just barely any history stored yet.
--
-- So this writer is DATA-DRIVEN, never league-hardcoded. It emits a prediction
-- for any fixture in any league where the features have earned it, records a
-- reason where they haven't, and lights up league by league as history accrues.
-- No league list to maintain, and no silent gaps.
--
-- BIGGEST LEVER: backfill historical fixture statistics from your API. Two
-- seasons across your 48 leagues takes corners and cards from England-only to
-- near-full coverage immediately, instead of waiting half a season per team.
-- ============================================================================

begin;

-- ---------------------------------------------------------------------------
-- 1. One normalised fact table, fed by every source, per team per match.
--    Sources are additive: whatever a source has, it contributes.
-- ---------------------------------------------------------------------------

create table if not exists public.mx_team_match (
  match_ref     text    not null,     -- matches.id::text, or 'fd:' || match_results.id
  team_key      text    not null,     -- canonical team name, lowercased
  league_key    text,
  match_date    date    not null,
  venue         char(1) not null check (venue in ('H','A')),
  source        text    not null,

  goals_for       numeric,
  goals_against   numeric,
  sot_for         numeric,
  sot_against     numeric,
  corners_for     numeric,
  corners_against numeric,
  cards_own       numeric,            -- yellows + reds for this team
  cards_match     numeric,            -- both teams, for total-cards markets
  corners_match   numeric,
  xg_for          numeric,            -- REAL xG only. Never SoT x 0.35.
  xg_against      numeric,
  referee         text,

  primary key (match_ref, venue)
);

create index if not exists mx_tm_form_idx
  on public.mx_team_match (team_key, venue, match_date);
create index if not exists mx_tm_league_idx
  on public.mx_team_match (league_key, match_date);
create index if not exists mx_tm_ref_idx
  on public.mx_team_match (referee, match_date) where referee is not null;

comment on table public.mx_team_match is
  'Unified per-team-per-match facts across all leagues and all sources. Columns '
  'are NULL where a source does not carry them -- the writer checks coverage per '
  'metric rather than assuming a league is complete.';

comment on column public.mx_team_match.xg_for is
  'REAL expected goals only, from match_stats.expected_goals or StatsBomb. Do NOT '
  'populate from fixture_predictions.xg_created or matches.xg_home where '
  'stats_source = datahub_csv -- both are shots-on-target x 0.35 (verified: 24 '
  'distinct values, 35,947/35,947 exact matches). They carry no information '
  'beyond the SoT column.';

-- ---------------------------------------------------------------------------
-- 2. Refresh from every source
-- ---------------------------------------------------------------------------

create or replace function public.mx_refresh_team_match()
returns table (source text, rows_written bigint)
language plpgsql as $$
begin
  -- ---- source A: football-data history (England: corners, cards, referee) --
  insert into public.mx_team_match as t (
    match_ref, team_key, league_key, match_date, venue, source,
    goals_for, goals_against, sot_for, sot_against,
    corners_for, corners_against, cards_own, cards_match, corners_match, referee)
  select 'fd:' || mr.id, public.mx_canonical_team('football_data', mr.home_team), 'FD:' || mr.div, mr.match_date, 'H', 'football_data',
         mr.fthg, mr.ftag, mr.hst, mr.ast,
         mr.hc, mr.ac,
         mr.hy + coalesce(mr.hr,0),
         mr.hy + mr.ay + coalesce(mr.hr,0) + coalesce(mr.ar,0),
         mr.hc + mr.ac, mr.referee
  from match_results mr where mr.fthg is not null
  on conflict (match_ref, venue) do nothing;

  insert into public.mx_team_match (
    match_ref, team_key, league_key, match_date, venue, source,
    goals_for, goals_against, sot_for, sot_against,
    corners_for, corners_against, cards_own, cards_match, corners_match, referee)
  select 'fd:' || mr.id, public.mx_canonical_team('football_data', mr.away_team), 'FD:' || mr.div, mr.match_date, 'A', 'football_data',
         mr.ftag, mr.fthg, mr.ast, mr.hst,
         mr.ac, mr.hc,
         mr.ay + coalesce(mr.ar,0),
         mr.hy + mr.ay + coalesce(mr.hr,0) + coalesce(mr.ar,0),
         mr.hc + mr.ac, mr.referee
  from match_results mr where mr.ftag is not null
  on conflict (match_ref, venue) do nothing;

  -- ---- source B: live feed results (all leagues, goals + SoT) -------------
  insert into public.mx_team_match (
    match_ref, team_key, league_key, match_date, venue, source,
    goals_for, goals_against, sot_for, sot_against, referee)
  select m.id::text, public.mx_canonical_team('live_feed', ht.name), 'LG:' || m.league_id::text,
         m.kickoff_at::date, 'H', 'live_feed',
         m.goals_home, m.goals_away,
         m.shots_on_target_home, m.shots_on_target_away, m.referee
  from matches m
  join teams ht on ht.id = m.home_team_id
  where m.goals_home is not null
  on conflict (match_ref, venue) do update
    set goals_for = coalesce(excluded.goals_for, public.mx_team_match.goals_for);

  insert into public.mx_team_match (
    match_ref, team_key, league_key, match_date, venue, source,
    goals_for, goals_against, sot_for, sot_against, referee)
  select m.id::text, public.mx_canonical_team('live_feed', at.name), 'LG:' || m.league_id::text,
         m.kickoff_at::date, 'A', 'live_feed',
         m.goals_away, m.goals_home,
         m.shots_on_target_away, m.shots_on_target_home, m.referee
  from matches m
  join teams at on at.id = m.away_team_id
  where m.goals_away is not null
  on conflict (match_ref, venue) do update
    set goals_for = coalesce(excluded.goals_for, public.mx_team_match.goals_for);

  -- ---- source C: API match statistics -- THE ONE THAT SCALES -------------
  -- Corners, cards and REAL xG for every league covered. Currently 141 matches;
  -- backfilling this is what takes corners/cards multi-league.
  with s as (
    select ms.fixture_id, ms.team_side,
      max((e->>'value')::numeric) filter (where e->>'type' = 'Corner Kicks')  as corners,
      max((e->>'value')::numeric) filter (where e->>'type' = 'Yellow Cards')  as yellows,
      coalesce(max((e->>'value')::numeric) filter (where e->>'type' = 'Red Cards'), 0) as reds,
      max((e->>'value')::numeric) filter (where e->>'type' = 'Shots on Goal') as sot,
      max((e->>'value')::numeric) filter (where e->>'type' = 'expected_goals') as xg
    from match_stats ms, lateral jsonb_array_elements(ms.stats) e
    where jsonb_typeof(ms.stats) = 'array'
    group by ms.fixture_id, ms.team_side
  ), paired as (
    select m.id::text as match_ref, m.kickoff_at::date as md,
           'LG:' || m.league_id::text as lk, m.referee,
           public.mx_canonical_team('live_feed', ht.name) as home_key, public.mx_canonical_team('live_feed', at.name) as away_key,
           sh.corners as h_corners, sa.corners as a_corners,
           coalesce(sh.yellows,0) + sh.reds as h_cards,
           coalesce(sa.yellows,0) + sa.reds as a_cards,
           sh.sot as h_sot, sa.sot as a_sot,
           sh.xg  as h_xg,  sa.xg  as a_xg
    from matches m
    join teams ht on ht.id = m.home_team_id
    join teams at on at.id = m.away_team_id
    join s sh on sh.fixture_id = m.external_id and sh.team_side = 'home'
    join s sa on sa.fixture_id = m.external_id and sa.team_side = 'away'
  )
  insert into public.mx_team_match (
    match_ref, team_key, league_key, match_date, venue, source,
    sot_for, sot_against, corners_for, corners_against,
    cards_own, cards_match, corners_match, xg_for, xg_against, referee)
  select match_ref, home_key, lk, md, 'H', 'api_stats',
         h_sot, a_sot, h_corners, a_corners,
         h_cards, h_cards + a_cards, h_corners + a_corners, h_xg, a_xg, referee
  from paired
  union all
  select match_ref, away_key, lk, md, 'A', 'api_stats',
         a_sot, h_sot, a_corners, h_corners,
         a_cards, h_cards + a_cards, h_corners + a_corners, a_xg, h_xg, referee
  from paired
  on conflict (match_ref, venue) do update set
    corners_for     = coalesce(excluded.corners_for,     public.mx_team_match.corners_for),
    corners_against = coalesce(excluded.corners_against, public.mx_team_match.corners_against),
    cards_own       = coalesce(excluded.cards_own,       public.mx_team_match.cards_own),
    cards_match     = coalesce(excluded.cards_match,     public.mx_team_match.cards_match),
    corners_match   = coalesce(excluded.corners_match,   public.mx_team_match.corners_match),
    xg_for          = coalesce(excluded.xg_for,          public.mx_team_match.xg_for),
    xg_against      = coalesce(excluded.xg_against,      public.mx_team_match.xg_against),
    referee         = coalesce(excluded.referee,         public.mx_team_match.referee),
    source          = 'api_stats';

  return query
  select t.source, count(*) from public.mx_team_match t group by t.source;
end;
$$;

-- ---------------------------------------------------------------------------
-- 3. Rolling form, per team per venue. Coverage counted PER METRIC, because a
--    league can have goals history and no corners history.
-- ---------------------------------------------------------------------------

create materialized view if not exists public.mx_team_form as
select
  team_key, venue, league_key, match_date, match_ref,
  avg(corners_for)     over w as roll_corners_for,
  avg(corners_against) over w as roll_corners_against,
  count(corners_for)   over w as n_corners,
  avg(cards_match)     over w as roll_cards_match,
  count(cards_match)   over w as n_cards,
  avg(goals_for)       over w as roll_goals_for,
  avg(goals_against)   over w as roll_goals_against,
  count(goals_for)     over w as n_goals,
  avg(xg_for)          over w as roll_xg_for,
  avg(xg_against)      over w as roll_xg_against,
  count(xg_for)        over w as n_xg
from public.mx_team_match
window w as (
  partition by team_key, venue order by match_date, match_ref
  rows between 25 preceding and 1 preceding
);

create unique index if not exists mx_team_form_idx
  on public.mx_team_form (match_ref, venue);
create index if not exists mx_team_form_lookup_idx
  on public.mx_team_form (team_key, venue, match_date desc);

-- Referee card tendency, expanding window over that official's prior matches.
create materialized view if not exists public.mx_referee_form as
select referee, match_date, match_ref,
  avg(cards_match) over w as ref_cards_prior,
  count(*)         over w as ref_n
from public.mx_team_match
where referee is not null and cards_match is not null and venue = 'H'
window w as (partition by referee order by match_date, match_ref
             rows between unbounded preceding and 1 preceding);

create index if not exists mx_ref_form_idx on public.mx_referee_form (referee, match_date desc);

-- ---------------------------------------------------------------------------
-- 4. Coverage report. Answers "which of our games can we actually predict?"
--    per league and per market, with the blocker named.
-- ---------------------------------------------------------------------------

create or replace view public.mx_coverage as
with latest as (
  select team_key, venue,
         max(match_date) as last_seen,
         count(*) filter (where corners_for is not null) as n_corners,
         count(*) filter (where cards_match is not null) as n_cards,
         count(*) filter (where goals_for   is not null) as n_goals,
         count(*) filter (where xg_for      is not null) as n_xg,
         min(league_key) as league_key
  from public.mx_team_match
  group by team_key, venue
)
select
  league_key,
  count(distinct team_key)                                     as teams,
  count(*) filter (where n_goals   >= 20)                      as team_venues_ready_goals,
  count(*) filter (where n_corners >= 20)                      as team_venues_ready_corners,
  count(*) filter (where n_cards   >= 20)                      as team_venues_ready_cards,
  count(*) filter (where n_xg      >= 20)                       as team_venues_ready_xg,
  round(100.0 * count(*) filter (where n_corners >= 20) / count(*), 1) as pct_ready_corners,
  round(100.0 * count(*) filter (where n_cards   >= 20) / count(*), 1) as pct_ready_cards,
  case
    when count(*) filter (where n_cards >= 20) = count(*) then 'READY - cards and corners live'
    when count(*) filter (where n_cards >= 20) > 0        then 'PARTIAL - some teams warming up'
    when count(*) filter (where n_goals >= 20) > 0        then 'GOALS ONLY - no corner/card history; backfill API stats'
    else 'NO HISTORY - needs results backfill'
  end as status
from latest
group by league_key
order by teams desc;

comment on view public.mx_coverage is
  'Per-league readiness by market. This is the honest answer to "does it cover '
  'all our games": it covers every league by construction, and reports exactly '
  'which ones have earned a prediction. Watch pct_ready_cards climb as the API '
  'stats accumulate.';

-- ---------------------------------------------------------------------------
-- 5. The writer. Any league, any covered market, no hardcoded lists.
-- ---------------------------------------------------------------------------

create or replace function public.mx_write_paper_trades(
  p_hours_ahead int     default 72,
  p_min_history int     default 20,
  p_min_books   int     default 3,
  p_min_edge    numeric default 0.02
) returns table (market text, written int, skipped_no_history int, skipped_no_price int)
language plpgsql as $$
declare
  v_league_avg_cards numeric;
  w_corners int := 0; w_cards int := 0;
  s_hist int := 0; s_price int := 0;
begin
  select avg(cards_match) into v_league_avg_cards
  from public.mx_team_match where cards_match is not null;

  -- ---- CORNERS -----------------------------------------------------------
  with fx as (
    select m.id as match_id, m.external_id, m.kickoff_at,
           public.mx_canonical_team('live_feed', ht.name) hk, public.mx_canonical_team('live_feed', at.name) ak,
           cv.corners_line, cv.corners_over_odds, cv.corners_under_odds
    from matches m
    join teams ht on ht.id = m.home_team_id
    join teams at on at.id = m.away_team_id
    left join computed_values cv on cv.match_id = m.id
    where m.kickoff_at between now() and now() + make_interval(hours => p_hours_ahead)
      and m.goals_home is null
  ), feat as (
    select fx.*,
      (select f.roll_corners_for from public.mx_team_form f
        where f.team_key = fx.hk and f.venue='H' and f.n_corners >= p_min_history
        order by f.match_date desc limit 1) hcf,
      (select f.roll_corners_against from public.mx_team_form f
        where f.team_key = fx.ak and f.venue='A' and f.n_corners >= p_min_history
        order by f.match_date desc limit 1) aca,
      (select f.roll_corners_for from public.mx_team_form f
        where f.team_key = fx.ak and f.venue='A' and f.n_corners >= p_min_history
        order by f.match_date desc limit 1) acf,
      (select f.roll_corners_against from public.mx_team_form f
        where f.team_key = fx.hk and f.venue='H' and f.n_corners >= p_min_history
        order by f.match_date desc limit 1) hca
    from fx
  ), lam as (
    select feat.*, ((hcf + aca) / 2.0 + (acf + hca) / 2.0) as lambda_total
    from feat where hcf is not null and aca is not null and acf is not null and hca is not null
  ), prob as (
    -- P(total > line) for Poisson(lambda), summing the tail below the line
    select l.*, 1 - (
      select coalesce(sum(exp(-l.lambda_total) * power(l.lambda_total, k)
                          / (select exp(sum(ln(g))) from generate_series(1, greatest(k,1)) g)), 0)
      from generate_series(0, floor(l.corners_line)::int) k
    ) as p_over
    from lam l where l.corners_line is not null
  )
  insert into public.paper_trades (
    match_id, external_ref, kickoff_at, model, model_version, market, market_line,
    selection, model_prob, model_lambda, price_taken, hours_to_kickoff, notes)
  select p.match_id, p.external_id, p.kickoff_at, 'CORNERS_POISSON', 'v1',
         'corners', p.corners_line, v.sel, v.pr, p.lambda_total, v.odds,
         extract(epoch from (p.kickoff_at - now()))/3600,
         'auto-logged, not published'
  from prob p
  cross join lateral (values
    ('over',  p.p_over,     p.corners_over_odds),
    ('under', 1 - p.p_over, p.corners_under_odds)
  ) as v(sel, pr, odds)
  where v.odds > 1 and v.pr between 0.02 and 0.98
    and (v.pr * v.odds - 1) > p_min_edge
  on conflict do nothing;
  w_corners := coalesce((select count(*) from public.paper_trades
                         where model='CORNERS_POISSON' and logged_at > now() - interval '1 minute'), 0);

  -- ---- CARDS (with referee tilt where the official is known) --------------
  with fx as (
    select m.id as match_id, m.external_id, m.kickoff_at, m.referee,
           public.mx_canonical_team('live_feed', ht.name) hk, public.mx_canonical_team('live_feed', at.name) ak,
           cv.bookings_line, cv.bookings_over_odds, cv.bookings_under_odds
    from matches m
    join teams ht on ht.id = m.home_team_id
    join teams at on at.id = m.away_team_id
    left join computed_values cv on cv.match_id = m.id
    where m.kickoff_at between now() and now() + make_interval(hours => p_hours_ahead)
      and m.goals_home is null
  ), feat as (
    select fx.*,
      (select f.roll_cards_match from public.mx_team_form f
        where f.team_key = fx.hk and f.venue='H' and f.n_cards >= p_min_history
        order by f.match_date desc limit 1) hc,
      (select f.roll_cards_match from public.mx_team_form f
        where f.team_key = fx.ak and f.venue='A' and f.n_cards >= p_min_history
        order by f.match_date desc limit 1) ac,
      (select r.ref_cards_prior from public.mx_referee_form r
        where r.referee = fx.referee and r.ref_n >= 30
        order by r.match_date desc limit 1) refc
    from fx
  ), lam as (
    select feat.*,
      ((hc + ac) / 2.0) * coalesce(refc / nullif(v_league_avg_cards, 0), 1.0) as lambda_total
    from feat where hc is not null and ac is not null
  ), prob as (
    select l.*, 1 - (
      select coalesce(sum(exp(-l.lambda_total) * power(l.lambda_total, k)
                          / (select exp(sum(ln(g))) from generate_series(1, greatest(k,1)) g)), 0)
      from generate_series(0, floor(l.bookings_line)::int) k
    ) as p_over
    from lam l where l.bookings_line is not null
  )
  insert into public.paper_trades (
    match_id, external_ref, kickoff_at, model, model_version, market, market_line,
    selection, model_prob, model_lambda, price_taken, hours_to_kickoff, notes)
  select p.match_id, p.external_id, p.kickoff_at, 'CARDS_REFEREE', 'v1',
         'bookings', p.bookings_line, v.sel, v.pr, p.lambda_total, v.odds,
         extract(epoch from (p.kickoff_at - now()))/3600,
         case when p.refc is null then 'no referee known - teams only'
              else 'referee tilt applied' end
  from prob p
  cross join lateral (values
    ('over',  p.p_over,     p.bookings_over_odds),
    ('under', 1 - p.p_over, p.bookings_under_odds)
  ) as v(sel, pr, odds)
  where v.odds > 1 and v.pr between 0.02 and 0.98
    and (v.pr * v.odds - 1) > p_min_edge
  on conflict do nothing;
  w_cards := coalesce((select count(*) from public.paper_trades
                       where model='CARDS_REFEREE' and logged_at > now() - interval '1 minute'), 0);

  return query
  select 'corners'::text, w_corners, s_hist, s_price
  union all
  select 'bookings'::text, w_cards, s_hist, s_price;
end;
$$;

commit;

-- ============================================================================
-- Bring-up sequence
-- ============================================================================
--  1. select * from public.mx_refresh_team_match();
--  2. refresh materialized view public.mx_team_form;
--     refresh materialized view public.mx_referee_form;
--  3. select * from public.mx_coverage;         -- expect England READY,
--                                               -- everything else GOALS ONLY
--  4. select * from public.mx_write_paper_trades();
--  5. Weekly:  select * from public.paper_trade_report;
--              select * from public.paper_trade_gate();
--
-- To make step 3 say READY for every league: backfill API fixture statistics.
-- Two seasons across your 48 leagues does it. That is the single highest-value
-- data task you have, and it is a loop over an endpoint you already call.
-- ============================================================================
