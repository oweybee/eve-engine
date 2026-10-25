-- 135 — in-play line value: a study, not a surface
--
-- Owner, 9 Oct 2026: capture CLV for in-play in the background and keep a
-- record to review weekly. NOTHING ON THE LIVE SITE READS ANY OF THIS.
--
-- WHY IN-PLAY NEEDS ITS OWN MEASURE. `value_signals.clv` is null on all 879
-- in-play rows and always has been: `captureClosingLines` compares a detected
-- price with the price at KICK-OFF, and an in-play signal is detected after
-- kick-off, so there is no closing line to compare it with. Yield is the only
-- measure in-play has, and at 871 settled bets it still only reaches t 0.83.
-- CLV needs roughly fifty times fewer observations than yield, which is exactly
-- what the fastest-moving surface on the site should be measured with.
--
-- THE IN-PLAY ANALOGUE OF A CLOSING LINE IS THE NEXT LINE. Did the price we
-- flagged shorten over the following N minutes? `inplay_market_series` already
-- carries the whole curve -- 143,529 rows over 1,461 matches -- so this needs
-- no new capture at all, only the arithmetic nobody had run.
--
-- AND IT MUST BE CONDITIONED ON THE SCORELINE, which is the one way in-play
-- differs from prematch and the reason a raw figure here is worthless. A price
-- drifts as time passes whatever we thought of it, and it moves violently when
-- a goal lands. Measured at the 10-minute horizon before this was written:
--
--     raw, every window         -9.20%   t -6.76
--     windows with NO goal      -0.22%   t -0.26
--     windows WITH a goal      -23.47%   t -7.06
--
-- Read raw, in-play looks catastrophic. Read conditionally, it is neutral
-- against the market when nothing happens and wrong-side when a goal lands.
-- Those are completely different findings and only the second one is true.

create table if not exists public.inplay_line_value (
  as_of             date        not null,
  horizon_mins      integer     not null,
  -- 'no_goal' | 'goal' | 'unknown' | 'all'
  game_state        text        not null,
  architecture      text        not null,
  n                 integer     not null,
  line_value        numeric,     -- mean of detected_odds / later_odds - 1
  line_value_se     numeric,
  line_value_t      numeric,
  settled_n         integer,
  settled_yield     numeric,
  window_days       integer     not null,
  computed_at       timestamptz not null default now(),
  primary key (as_of, horizon_mins, game_state, architecture, window_days)
);

comment on table public.inplay_line_value is
  'Weekly in-play line-value study (migration 135). A STUDY: no product surface '
  'reads this and none should until it says something out of sample. Positive '
  'line_value means the price we flagged shortened over the horizon. ALWAYS '
  'read the game_state split -- the raw figure is dominated by goals.';

