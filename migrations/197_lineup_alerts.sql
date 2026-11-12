-- 197: Lineup alerts (Plus only). Applied to production as "196_lineup_alerts" (plus 196b, 196c) before
-- the number was found taken by 196_prime_curve_points; the content is what is live.
--
-- A Plus member picks the teams they follow on the site (settings, Lineup
-- alerts panel). When both confirmed XIs for one of those teams' fixtures land
-- (capture-lineups, every 4 minutes, usually 18 to 30 minutes before kick-off),
-- the lineup-dms edge function DMs them the two lineups through the MaxEdge bot.
--
-- Rules:
--  * Following needs Plus (is_plus_entitled, so a live trial counts). Unfollowing
--    never does, so a lapsed member can still tidy their list.
--  * Plus is checked again at send time: a member whose plan ends stops getting
--    DMs at once, and their saved teams come back with the plan.
--  * One DM per member per fixture, even if they follow both sides.
--  * Only fixtures that are still scheduled and kick off within two hours, with
--    lineups fetched in the last six hours: the internationals backfill writes
--    confirmed lineups for 2023 fixtures, and those must never fire.
--  * A member who blocks DMs (Discord 50007) is marked and skipped for 7 days
--    or until they press "I've turned DMs on", instead of being retried every run.
--  * Clients write nothing directly: every write is an RPC (client_key_writes_nothing).

