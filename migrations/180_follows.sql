-- 180 - follows: track a player prop or a match outcome with no odds
--
-- ── WHAT THIS IS FOR ─────────────────────────────────────────────────────────
--
-- Owner, 23 Oct 2026: a "Following" tab beside the bet tracker. A Plus member
-- follows "Saka on target 1+" or "Over 9.5 corners" without a stake or a price,
-- watches it fill during the match, and it settles itself after full time.
-- Plan: claude/following-and-slip-scan build plan (Docs).
--
-- ── WHY NOT `bets` ───────────────────────────────────────────────────────────
--
-- `bets.odds_taken` must be > 1, its market enum has no player, and every KPI
-- in lib/portal/stats.js is a P&L. An oddless row there would have to be taught
-- to every aggregate. A follow is a different object, so it gets its own table.
--
-- ── ONE RULE, IN ONE PLACE ───────────────────────────────────────────────────
--
-- `follow_measure()` is the ONLY place a follow's count is read off the data.
-- The live progress bar (my_follows) and the settlement (settle_follows) both
-- call it, so the number a member watches is the number that settles. A JS
-- copy in the engine would be the MODEL_SIGMA hand-copy again.
--
-- ── ABSENT IS NOT ZERO ───────────────────────────────────────────────────────
--
-- Player stats: `player_stats_fetch_log` says per fixture whether shots, cards
-- and fouls were REPORTED (migration 160). A family that was not reported
-- voids the follow ('not_reported'); it never settles as a miss.
-- Team stats: a `match_stats` type present on neither side is not reported.
-- Present on one side and null on the other reads the null as 0, which is how
-- the vendor writes a zero inside a covered fixture.
--
-- ── WHO MAY WRITE ────────────────────────────────────────────────────────────
--
-- The client write surface stays the four tables CLAUDE.md lists: members get
-- SELECT on their own rows and nothing else. Writes go through
-- create_follow() / delete_follow(), SECURITY DEFINER, which check the seat
-- with tier_for() (Plus only, owner 23 Oct 2026) so the gate cannot be skipped
-- by calling the REST API directly. Settlement is service_role only.
--
-- APPLIED to production 23 Oct 2026 (as four execute_sql batches; the
-- apply_migration call timed out) and verified in a rolled-back transaction
-- against a real settled fixture: player 2+ shots landed on exactly 2, a
-- player who did not appear voided did_not_play, match goals/corners/BTTS and
-- home cards all settled from match_stats and matches.

-- ── table ────────────────────────────────────────────────────────────────────

create table if not exists public.follows (
  id            uuid primary key default gen_random_uuid(),
  user_id       uuid not null references auth.users(id) on delete cascade,
  source        text not null default 'manual' check (source in ('manual','board','scan')),
  match_id      uuid not null references public.matches(id) on delete cascade,
  subject       text not null check (subject in ('player','home','away','match')),
  player_api_id integer,
  player_name   text,
  stat          text not null,
  comparator    text not null check (comparator in ('gte','over','under')),
  line          numeric not null,
  status        text not null default 'open' check (status in ('open','landed','missed','void')),
  progress      numeric,
  void_reason   text check (void_reason in ('not_reported','did_not_play','postponed','abandoned')),
  alert         boolean not null default true,
  alerted_at    timestamptz,
  alert_note    text,
  scan_id       uuid,
  settled_at    timestamptz,
  created_at    timestamptz not null default now(),
  constraint follows_player_shape check ((subject = 'player') = (player_api_id is not null)),
  constraint follows_stat_shape check (
    case subject
      when 'player' then stat in ('shots','shots_on_target','fouls_committed','fouls_drawn','cards','goals','assists')
      when 'match'  then stat in ('goals','corners','cards','btts')
      else               stat in ('goals','corners','cards','shots','shots_on_target')
    end
  ),
  -- gte takes whole numbers (2+ shots); over/under take .5 lines only, so a
  -- push can never happen (the same .5-only rule as the goal lines).
  constraint follows_line_shape check (
    case comparator
      when 'gte' then line >= 1 and line <= 30 and line = trunc(line)
      else            line > 0 and line < 40 and line - trunc(line) = 0.5
    end
  ),
  constraint follows_void_shape check ((status = 'void') = (void_reason is not null))
);

