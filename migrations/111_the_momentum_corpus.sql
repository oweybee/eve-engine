-- 111 — `inplay_momentum`: the corpus a momentum model would have to be fitted on
--
-- WHY A CORPUS AND NOT A MODEL. The obvious thing to do with possession, shots
-- and xG is to move the goal expectation with them. There is no measurement in
-- this database for what a possession share is worth in goals, and there COULD
-- NOT be one from the data as it stood:
--
--     match_stats           2,276 rows across 1,138 fixtures
--     rows per (fixture, side) with more than one          0
--
-- It is UPSERTED on (fixture_id, team_side), so it holds exactly one
-- overwritten snapshot per fixture. No record of what any match looked like at
-- minute 60 exists anywhere in this database. A momentum model therefore could
-- not be fitted and could not be measured, and anything shipped today would be
-- numbers somebody made up wearing the clothes of evidence — the failure
-- `model_calibration`, the publication gate and `trg_score_needs_measured_sigma`
-- all exist to prevent.
--
-- So the record is accumulated FIRST. `captureInplaySeries.js` appends a row
-- per genuine feed refresh beside the market series it already writes, on the
-- same clock, so a momentum row and a price row can be joined on the minute
-- they share. Once it carries a few weeks, each row can be joined to what
-- happened AFTER it and "does dominance predict the next goal, beyond the
-- scoreline" becomes a measurement. **UNTIL THEN NOTHING HERE MOVES A PRICE.**
--
-- THE ONE MEASURED EXCEPTION IS A SENDING-OFF and it is already live in
-- lib/inplayState.js — x0.6178 / x1.6018 over 10,215 completed matches in
-- `match_results`, which records red cards for finished games and so needed no
-- new corpus. `reds_home`/`reds_away` are here as well because the corpus
-- should record the state the engine actually priced, including the part of it
-- that already counts.
--
-- EVERY COLUMN IS NULLABLE AND A NULL IS "UNKNOWN", NEVER ZERO. Counted over
-- every statistic API-Football has sent us: `expected_goals` is absent on 41%
-- of rows, and those rows average 12.9 shots with 777 of 1,120 carrying shots
-- ON TARGET — so a null xG is a competition that is not tracked, not a side
-- that has had no chances. Defaulting it to 0 would teach a model which leagues
-- report xG. `Number(null)` is 0 and 0 is finite, which is how that coercion
-- gets written; lib/momentum.js guards it explicitly and says so.
--
-- IT IS SERVICE-ROLE ONLY. RLS is on with NO policy and neither `anon` nor
-- `authenticated` holds any privilege, so the browser cannot read it. Nothing
-- in the product renders it and nothing should until it has been measured — an
-- unmeasured forecast one prop away from being drawn beside a price is the
-- state MODEL_SIGMA was in twice. Opening it is a separate, later ruling.
--
-- The table was created out of band on 26 Aug 2026 while the capture was being
-- written; this file is its record and is written to be re-runnable against
-- that database, so the CREATE is IF NOT EXISTS and the assertions below run
-- either way.

begin;

create table if not exists public.inplay_momentum (
  id            bigserial primary key,
  match_id      uuid        not null references public.matches(id) on delete cascade,
  captured_at   timestamptz not null default now(),
  minute        integer,
  goals_home    integer,
  goals_away    integer,
  shots_home    integer, shots_away    integer,
  sot_home      integer, sot_away      integer,
  inside_home   integer, inside_away   integer,
  corners_home  integer, corners_away  integer,
  poss_home     numeric, poss_away     numeric,
  xg_home       numeric, xg_away       numeric,
  saves_home    integer, saves_away    integer,
  reds_home     integer, reds_away     integer
);

-- THE OBSERVATION'S OWN TIMESTAMP, WHICH IS NOT `captured_at`.
--
-- `captured_at` is OUR clock — the tick that wrote the row. `stats_fetched_at`
-- is the feed's, carried up from `match_stats.fetched_at`, and it is what
-- separates a NEW observation from a re-read of one already recorded.
-- fetchLiveStats gates each fixture behind LIVE_STATS_REFRESH_SECONDS (90s)
-- while the loop passes every 60s, so without this the corpus would fill with
-- consecutive identical rows and a fit over it would count one observation
-- twice. The writer skips a match whose stats have not moved; the unique index
-- is the backstop underneath, for two overlapping runs.
--
-- NULLS ARE DISTINCT here, deliberately: a stats row with no `fetched_at` is
-- an observation we cannot date, and refusing every one after the first would
-- lose real ticks to protect against a duplicate we cannot detect anyway.
alter table public.inplay_momentum
  add column if not exists stats_fetched_at timestamptz;

create unique index if not exists inplay_momentum_observation_unique
  on public.inplay_momentum (match_id, stats_fetched_at);

create unique index if not exists inplay_momentum_tick_unique
  on public.inplay_momentum (match_id, captured_at);
create index if not exists inplay_momentum_match_minute
  on public.inplay_momentum (match_id, minute);
create index if not exists inplay_momentum_captured
  on public.inplay_momentum (captured_at desc);

alter table public.inplay_momentum enable row level security;
revoke all on public.inplay_momentum from anon, authenticated;

-- ── probes ────────────────────────────────────────────────────────────────
-- Asserted rather than eyeballed. Probe 1 inserts and then deletes its own row,
-- so this migration leaves no corpus row behind.

do $probe$
declare
  v_match uuid;
  v_id    bigint;
  v_ok    boolean;
begin
  select id into v_match from public.matches limit 1;
  if v_match is null then
    raise notice 'probe skipped: no match rows to key on';
    return;
  end if;

  -- 1. a null statistic stays null — no column may carry a default
  insert into public.inplay_momentum (match_id, captured_at, stats_fetched_at, shots_home)
  values (v_match, now(), now(), 11)
  returning id into v_id;

  select xg_home is null and poss_home is null and corners_home is null
    into v_ok
    from public.inplay_momentum where id = v_id;

  delete from public.inplay_momentum where id = v_id;

  if not v_ok then
    raise exception 'probe 1: an absent statistic was defaulted rather than left null';
  end if;

  raise notice 'probes passed: statistics are nullable and undefaulted';
end $probe$;

-- 2. the browser cannot read it, whatever RLS does
do $$
declare v_priv boolean;
begin
  select bool_or(has_table_privilege(r, 'public.inplay_momentum', 'SELECT'))
    into v_priv
    from unnest(array['anon', 'authenticated']) r;
  if coalesce(v_priv, false) then
    raise exception 'a client role can read inplay_momentum';
  end if;
end $$;

-- 3. the observation key exists — a fit that double-counts a re-read is the
--    whole reason this column was added
do $$
begin
  if not exists (
    select 1 from pg_indexes
     where tablename = 'inplay_momentum'
       and indexname = 'inplay_momentum_observation_unique'
  ) then
    raise exception 'the (match_id, stats_fetched_at) uniqueness was removed';
  end if;
end $$;

commit;
