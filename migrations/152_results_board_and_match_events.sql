-- ─────────────────────────────────────────────────────────────────────────────
-- 152 — the results board, and the goal timeline it needs
--
-- Owner, 16 Oct 2026: a Results page, OPEN to every visitor. Final scores,
-- full-time statistics and how every settled pre-match read landed. The
-- pre-match forecast on a finished game stays Plus-only and is not touched
-- here. An extra API-Football call per finished match was approved so a result
-- can carry its scorers and goal minutes.
--
-- ── WHY A FUNCTION ───────────────────────────────────────────────────────────
--
-- Two of the three sources are tier-gated and must STAY gated for what they
-- gate: `match_stats` (tiered_read_match_stats) is the LIVE in-play feed, and
-- `value_signals` (047 + the restrictive pending gate) is the claim. A settled
-- read is not an offer — settled history is not gated anywhere in this product
-- — and a finished match's statistics are a record. So this is the
-- model_record() / fixture_board() shape: a SECURITY DEFINER aggregate that can
-- only ever return COMPLETED matches and SETTLED reads. Neither table's policy
-- moves, and an in-play or pending row is unreachable through it by
-- construction (asserted below).
--
-- ── WHAT A READ IS ───────────────────────────────────────────────────────────
--
-- Pre-match only, settled (win/loss/void), carrying a score, from an
-- architecture whose model_calibration.publish is true — the same population a
-- reader was shown on the board. One row per selection, the EARLIEST detection,
-- which is the price a reader could first have taken. The rung is NOT computed
-- here: the browser resolves it with rungFor(), the one ladder, so this file
-- cannot become a second copy of it. The score is returned as `mes`.
--
-- ── EVENTS ───────────────────────────────────────────────────────────────────
--
-- `match_events` is written by fetchMatchEvents.js from `/fixtures?ids=` (20
-- fixtures a call, events included). `match_event_fetches` records that a
-- fixture was asked, so a 0-0 with no cards is not asked again for ever.
-- Both are public read (a goal is a fact, like a score) and service-write only.
-- ─────────────────────────────────────────────────────────────────────────────

begin;

create table if not exists public.match_events (
  id           bigint generated always as identity primary key,
  fixture_id   text        not null,              -- matches.external_id
  match_id     uuid        references public.matches(id) on delete cascade,
  seq          int         not null,              -- order within the fixture
  team_side    text        check (team_side in ('home','away')),
  minute       int,
  extra        int,
  type         text        not null,              -- Goal | Card | subst | Var
  detail       text,                               -- Normal Goal, Own Goal, Penalty, Yellow Card…
  player       text,
  assist       text,
  fetched_at   timestamptz not null default now(),
  unique (fixture_id, seq)
);
create index if not exists match_events_match_idx on public.match_events (match_id);

create table if not exists public.match_event_fetches (
  fixture_id   text primary key,
  match_id     uuid references public.matches(id) on delete cascade,
  status_short text,
  n_events     int  not null default 0,
  fetched_at   timestamptz not null default now()
);

alter table public.match_events        enable row level security;
alter table public.match_event_fetches enable row level security;

drop policy if exists public_read_match_events on public.match_events;
create policy public_read_match_events on public.match_events for select using (true);
drop policy if exists public_read_match_event_fetches on public.match_event_fetches;
create policy public_read_match_event_fetches on public.match_event_fetches for select using (true);

revoke all on public.match_events, public.match_event_fetches from anon, authenticated;
grant select on public.match_events, public.match_event_fetches to anon, authenticated;