create unique index if not exists follows_one_per_line
  on public.follows (user_id, match_id, subject, coalesce(player_api_id, 0), stat, comparator, line);
create index if not exists follows_user_idx  on public.follows (user_id, created_at desc);
create index if not exists follows_open_idx  on public.follows (match_id) where status = 'open';
create index if not exists follows_alert_idx on public.follows (settled_at) where alert and alerted_at is null and status <> 'open';

comment on table public.follows is
  'Oddless follows of a player prop or match outcome (Following tab). Written only through create_follow()/delete_follow(); settled by settle_follows(). Migration 180.';

alter table public.follows enable row level security;
revoke all on public.follows from anon, authenticated;
grant select on public.follows to authenticated;

create policy follows_read_own on public.follows
  for select to authenticated
  using (user_id = (select auth.uid()));

-- ── the measurement ──────────────────────────────────────────────────────────

-- One team-stat type off match_stats. Returns (value, present) where present
-- means the type carried a non-null value on at least one side.
create or replace function public.follow_team_stat(p_fixture text, p_side text, p_type text,
                                                   out val numeric, out present boolean)
language sql stable security definer set search_path = public, pg_catalog
as $$
  with v as (
    select ms.team_side,
           nullif(regexp_replace(e->>'value', '[^0-9.]', '', 'g'), '')::numeric as n
    from public.match_stats ms
    cross join lateral jsonb_array_elements(coalesce(ms.stats, '[]'::jsonb)) e
    where ms.fixture_id = p_fixture and e->>'type' = p_type
  )
  select coalesce((select sum(n) from v where p_side = 'both' or team_side = p_side), 0),
         exists (select 1 from v where n is not null);
$$;

-- The count for one follow, right now. reported = null means "not known yet"
-- (stats not fetched); false means the family was not reported and the follow
-- will void; played = false means the player did not appear.
create or replace function public.follow_measure(
  p_subject text, p_stat text, p_player integer,
  p_fixture text, p_goals_home integer, p_goals_away integer,
  out val numeric, out reported boolean, out played boolean)
language plpgsql stable security definer set search_path = public, pg_catalog
as $$
declare
  side text := case p_subject when 'home' then 'home' when 'away' then 'away' else 'both' end;
  t record; t2 record; lg record; ps record;
begin
  played := true;
  if p_subject = 'player' then
    select * into lg from public.player_stats_fetch_log where fixture_id = p_fixture;
    if not found then reported := null; val := null; return; end if;
    -- asked, and the vendor had no player data at all: not reported, and we
    -- cannot say whether he played, so this voids as not_reported
    if coalesce(lg.players, 0) = 0 then reported := false; played := null; val := null; return; end if;
    select * into ps from public.player_match_stats where fixture_id = p_fixture and player_id = p_player;
    if not found or coalesce(ps.minutes, 0) <= 0 then
      played := false; reported := true; val := null; return;
    end if;
    case p_stat
      when 'shots'           then reported := lg.has_shots; val := coalesce(ps.shots_total, 0);
      when 'shots_on_target' then reported := lg.has_shots; val := coalesce(ps.shots_on, 0);
      when 'fouls_committed' then reported := lg.has_fouls; val := coalesce(ps.fouls_committed, 0);
      when 'fouls_drawn'     then reported := lg.has_fouls; val := coalesce(ps.fouls_drawn, 0);
      -- the vendor zero-fills cards; has_cards already requires real detail
      when 'cards'           then reported := lg.has_cards; val := coalesce(ps.yellow, 0) + coalesce(ps.red, 0);
      when 'goals'           then reported := true; val := coalesce(ps.goals, 0);
      when 'assists'         then reported := true; val := coalesce(ps.assists, 0);
    end case;
    return;
  end if;

  if p_stat = 'goals' or p_stat = 'btts' then
    if p_goals_home is null or p_goals_away is null then reported := null; val := null; return; end if;
    reported := true;
    val := case
      when p_stat = 'btts'   then case when p_goals_home > 0 and p_goals_away > 0 then 1 else 0 end
      when side = 'home'     then p_goals_home
      when side = 'away'     then p_goals_away
      else p_goals_home + p_goals_away end;
    return;
  end if;

  if not exists (select 1 from public.match_stats where fixture_id = p_fixture) then
    reported := null; val := null; return;
  end if;

  if p_stat = 'cards' then
    select * into t  from public.follow_team_stat(p_fixture, side, 'Yellow Cards');
    select * into t2 from public.follow_team_stat(p_fixture, side, 'Red Cards');
    reported := t.present or t2.present; val := t.val + t2.val;
  else
    select * into t from public.follow_team_stat(p_fixture, side, case p_stat
           when 'corners' then 'Corner Kicks'
           when 'shots' then 'Total Shots'
           when 'shots_on_target' then 'Shots on Goal' end);
    reported := t.present; val := t.val;
  end if;
