-- 182: disk IO relief, 23-24 Oct 2026. ALREADY APPLIED to production (via the
-- Supabase MCP, migrations snapshot_existence_rpc + player_recent_refresh_gate
-- and two direct statements). Recorded here so the repo matches the database.
-- Nothing here changes what any page reads.

-- 1. captureSnapshot.js existence check, answered in the database.
--    It used to page every odds_snapshots row in a 7-day window (~1.56M per
--    run, ORDER BY id OFFSET) to learn which matches had any snapshot.
create or replace function public.snapshot_match_ids(p_match_ids uuid[], p_since timestamptz)
returns setof uuid language sql stable security invoker
set search_path = public, pg_temp
as $$
  select m from unnest(p_match_ids) as m
  where exists (select 1 from public.odds_snapshots s
                where s.match_id = m and s.captured_at >= p_since);
$$;
revoke all on function public.snapshot_match_ids(uuid[], timestamptz) from public, anon, authenticated;
grant execute on function public.snapshot_match_ids(uuid[], timestamptz) to service_role;

-- 2. player_recent_apps: refresh only when player_match_stats has been
--    written (or once a day for the rolling window). Was every 15 min, 13s,
--    full scan of a 517MB table, ~96x a day for a source written ~1x a day.
create table if not exists public.mv_refresh_mark (
  name text primary key, src_writes bigint, refreshed_at timestamptz);
alter table public.mv_refresh_mark enable row level security;
revoke all on public.mv_refresh_mark from anon, authenticated;

create or replace function public.refresh_player_recent_apps_if_changed()
returns text language plpgsql
set search_path = public, pg_temp
set statement_timeout = '10min' set enable_indexscan = off
set enable_bitmapscan = off set work_mem = '64MB'
as $$
declare w bigint; m public.mv_refresh_mark;
begin
  select n_tup_ins + n_tup_upd + n_tup_del into w
  from pg_stat_user_tables where relid = 'public.player_match_stats'::regclass;
  select * into m from public.mv_refresh_mark where name = 'player_recent_apps';
  if m.name is not null and m.src_writes is not distinct from w
     and m.refreshed_at > now() - interval '24 hours' then
    return 'skipped';
  end if;
  refresh materialized view concurrently public.player_recent_apps;
  insert into public.mv_refresh_mark(name, src_writes, refreshed_at)
  values ('player_recent_apps', w, now())
  on conflict (name) do update set src_writes = excluded.src_writes, refreshed_at = excluded.refreshed_at;
  return 'refreshed';
end $$;
revoke all on function public.refresh_player_recent_apps_if_changed() from public, anon, authenticated;
select cron.alter_job((select jobid from cron.job where jobname = 'player-recent-refresh'),
  command := 'select public.refresh_player_recent_apps_if_changed();');

-- 3. Signed-in board read ordered computed_values by computed_at with no
--    index: a full sort of wide rows per request, spilling to disk.
create index if not exists computed_values_computed_at_desc on public.computed_values (computed_at desc);

-- 4. cron run log kept to 7 days.
select cron.schedule('purge-cron-log', '41 3 * * *',
  $c$delete from cron.job_run_details where start_time < now() - interval '7 days'$c$);

-- 5. Advisor fixes with no change in behaviour.
alter policy discord_links_read_own on public.discord_links using (user_id = (select auth.uid()));
alter function public.follow_hits(numeric,text,numeric) set search_path = public, extensions, pg_temp;
alter function public.player_stat_line(text) set search_path = public, extensions, pg_temp;
alter function public.player_stat_value(text,boolean,boolean,boolean,boolean,smallint,smallint,smallint,smallint,smallint,smallint,smallint,smallint,smallint,smallint,smallint,smallint) set search_path = public, extensions, pg_temp;
-- leagues and matches are both readable by everyone, so invoker rights return the same rows.
alter view public.v_league_hit_rates set (security_invoker = true);
