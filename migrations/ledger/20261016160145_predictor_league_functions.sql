-- Backfilled from the Supabase migration ledger (supabase_migrations.schema_migrations)
-- version 20261016160145, name predictor_league_functions. Applied directly to production; this file was
-- missing from the repo. Statements copied verbatim from the ledger on 25 Oct 2026.
-- DO NOT re-apply: it is already in the database. Nothing runs this folder.

create or replace function public.predictor_entry_lock() returns trigger language plpgsql as $$
begin
  if (select kickoff_at from public.matches where id = new.match_id) <= now() then
    raise exception 'predictor: match % has kicked off', new.match_id using errcode = 'P0001';
  end if;
  new.updated_at := now(); return new;
end $$;
create trigger predictor_entry_lock before insert or update on public.predictor_entries
  for each row execute function public.predictor_entry_lock();

create or replace view public.predictor_scored with (security_invoker = true) as
select e.round_id, e.match_id, e.discord_user_id, e.discord_name, e.home, e.away, m.goals_home, m.goals_away,
  (m.status = 'completed' and m.goals_home is not null) as settled,
  case when not (m.status = 'completed' and m.goals_home is not null) then null
       when e.home = m.goals_home and e.away = m.goals_away then 3
       when sign(e.home - e.away) = sign(m.goals_home - m.goals_away) then 1 else 0 end as points
from public.predictor_entries e join public.matches m on m.id = e.match_id;

create or replace function public.predictor_leaderboard(p_round int default null)
returns table (discord_user_id text, discord_name text, points int, exact int, results int, picks int, rank int)
language sql stable security definer set search_path = public as $$
  with s as (
    select discord_user_id, (array_agg(discord_name order by round_id desc))[1] as discord_name,
      coalesce(sum(points),0)::int as points, count(*) filter (where points = 3)::int as exact,
      count(*) filter (where points >= 1)::int as results, count(*)::int as picks
    from public.predictor_scored where p_round is null or round_id = p_round group by discord_user_id)
  select s.*, (rank() over (order by points desc, exact desc))::int from s order by 7, 2;
$$;

create or replace function public.predictor_open_round() returns int
language plpgsql security definer set search_path = public as $$
declare v_league uuid; v_first timestamptz; v_round int; v_n int;
begin
  if exists (select 1 from predictor_rounds where status = 'open') then return null; end if;
  select id into v_league from leagues where name = 'Premier League' and country = 'England' limit 1;
  if v_league is null then return null; end if;
  select min(m.kickoff_at) into v_first from matches m
  where m.league_id = v_league and m.status = 'scheduled'
    and m.kickoff_at > now() + interval '1 hour' and m.kickoff_at < now() + interval '6 days'
    and not exists (select 1 from predictor_fixtures f where f.match_id = m.id);
  if v_first is null then return null; end if;
  select count(*) into v_n from matches m
  where m.league_id = v_league and m.status = 'scheduled'
    and m.kickoff_at >= v_first and m.kickoff_at < v_first + interval '4 days'
    and not exists (select 1 from predictor_fixtures f where f.match_id = m.id);
  if v_n < 3 then return null; end if;
  insert into predictor_rounds (label, league_id, first_kickoff, last_kickoff)
  values ('Round ' || ((select count(*) from predictor_rounds) + 1), v_league, v_first, v_first)
  returning id into v_round;
  insert into predictor_fixtures (round_id, match_id, slot)
  select v_round, x.id, row_number() over (order by x.kickoff_at, x.id)
  from (select m.id, m.kickoff_at from matches m
        where m.league_id = v_league and m.status = 'scheduled'
          and m.kickoff_at >= v_first and m.kickoff_at < v_first + interval '4 days'
          and not exists (select 1 from predictor_fixtures f where f.match_id = m.id)
        order by m.kickoff_at, m.id limit 10) x;
  update predictor_rounds r set last_kickoff = (select max(m.kickoff_at) from predictor_fixtures f
    join matches m on m.id = f.match_id where f.round_id = v_round) where r.id = v_round;
  return v_round;
end $$;

create or replace function public.predictor_round_fixtures(p_round int)
returns table (slot int, match_id uuid, home text, away text, kickoff_at timestamptz, locked boolean,
               status text, goals_home int, goals_away int)
language sql stable security definer set search_path = public as $$
  select f.slot::int, m.id, h.name, a.name, m.kickoff_at, m.kickoff_at <= now(),
         m.status, m.goals_home::int, m.goals_away::int
  from predictor_fixtures f join matches m on m.id = f.match_id
  join teams h on h.id = m.home_team_id join teams a on a.id = m.away_team_id
  where f.round_id = p_round order by f.slot;
$$;