-- Each snapshot is one call, and it is idempotent per (as_of, window): a rerun
-- replaces that day's rows rather than doubling them. Dated because the point
-- is the SERIES -- one reading proves nothing, and the question is whether the
-- no-goal cell ever moves away from zero.
create or replace function public.refresh_inplay_line_value(
  p_window_days integer default 90,
  p_as_of       date    default current_date
) returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  inserted integer;
begin
  delete from public.inplay_line_value
   where as_of = p_as_of and window_days = p_window_days;

  with horizons as (select unnest(array[5,10,20,45]) as mins),
  sig as (
    select vs.id, vs.match_id, vs.outcome, coalesce(vs.market,'h2h') as market,
           vs.detected_at, vs.detected_odds, vs.result, vs.model_architecture,
      (select s.goals_home::text||'-'||s.goals_away::text
         from inplay_market_series s
        where s.match_id = vs.match_id and s.captured_at <= vs.detected_at
        order by s.captured_at desc limit 1) as score_at
    from value_signals vs
    where vs.phase is distinct from 'prematch'
      and vs.detected_odds > 1
      and vs.detected_at >= (p_as_of - p_window_days)::timestamptz
      and vs.detected_at <  (p_as_of + 1)::timestamptz
  ),
  paired as (
    select sig.*, h.mins,
      (select s.best_odds from inplay_market_series s
        where s.match_id = sig.match_id and s.selection = sig.outcome
          and coalesce(s.market,'h2h') = sig.market and s.best_odds > 1
          and s.captured_at >= sig.detected_at + make_interval(mins => h.mins)
        order by s.captured_at asc limit 1) as later_odds,
      (select s.goals_home::text||'-'||s.goals_away::text
         from inplay_market_series s
        where s.match_id = sig.match_id
          and s.captured_at >= sig.detected_at + make_interval(mins => h.mins)
        order by s.captured_at asc limit 1) as score_later
    from sig cross join horizons h
  ),
  classed as (
    select model_architecture, mins, result, detected_odds, later_odds,
           detected_odds / later_odds - 1 as lv,
      case when score_at is null or score_later is null then 'unknown'
           when score_at = score_later                  then 'no_goal'
           else                                              'goal' end as state
    from paired where later_odds is not null
  ),
  -- Every row twice: once in its own state cell, once in 'all'. The 'all' cell
  -- is kept ONLY so a reader can see how far the raw number is from the
  -- conditional one, which is the whole lesson of this table.
  doubled as (
    select model_architecture, mins, state, result, detected_odds, lv from classed
    union all
    select model_architecture, mins, 'all', result, detected_odds, lv from classed
  )
  insert into public.inplay_line_value (
    as_of, horizon_mins, game_state, architecture, n,
    line_value, line_value_se, line_value_t,
    settled_n, settled_yield, window_days)
  select
    p_as_of, mins, state, model_architecture, count(*),
    round(avg(lv)::numeric, 6),
    round((stddev_samp(lv)/sqrt(count(*)))::numeric, 6),
    round((avg(lv)/nullif(stddev_samp(lv)/sqrt(count(*)),0))::numeric, 3),
    count(*) filter (where result in ('win','loss')),
    round(avg(case when result='win' then detected_odds-1
                   when result='loss' then -1 end)::numeric, 6),
    p_window_days
  from doubled
  group by mins, state, model_architecture
  -- A cell under 20 is not a reading, and storing one invites it to be quoted.
  having count(*) >= 20;

  get diagnostics inserted = row_count;
  return inserted;
end;
$$;

comment on function public.refresh_inplay_line_value is
  'Appends one dated snapshot of the in-play line-value study. Idempotent per '
  '(as_of, window_days). Cells under n=20 are not stored.';

revoke all on function public.refresh_inplay_line_value(integer, date) from public, anon, authenticated;

-- THE TABLE IS NOT READABLE BY THE SITE. RLS on with no policy at all: the
-- service role still reads it for review, and nothing anon or authenticated
-- can. A study that leaks onto a surface before it has said anything out of
-- sample is how an in-sample artefact becomes a published claim.
alter table public.inplay_line_value enable row level security;

-- Mondays 07:20 UTC, twenty minutes after the band health check so the two
-- never contend. 90-day window, and a 28-day one beside it: the 90 carries the
-- weight and the 28 is what would show a change first.
select cron.schedule(
  'inplay-line-value-weekly', '20 7 * * 1',
  $cron$select public.refresh_inplay_line_value(90), public.refresh_inplay_line_value(28);$cron$
);

-- Applied to production 9 Oct 2026 as cron jobid 7, with the first snapshot
-- backfilled by hand on the same day. The baseline it recorded, 10-minute
-- horizon:
--
--   window  state     n    line value    t      settled yield
--   90d     all      824   -9.20%      -6.76     +0.75%
--   90d     goal     263  -23.47%      -7.06     -3.48%
--   90d     no_goal  422   -0.22%      -0.26     -1.96%
--   28d     no_goal  158   +1.89%      +1.44     -5.67%
--
-- THE CELL TO WATCH IS no_goal. It is the one with the confound removed, and
-- the 28-day reading is the first time it has been positive. One reading is
-- not a finding; the series is the point. Nothing acts on this until the
-- no-goal cell holds above zero across several weeks AND out of sample.