end;
$$;

create or replace function public.follow_hits(p_val numeric, p_comparator text, p_line numeric)
returns boolean language sql immutable
as $$
  select case p_comparator
    when 'gte'   then p_val >= p_line
    when 'over'  then p_val >  p_line
    when 'under' then p_val <  p_line end;
$$;

revoke all on function public.follow_team_stat(text, text, text) from public, anon, authenticated;
revoke all on function public.follow_measure(text, text, integer, text, integer, integer) from public, anon, authenticated;

-- ── member RPCs ──────────────────────────────────────────────────────────────

create or replace function public.create_follow(
  p_match_id uuid, p_subject text, p_stat text, p_comparator text, p_line numeric,
  p_player_api_id integer default null, p_player_name text default null,
  p_source text default 'manual', p_alert boolean default true, p_scan_id uuid default null)
returns public.follows
language plpgsql volatile security definer set search_path = public, pg_catalog
as $$
declare
  uid uuid := auth.uid();
  m   record;
  r   public.follows;
begin
  if uid is null then raise exception 'not authenticated' using errcode = '42501'; end if;
  if public.tier_for(uid) = 'free' then
    raise exception 'following is a Plus feature' using errcode = '42501';
  end if;
  select id, kickoff_at, status into m from public.matches where id = p_match_id;
  if not found then raise exception 'unknown match' using errcode = '22023'; end if;
  if m.kickoff_at <= now() or m.status not in ('scheduled') then
    raise exception 'this match has kicked off' using errcode = '22023';
  end if;
  if (select count(*) from public.follows where user_id = uid and status = 'open') >= 200 then
    raise exception 'too many open follows' using errcode = '54000';
  end if;

  insert into public.follows (user_id, source, match_id, subject, player_api_id, player_name,
                              stat, comparator, line, alert, scan_id)
  values (uid, coalesce(p_source, 'manual'), p_match_id, p_subject, p_player_api_id,
          left(p_player_name, 80), p_stat, p_comparator, p_line, coalesce(p_alert, true), p_scan_id)
  on conflict do nothing
  returning * into r;

  if r.id is null then
    select * into r from public.follows f
    where f.user_id = uid and f.match_id = p_match_id and f.subject = p_subject
      and coalesce(f.player_api_id, 0) = coalesce(p_player_api_id, 0)
      and f.stat = p_stat and f.comparator = p_comparator and f.line = p_line;
  end if;
  return r;
end;
$$;

create or replace function public.delete_follow(p_id uuid)
returns boolean
language sql volatile security definer set search_path = public, pg_catalog
as $$
  with d as (delete from public.follows where id = p_id and user_id = auth.uid() returning 1)
  select exists (select 1 from d);
$$;

create or replace function public.set_follow_alert(p_id uuid, p_alert boolean)
returns boolean
language sql volatile security definer set search_path = public, pg_catalog
as $$
  with u as (update public.follows set alert = coalesce(p_alert, true)
             where id = p_id and user_id = auth.uid() and status = 'open' returning 1)
  select exists (select 1 from u);