create table if not exists public.team_follows (
  user_id    uuid not null references auth.users(id) on delete cascade,
  team_id    uuid not null references public.teams(id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (user_id, team_id)
);
create index if not exists team_follows_team_idx on public.team_follows (team_id);
alter table public.team_follows enable row level security;
drop policy if exists team_follows_read_own on public.team_follows;
create policy team_follows_read_own on public.team_follows
  for select to authenticated using (user_id = (select auth.uid()));
revoke insert, update, delete, truncate, references, trigger on public.team_follows from anon, authenticated;

create table if not exists public.lineup_alert_state (
  user_id       uuid primary key references auth.users(id) on delete cascade,
  dm_blocked_at timestamptz,
  last_error    text,
  updated_at    timestamptz not null default now()
);
alter table public.lineup_alert_state enable row level security;
drop policy if exists lineup_alert_state_read_own on public.lineup_alert_state;
create policy lineup_alert_state_read_own on public.lineup_alert_state
  for select to authenticated using (user_id = (select auth.uid()));
revoke insert, update, delete, truncate, references, trigger on public.lineup_alert_state from anon, authenticated;

create table if not exists public.lineup_dm_log (
  fixture_id      text not null,
  user_id         uuid not null references auth.users(id) on delete cascade,
  discord_user_id text,
  status          text not null check (status in ('sent', 'dm_blocked', 'failed')),
  attempts        int  not null default 1,
  error           text,
  message_id      text,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  primary key (fixture_id, user_id)
);
alter table public.lineup_dm_log enable row level security;
revoke all on public.lineup_dm_log from anon, authenticated;

-- The league a team is playing in now: its latest fixture's league.
create or replace function public.team_current_league(p_team uuid)
returns table (league text, country text)
language sql stable security definer set search_path = public, pg_catalog as $$
  select l.name, l.country
  from public.matches m join public.leagues l on l.id = m.league_id
  where (m.home_team_id = p_team or m.away_team_id = p_team)
    and m.kickoff_at < now() + interval '60 days'
  order by m.kickoff_at desc
  limit 1
$$;

-- Picker search. Only clubs and national sides with a fixture in the last
-- 400 days or coming up, so dead rows in `teams` never appear.
create or replace function public.search_followable_teams(p_q text, p_limit int default 12)
returns table (team_id uuid, name text, crest_url text, league text, country text)
language sql stable security definer set search_path = public, pg_catalog as $$
  with q as (select replace(replace(replace(trim(coalesce(p_q, '')), '\', ''), '%', ''), '_', '') as s)
  select t.id, t.name, t.crest_url, cl.league, cl.country
  from public.teams t, q
  cross join lateral public.team_current_league(t.id) cl
  where length(q.s) >= 2
    and t.external_id is not null
    -- Word starts only: "man" finds Man City and Le Mans, not Germany.
    and (t.name ilike q.s || '%' or t.name ilike '% ' || q.s || '%'
         or t.short_name ilike q.s || '%' or t.short_name ilike '% ' || q.s || '%')
    and exists (
      select 1 from public.matches m
      where (m.home_team_id = t.id or m.away_team_id = t.id)
        and m.kickoff_at > now() - interval '400 days')
  order by (t.name ilike q.s || '%') desc, length(t.name), t.name
  limit greatest(1, least(coalesce(p_limit, 12), 25))
$$;

create or replace function public.my_team_follows()
returns table (team_id uuid, name text, crest_url text, league text, country text, created_at timestamptz)
language sql stable security definer set search_path = public, pg_catalog as $$
  select t.id, t.name, t.crest_url, cl.league, cl.country, f.created_at
  from public.team_follows f
  join public.teams t on t.id = f.team_id
  left join lateral public.team_current_league(t.id) cl on true
  where f.user_id = auth.uid()
  order by f.created_at
$$;

create or replace function public.set_team_follow(p_team uuid, p_follow boolean)
returns int
language plpgsql security definer set search_path = public, pg_catalog as $$
declare uid uuid := auth.uid(); n int;
begin
  if uid is null then raise exception 'not_signed_in' using errcode = '28000'; end if;
  if p_follow then
    if not public.is_plus_entitled(uid) then raise exception 'plus_required' using errcode = '42501'; end if;
    if not exists (select 1 from public.teams where id = p_team) then raise exception 'unknown_team' using errcode = '22023'; end if;
    select count(*) into n from public.team_follows where user_id = uid;
    if n >= 30 and not exists (select 1 from public.team_follows where user_id = uid and team_id = p_team) then
      raise exception 'follow_limit' using errcode = '54000';
    end if;
    insert into public.team_follows (user_id, team_id) values (uid, p_team) on conflict do nothing;
  else
    delete from public.team_follows where user_id = uid and team_id = p_team;
  end if;
  select count(*) into n from public.team_follows where user_id = uid;
  return n;
end $$;

create or replace function public.clear_lineup_dm_block()
returns void
language sql security definer set search_path = public, pg_catalog as $$
  delete from public.lineup_alert_state where user_id = auth.uid();
$$;

-- Service only: who to DM right now. One row per member per fixture.
drop function if exists public.lineup_dms_due(int);
create or replace function public.lineup_dms_due(p_limit int default 200)
returns table (
  fixture_id text, match_id uuid, kickoff_at timestamptz, home text, away text, league text,
  home_api_id int, away_api_id int, user_id uuid, discord_user_id text, followed text[]
)
language sql stable security definer set search_path = public, pg_catalog as $$
  with ready as (
    select m.external_id as fixture_id, m.id as match_id, m.kickoff_at, m.home_team_id, m.away_team_id,
           th.name as home, ta.name as away, lg.name as league,
           th.external_id::int as home_api_id, ta.external_id::int as away_api_id
    from public.matches m
    join public.teams th on th.id = m.home_team_id
    join public.teams ta on ta.id = m.away_team_id
    left join public.leagues lg on lg.id = m.league_id
    where m.status = 'scheduled'
      and m.kickoff_at between now() - interval '15 minutes' and now() + interval '2 hours'
      and th.external_id ~ '^[0-9]+$' and ta.external_id ~ '^[0-9]+$'
      and (select count(distinct l.team_id) from public.lineups l
           where l.fixture_id = m.external_id and l.confirmed
             and l.fetched_at > now() - interval '6 hours'
             and l.team_id in (th.external_id::int, ta.external_id::int)
             and jsonb_array_length(coalesce(l.starting_xi, '[]'::jsonb)) >= 10) = 2
  )
  select r.fixture_id, r.match_id, r.kickoff_at, r.home, r.away, r.league, r.home_api_id, r.away_api_id,
         f.user_id, dl.discord_user_id,
         array_agg(case when f.team_id = r.home_team_id then r.home else r.away end order by f.team_id = r.away_team_id)
  from ready r
  join public.team_follows f on f.team_id in (r.home_team_id, r.away_team_id)
  join public.discord_links dl on dl.user_id = f.user_id and dl.discord_user_id is not null
  where public.is_plus_entitled(f.user_id)
    and not exists (select 1 from public.lineup_dm_log g
                    where g.fixture_id = r.fixture_id and g.user_id = f.user_id
                      and (g.status in ('sent', 'dm_blocked') or g.attempts >= 3))
    and not exists (select 1 from public.lineup_alert_state s
                    where s.user_id = f.user_id and s.dm_blocked_at > now() - interval '7 days')
  group by r.fixture_id, r.match_id, r.kickoff_at, r.home, r.away, r.league, r.home_api_id, r.away_api_id, f.user_id, dl.discord_user_id
  order by r.kickoff_at, f.user_id
  limit greatest(1, least(coalesce(p_limit, 200), 1000))
$$;

create or replace function public.record_lineup_dm(
  p_fixture text, p_user uuid, p_discord text, p_status text, p_error text default null, p_message_id text default null)
returns void
language plpgsql security definer set search_path = public, pg_catalog as $$
begin
  insert into public.lineup_dm_log (fixture_id, user_id, discord_user_id, status, error, message_id)
  values (p_fixture, p_user, p_discord, p_status, left(p_error, 500), p_message_id)
  on conflict (fixture_id, user_id) do update
    set status = excluded.status, error = excluded.error, message_id = excluded.message_id,
        attempts = public.lineup_dm_log.attempts + 1, updated_at = now();
  if p_status = 'dm_blocked' then
    insert into public.lineup_alert_state (user_id, dm_blocked_at, last_error)
    values (p_user, now(), left(p_error, 500))
    on conflict (user_id) do update set dm_blocked_at = now(), last_error = excluded.last_error, updated_at = now();
  end if;
end $$;

revoke execute on function public.team_current_league(uuid) from public, anon, authenticated;
revoke execute on function public.lineup_dms_due(int) from public, anon, authenticated;
revoke execute on function public.record_lineup_dm(text, uuid, text, text, text, text) from public, anon, authenticated;
revoke execute on function public.search_followable_teams(text, int) from public, anon;
revoke execute on function public.my_team_follows() from public, anon;
revoke execute on function public.set_team_follow(uuid, boolean) from public, anon;
revoke execute on function public.clear_lineup_dm_block() from public, anon;
grant execute on function public.search_followable_teams(text, int), public.my_team_follows(),
  public.set_team_follow(uuid, boolean), public.clear_lineup_dm_block() to authenticated;
grant execute on function public.team_current_league(uuid), public.lineup_dms_due(int),
  public.record_lineup_dm(text, uuid, text, text, text, text) to service_role;
