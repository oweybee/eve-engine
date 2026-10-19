-- 134 — per-player, per-fixture statistics, and the hit-rate read behind them.
--
-- WHY
-- The match card shows team stats only. NumbersGame-style player tables
-- (shots, shots on target, cards, fouls per player over the last N games) need
-- per-player history, which API-Football serves from /fixtures/players on the
-- plan we already pay for. Until 19 Oct 2026 nothing in this repo called it:
-- `lineups` held who played, nothing held what they did.
--
-- WHAT IS HERE
--   player_match_stats      one row per player per fixture (typed columns + raw)
--   player_stats_fetch_log  one row per fixture we have ASKED about, with which
--                           stat families that fixture actually reported
--   player_form(...)        last-N hit rates for the squads of 1..4 teams
--
-- THE NULL PROBLEM, AND WHY THE LOG CARRIES COVERAGE FLAGS
-- API-Football sends shots.total = null for a player who took no shots, so a
-- null inside a covered fixture means ZERO. But in a league the vendor does not
-- cover at player level, every value is null, and reading that as zero would
-- print "0 shots in 10" for a striker who had forty. Same lesson as the cards
-- model's missing "Yellow Cards" entry (backfillMatchStats.coverageOf): absent
-- is not zero. So the fetch script decides per fixture whether each family
-- (shots / cards / fouls) was reported at all, and player_form only counts a
-- game toward a stat's denominator when it was.
--
-- ACCESS
-- Both tables are service-role only. The public read is player_form(), a
-- security-definer function with bounded arguments, granted to anon and
-- authenticated. Hit rates are treated as free shop-window content, like
-- `lineups`; if they move behind the paywall, gate the function, not the tables.

create table if not exists public.player_match_stats (
  fixture_id        text        not null,          -- API-Football fixture id (= matches.external_id)
  player_id         integer     not null,          -- API-Football player id (= lineups starting_xi player.id)
  match_id          uuid,
  league_id         uuid,
  kickoff_at        timestamptz not null,
  team_api_id       integer,
  team_name         text,
  team_side         text check (team_side in ('home','away')),
  player_name       text,
  player_position          text,
  shirt_number      smallint,
  is_sub            boolean,
  captain           boolean,
  minutes           smallint,
  rating            numeric(4,2),
  shots_total       smallint,
  shots_on          smallint,
  goals             smallint,
  assists           smallint,
  goals_conceded    smallint,
  saves             smallint,
  passes_total      smallint,
  passes_key        smallint,
  pass_accuracy     smallint,
  tackles           smallint,
  blocks            smallint,
  interceptions     smallint,
  duels_total       smallint,
  duels_won         smallint,
  dribbles_attempts smallint,
  dribbles_success  smallint,
  fouls_committed   smallint,
  fouls_drawn       smallint,
  yellow            smallint,
  red               smallint,
  offsides          smallint,
  pen_won           smallint,
  pen_committed     smallint,
  pen_scored        smallint,
  pen_missed        smallint,
  pen_saved         smallint,
  raw               jsonb       not null default '{}'::jsonb,
  fetched_at        timestamptz not null default now(),
  primary key (fixture_id, player_id)
);

create index if not exists player_match_stats_player_idx
  on public.player_match_stats (player_id, kickoff_at desc);
create index if not exists player_match_stats_team_idx
  on public.player_match_stats (team_api_id, kickoff_at desc);

alter table public.player_match_stats enable row level security;
revoke all on public.player_match_stats from anon, authenticated;

create table if not exists public.player_stats_fetch_log (
  fixture_id      text        primary key,
  fetched_at      timestamptz not null default now(),
  players         integer     not null default 0,   -- 0 = asked, vendor had nothing
  has_shots       boolean     not null default false,
  has_cards       boolean     not null default false,
  has_fouls       boolean     not null default false,
  oriented_by     text        check (oriented_by in ('team_id','name','order'))
);

alter table public.player_stats_fetch_log enable row level security;
revoke all on public.player_stats_fetch_log from anon, authenticated;