$$;

-- Every follow the member holds in the window, with the match it sits on and
-- its count right now. Read access to a lapsed member's own history is kept;
-- only CREATING is Plus.
create or replace function public.my_follows(p_days integer default 60)
returns table (
  id uuid, source text, match_id uuid, subject text, player_api_id integer, player_name text,
  stat text, comparator text, line numeric, status text, progress numeric, void_reason text,
  alert boolean, settled_at timestamptz, created_at timestamptz,
  kickoff_at timestamptz, match_status text, minute smallint,
  goals_home smallint, goals_away smallint,
  home_name text, away_name text, home_crest text, away_crest text,
  league_name text, league_country text, reported boolean, played boolean)
language sql stable security definer set search_path = public, pg_catalog
as $$
  select f.id, f.source, f.match_id, f.subject, f.player_api_id, f.player_name,
         f.stat, f.comparator, f.line, f.status,
         case when f.status = 'open' then coalesce(fm.val, f.progress) else f.progress end,
         f.void_reason, f.alert, f.settled_at, f.created_at,
         m.kickoff_at, m.status, m.minute, m.goals_home, m.goals_away,
         th.name, ta.name, th.crest_url, ta.crest_url, l.name, l.country,
         fm.reported, fm.played
  from public.follows f
  join public.matches m on m.id = f.match_id
  left join public.teams th on th.id = m.home_team_id
  left join public.teams ta on ta.id = m.away_team_id
  left join public.leagues l on l.id = m.league_id
  left join lateral (
    select * from public.follow_measure(f.subject, f.stat, f.player_api_id, m.external_id,
                                        m.goals_home, m.goals_away)
    where f.status = 'open' and m.kickoff_at <= now()
  ) fm on true
  where f.user_id = auth.uid()
    and f.created_at > now() - make_interval(days => greatest(1, least(coalesce(p_days, 60), 400)))
  order by m.kickoff_at desc, f.created_at desc;
$$;

revoke all on function public.create_follow(uuid, text, text, text, numeric, integer, text, text, boolean, uuid) from public, anon;
revoke all on function public.delete_follow(uuid) from public, anon;
revoke all on function public.set_follow_alert(uuid, boolean) from public, anon;
revoke all on function public.my_follows(integer) from public, anon;
grant execute on function public.create_follow(uuid, text, text, text, numeric, integer, text, text, boolean, uuid) to authenticated;
grant execute on function public.delete_follow(uuid) to authenticated;
grant execute on function public.set_follow_alert(uuid, boolean) to authenticated;
grant execute on function public.my_follows(integer) to authenticated;

-- ── settlement (service role) ────────────────────────────────────────────────
--
-- Order of the checks is the plan's void table:
--   not completed 48h after kickoff         -> void postponed
--   player follow, player did not appear    -> void did_not_play
--   stat family not reported                -> void not_reported
--   stats still missing 36h after kickoff   -> void not_reported
--   otherwise                               -> landed / missed
-- Stats not fetched yet and inside 36h: left open, the next run tries again.
create or replace function public.settle_follows()
returns table (settled integer, voided integer, waiting integer)
language plpgsql volatile security definer set search_path = public, pg_catalog
as $$
declare
  f record; mm record;
  n_settled integer := 0; n_void integer := 0; n_wait integer := 0;
  v_status text; v_reason text; v_val numeric;
