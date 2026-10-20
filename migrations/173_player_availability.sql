-- 173: injuries, suspensions and confirmed lineups, per player per match
-- (owner, 20 Oct 2026: "anything we can do to highlight injured players?").
--
-- player_injuries holds API-Football's /injuries list per fixture, written by
-- fetchInjuries.js every three hours and replaced per fixture so a recovered
-- player drops off. It is read only through player_availability().
--
-- player_availability(match ids, player ids) answers, for each pair:
--
--   starting       named in his club's confirmed starting XI
--   bench          named among its substitutes
--   not_in_squad   his club's lineup is confirmed and he is in neither
--   out            no confirmed lineup yet; the club lists him as missing
--   doubt          no confirmed lineup yet; the club lists him as questionable
--
-- THE LINEUP OUTRANKS THE INJURY LIST once it exists: it is the club's own
-- final word, and a "doubt" who starts has answered the question. A pair with
-- none of these returns no row, and the site prints nothing for it. That is
-- NOT a claim he is fit: the list is what clubs announce and varies by league.
--
-- His club for "not_in_squad" is the injury row's team if he is listed, else
-- his current club in player_recent_apps (the hit-rate surfaces' own rule), so
-- a player is never marked missing from a lineup his club did not publish.
--
-- Injury news is public, and the surfaces asking already gate the rows
-- themselves, so the function is open to anon; the table is not.

create table if not exists public.player_injuries (
  fixture_id  integer     not null,
  player_id   integer     not null,
  match_id    uuid,
  team_api_id integer     not null,
  player_name text,
  status      text        not null check (status in ('out', 'doubt')),
  reason      text,
  kickoff_at  timestamptz,
  fetched_at  timestamptz not null default now(),
  primary key (fixture_id, player_id)
);
create index if not exists player_injuries_match on public.player_injuries (match_id, player_id);
create index if not exists player_injuries_kickoff on public.player_injuries (kickoff_at);

alter table public.player_injuries enable row level security;
revoke all on public.player_injuries from public, anon, authenticated;
grant select, insert, update, delete on public.player_injuries to service_role;

create or replace function public.player_availability(p_match_ids uuid[], p_player_ids integer[])
returns table (match_id uuid, player_id integer, status text, reason text)
language sql
stable
security definer
set search_path = public, pg_catalog
as $$
  with pairs as (
    select distinct m_id, p_id
    from unnest(p_match_ids[1:400], p_player_ids[1:400]) as u(m_id, p_id)
    where m_id is not null and p_id is not null
  ),
  fx as (
    select p.m_id, p.p_id, m.external_id as ext
    from pairs p join public.matches m on m.id = p.m_id
  ),
  lu as (
    select l.fixture_id, l.team_id, l.starting_xi, l.substitutes
    from public.lineups l
    where l.confirmed and l.fixture_id in (select ext from fx)
  ),
  judged as (
    select f.m_id, f.p_id,
      i.status as inj_status, i.reason as inj_reason,
      coalesce(i.team_api_id, (
        select r.cur_team from public.player_recent_apps r where r.player_id = f.p_id and r.rn = 1 limit 1
      )) as club,
      exists (select 1 from lu, jsonb_array_elements(coalesce(lu.starting_xi, '[]'::jsonb)) e
              where lu.fixture_id = f.ext and (e->'player'->>'id')::int = f.p_id) as starts,
      exists (select 1 from lu, jsonb_array_elements(coalesce(lu.substitutes, '[]'::jsonb)) e
              where lu.fixture_id = f.ext and (e->'player'->>'id')::int = f.p_id) as benched,
      f.ext
    from fx f
    left join public.player_injuries i on i.fixture_id::text = f.ext and i.player_id = f.p_id
  )
  select j.m_id, j.p_id,
    case
      when j.starts then 'starting'
      when j.benched then 'bench'
      when exists (select 1 from lu where lu.fixture_id = j.ext and lu.team_id = j.club) then 'not_in_squad'
      else j.inj_status
    end,
    case when j.starts or j.benched then null else j.inj_reason end
  from judged j
  where j.starts or j.benched or j.inj_status is not null
     or exists (select 1 from lu where lu.fixture_id = j.ext and lu.team_id = j.club);
$$;

revoke all on function public.player_availability(uuid[], integer[]) from public;
grant execute on function public.player_availability(uuid[], integer[]) to anon, authenticated, service_role;