-- ── one finished match, as the results surface draws it ─────────────────────
create or replace function public.result_payload(p_match uuid)
returns jsonb
language sql
stable
security definer
set search_path = public
as $$
  select jsonb_build_object(
    'id',          m.id,
    'external_id', m.external_id,
    'kickoff_at',  m.kickoff_at,
    'goals_home',  m.goals_home,
    'goals_away',  m.goals_away,
    'league',      jsonb_build_object('id', l.id, 'name', l.name, 'country', l.country, 'logo_url', l.logo_url),
    'home',        jsonb_build_object('id', th.id, 'name', th.name, 'short_name', th.short_name, 'crest_url', th.crest_url),
    'away',        jsonb_build_object('id', ta.id, 'name', ta.name, 'short_name', ta.short_name, 'crest_url', ta.crest_url),
    'stats', (
      select jsonb_object_agg(s.team_side, s.stats)
      from match_stats s
      where s.fixture_id = m.external_id and s.team_side in ('home','away')
    ),
    'reads', coalesce((
      select jsonb_agg(jsonb_build_object(
               'market',        r.market,
               'outcome',       r.outcome,
               'market_line',   r.market_line,
               'detected_odds', r.detected_odds,
               'detected_edge', r.detected_edge,
               'mes',           r.mxs,
               'bookmaker',     r.bookmaker,
               'closing_odds',  r.closing_odds,
               'no_vig_clv',    r.no_vig_clv,
               'result',        r.result,
               'detected_at',   r.detected_at,
               'architecture',  r.model_architecture
             ) order by r.detected_at)
      from (
        select distinct on (v.market, v.outcome, coalesce(v.market_line, -999)) v.*
        from value_signals v
        join model_calibration c on c.model_architecture = v.model_architecture and c.publish is true
        where v.match_id = m.id
          and v.phase = 'prematch'
          and v.result in ('win','loss','void')
          and v.mxs is not null
        order by v.market, v.outcome, coalesce(v.market_line, -999), v.detected_at
      ) r
    ), '[]'::jsonb),
    'events', (
      case when exists (select 1 from match_event_fetches f where f.fixture_id = m.external_id)
      then coalesce((
        select jsonb_agg(jsonb_build_object(
                 'side', e.team_side, 'minute', e.minute, 'extra', e.extra,
                 'type', e.type, 'detail', e.detail, 'player', e.player, 'assist', e.assist
               ) order by e.seq)
        from match_events e
        where e.fixture_id = m.external_id and e.type in ('Goal','Card')
          and coalesce(e.detail,'') <> 'Missed Penalty'
      ), '[]'::jsonb)
      end                                     -- NULL = never asked, [] = asked and none
    )
  )
  from matches m
  left join leagues l  on l.id  = m.league_id
  left join teams   th on th.id = m.home_team_id
  left join teams   ta on ta.id = m.away_team_id
  where m.id = p_match and m.status = 'completed';
$$;

-- ── every finished match in a window, at most three days ────────────────────
create or replace function public.results_board(p_from timestamptz, p_to timestamptz)
returns setof jsonb
language sql
stable
security definer
set search_path = public
as $$
  select public.result_payload(m.id)
  from matches m
  where m.status = 'completed'
    and m.kickoff_at >= p_from
    and m.kickoff_at <  least(p_to, p_from + interval '3 days')
  order by m.kickoff_at, m.id
  limit 600;
$$;

revoke all on function public.result_payload(uuid) from public;
revoke all on function public.results_board(timestamptz, timestamptz) from public;
grant execute on function public.result_payload(uuid) to anon, authenticated;
grant execute on function public.results_board(timestamptz, timestamptz) to anon, authenticated;

-- ── assertions ───────────────────────────────────────────────────────────────
do $$
declare
  bad int;
  n   int;
begin
  -- no read may be pending, in-play, unscored or from an unpublished model
  select count(*) into bad
  from public.results_board(now() - interval '3 days', now()) p,
       jsonb_array_elements(p->'reads') r
  where r->>'result' not in ('win','loss','void') or r->>'mes' is null
     or not exists (select 1 from model_calibration c
                    where c.model_architecture = r->>'architecture' and c.publish);
  if bad > 0 then raise exception '[152] % read(s) outside the settled published set', bad; end if;

  -- a non-completed match must not resolve
  select count(*) into bad
  from matches m where m.status <> 'completed' and m.kickoff_at > now() - interval '1 day'
    and public.result_payload(m.id) is not null;
  if bad > 0 then raise exception '[152] % unfinished match(es) resolved', bad; end if;

  select count(*) into n from public.results_board(now() - interval '3 days', now());
  raise notice '[152] results_board over the last 3 days: % match(es)', n;

  -- the gated tables are unmoved for anon
  set local role anon;
  select count(*) into n from value_signals;
  if n > 50 then raise exception '[152] anon reads % value_signals rows — 047 moved', n; end if;
  reset role;
end $$;

commit;