begin
  for f in
    select fo.*, m.external_id, m.status as m_status, m.kickoff_at, m.goals_home, m.goals_away
    from public.follows fo join public.matches m on m.id = fo.match_id
    where fo.status = 'open' and m.kickoff_at < now()
    for update of fo skip locked
  loop
    v_status := null; v_reason := null; v_val := null;
    if f.m_status <> 'completed' or f.goals_home is null then
      if f.kickoff_at < now() - interval '48 hours' then v_status := 'void'; v_reason := 'postponed';
      else n_wait := n_wait + 1; continue; end if;
    else
      select * into mm from public.follow_measure(f.subject, f.stat, f.player_api_id, f.external_id,
                                                  f.goals_home, f.goals_away);
      if mm.played is false then v_status := 'void'; v_reason := 'did_not_play';
      elsif mm.reported is false then v_status := 'void'; v_reason := 'not_reported';
      elsif mm.reported is null then
        if f.kickoff_at < now() - interval '36 hours' then v_status := 'void'; v_reason := 'not_reported';
        else n_wait := n_wait + 1; continue; end if;
      else
        v_val := mm.val;
        v_status := case when public.follow_hits(mm.val, f.comparator, f.line) then 'landed' else 'missed' end;
      end if;
    end if;

    update public.follows
       set status = v_status, void_reason = v_reason, settled_at = now(),
           progress = coalesce(v_val, progress)
     where id = f.id;
    if v_status = 'void' then n_void := n_void + 1; else n_settled := n_settled + 1; end if;
  end loop;
  return query select n_settled, n_void, n_wait;
end;
$$;

-- Fixtures that need /fixtures/players fetched now so player follows can settle:
-- completed, a player follow open on them, no fetch-log row yet.
create or replace view public.follow_fixtures_to_fetch
with (security_invoker = true) as
select distinct m.id as match_id, m.external_id, m.league_id, m.kickoff_at,
       m.home_team_id, m.away_team_id
from public.follows f
join public.matches m on m.id = f.match_id
left join public.player_stats_fetch_log g on g.fixture_id = m.external_id
where f.status = 'open' and f.subject = 'player'
  and m.status = 'completed' and g.fixture_id is null
  and m.external_id ~ '^[0-9]+$';

-- Landed follows still owed a Discord DM, with the member's link. Plus only:
-- a lapsed member's follows settle but are not messaged.
create or replace view public.follow_alerts_due
with (security_invoker = true) as
select f.id, f.user_id, f.subject, f.player_name, f.stat, f.comparator, f.line, f.progress,
       f.match_id, th.name as home_name, ta.name as away_name, d.discord_user_id
from public.follows f
join public.matches m on m.id = f.match_id
left join public.teams th on th.id = m.home_team_id
left join public.teams ta on ta.id = m.away_team_id
join public.discord_links d on d.user_id = f.user_id
where f.status = 'landed' and f.alert and f.alerted_at is null
  and f.settled_at > now() - interval '24 hours'
  and public.tier_for(f.user_id) <> 'free';

revoke all on function public.settle_follows() from public, anon, authenticated;
grant execute on function public.settle_follows() to service_role;
revoke all on public.follow_fixtures_to_fetch from anon, authenticated;
revoke all on public.follow_alerts_due from anon, authenticated;
grant select on public.follow_fixtures_to_fetch to service_role;
grant select on public.follow_alerts_due to service_role;

-- ── the export carries follows too (UK GDPR access request) ──────────────────
create or replace function public.export_my_data()
returns json
language sql stable security definer set search_path to 'public', 'pg_catalog'
as $function$
  select json_build_object(
    'account',      (select row_to_json(p) from public.profiles p where p.id = auth.uid()),
    'preferences',  (select row_to_json(pr) from public.preferences pr where pr.user_id = auth.uid()),
    'bets',         (select coalesce(json_agg(b order by b.created_at), '[]'::json)
                       from public.bets b where b.user_id = auth.uid()),
    'follows',      (select coalesce(json_agg(fo order by fo.created_at), '[]'::json)
                       from public.follows fo where fo.user_id = auth.uid()),
    'bankroll_transactions', (select coalesce(json_agg(t order by t.occurred_at), '[]'::json)
                       from public.bankroll_transactions t where t.user_id = auth.uid()),
    'bookmakers',   (select coalesce(json_agg(ub), '[]'::json)
                       from public.user_bookmakers ub where ub.user_id = auth.uid()),
    'subscription', (select row_to_json(s) from public.subscriptions s where s.user_id = auth.uid()),
    'discord',      (select row_to_json(d) from public.discord_links d where d.user_id = auth.uid()),
    'exported_at',  now()
  )
  where auth.uid() is not null;
$function$;