-- player_form — last-N appearances for every player whose MOST RECENT
-- appearance (within 240 days) was for one of the given teams. A player sold
-- in the summer belongs to his new club; his old games still count toward his
-- form, which is how NumbersGame reads it too.
--
-- p_team_api_ids  1..4 API-Football team ids (lineups.team_id / teams.external_id)
-- p_last          1..50 appearances (default 10)
-- p_league_id     null = all competitions; a league uuid = that competition only
create or replace function public.player_form(
  p_team_api_ids integer[],
  p_last         integer default 10,
  p_league_id    uuid    default null
)
returns table (
  player_id         integer,
  player_name       text,
  team_api_id       integer,
  team_name         text,
  player_position          text,
  last_kickoff      timestamptz,
  apps              integer,
  starts            integer,
  minutes           integer,
  goals             integer,
  assists           integer,
  games_scored      integer,
  shot_games        integer,
  shot_minutes      integer,
  shots             integer,
  sot               integer,
  games_1plus_shot  integer,
  games_2plus_shots integer,
  games_1plus_sot   integer,
  games_2plus_sot   integer,
  shots_p90         numeric,
  sot_p90           numeric,
  card_games        integer,
  yellows           integer,
  reds              integer,
  games_carded      integer,
  foul_games        integer,
  foul_minutes      integer,
  fouls_committed   integer,
  fouls_drawn       integer,
  games_1plus_foul  integer,
  games_2plus_fouls integer,
  fouls_p90         numeric
)
language sql
stable
security definer
set search_path = public
as $$
  with args as (
    select greatest(1, least(coalesce(p_last, 10), 50)) as n,
           (p_team_api_ids)[1:4]                         as teams
  ),
  latest as (
    select distinct on (s.player_id)
           s.player_id, s.player_name, s.team_api_id, s.team_name, s.player_position
    from public.player_match_stats s
    where s.minutes > 0
      and s.kickoff_at > now() - interval '240 days'
    order by s.player_id, s.kickoff_at desc
  ),
  squad as (
    select l.* from latest l, args a where l.team_api_id = any(a.teams)
  ),
  apps as (
    select s.*, g.has_shots, g.has_cards, g.has_fouls,
           row_number() over (partition by s.player_id order by s.kickoff_at desc) as rn
    from public.player_match_stats s
    join squad q                         on q.player_id = s.player_id
    join public.player_stats_fetch_log g on g.fixture_id = s.fixture_id
    where s.minutes > 0
      and (p_league_id is null or s.league_id = p_league_id)
  ),
  agg as (
    select a.player_id,
      max(a.kickoff_at)                                                         as last_kickoff,
      count(*)::int                                                             as apps,
      count(*) filter (where not coalesce(a.is_sub, false))::int                as starts,
      sum(a.minutes)::int                                                       as minutes,
      sum(coalesce(a.goals, 0))::int                                            as goals,
      sum(coalesce(a.assists, 0))::int                                          as assists,
      count(*) filter (where a.goals > 0)::int                                  as games_scored,
      count(*) filter (where a.has_shots)::int                                  as shot_games,
      coalesce(sum(a.minutes) filter (where a.has_shots), 0)::int               as shot_minutes,
      coalesce(sum(coalesce(a.shots_total, 0)) filter (where a.has_shots), 0)::int as shots,
      coalesce(sum(coalesce(a.shots_on, 0))    filter (where a.has_shots), 0)::int as sot,
      count(*) filter (where a.has_shots and a.shots_total >= 1)::int           as games_1plus_shot,
      count(*) filter (where a.has_shots and a.shots_total >= 2)::int           as games_2plus_shots,
      count(*) filter (where a.has_shots and a.shots_on >= 1)::int              as games_1plus_sot,
      count(*) filter (where a.has_shots and a.shots_on >= 2)::int              as games_2plus_sot,
      count(*) filter (where a.has_cards)::int                                  as card_games,
      coalesce(sum(coalesce(a.yellow, 0)) filter (where a.has_cards), 0)::int   as yellows,
      coalesce(sum(coalesce(a.red, 0))    filter (where a.has_cards), 0)::int   as reds,
      count(*) filter (where a.has_cards and (a.yellow > 0 or a.red > 0))::int  as games_carded,
      count(*) filter (where a.has_fouls)::int                                  as foul_games,
      coalesce(sum(a.minutes) filter (where a.has_fouls), 0)::int               as foul_minutes,
      coalesce(sum(coalesce(a.fouls_committed, 0)) filter (where a.has_fouls), 0)::int as fouls_committed,
      coalesce(sum(coalesce(a.fouls_drawn, 0))     filter (where a.has_fouls), 0)::int as fouls_drawn,
      count(*) filter (where a.has_fouls and a.fouls_committed >= 1)::int       as games_1plus_foul,
      count(*) filter (where a.has_fouls and a.fouls_committed >= 2)::int       as games_2plus_fouls
    from apps a, args
    where a.rn <= args.n
    group by a.player_id
  )
  select q.player_id, q.player_name, q.team_api_id, q.team_name, q.player_position,
         g.last_kickoff, g.apps, g.starts, g.minutes, g.goals, g.assists, g.games_scored,
         g.shot_games, g.shot_minutes, g.shots, g.sot,
         g.games_1plus_shot, g.games_2plus_shots, g.games_1plus_sot, g.games_2plus_sot,
         round(g.shots * 90.0 / nullif(g.shot_minutes, 0), 2),
         round(g.sot   * 90.0 / nullif(g.shot_minutes, 0), 2),
         g.card_games, g.yellows, g.reds, g.games_carded,
         g.foul_games, g.foul_minutes, g.fouls_committed, g.fouls_drawn,
         g.games_1plus_foul, g.games_2plus_fouls,
         round(g.fouls_committed * 90.0 / nullif(g.foul_minutes, 0), 2)
  from agg g join squad q on q.player_id = g.player_id
  order by q.team_api_id, g.sot desc, g.shots desc, g.minutes desc;
$$;

revoke all on function public.player_form(integer[], integer, uuid) from public;
grant execute on function public.player_form(integer[], integer, uuid) to anon, authenticated, service_role;

comment on function public.player_form(integer[], integer, uuid) is
  'Last-N player hit rates (shots, SOT, cards, fouls) for the current squads of up to 4 API-Football team ids. A game only counts toward a stat when that fixture reported the stat family (player_stats_fetch_log.has_*). See migration 134.';
