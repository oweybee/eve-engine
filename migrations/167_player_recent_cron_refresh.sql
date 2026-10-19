-- 167 — keep the Players sliders' snapshot fresh with pg_cron (19 Oct 2026).
--
-- 166 had the backfill call refresh_player_recent() over the API. Every API
-- caller inherits the authenticator's 8s statement_timeout, the service key
-- included, and a concurrent refresh of player_recent_apps past ~10k
-- fixtures takes longer than that, so the backfill could never refresh it.
-- pg_cron runs inside the database without that limit, so it owns the
-- refresh now and the API-facing function is a harmless no-op.
--
-- Also applied live on 19 Oct and NOT used by anything: a player_recent table
-- with player_recent_mark / player_recent_rebuild() (an incremental rebuild
-- attempt, too slow per player). Safe to drop together with nothing else.

create or replace function public.refresh_player_recent()
returns void
language sql
security definer
set search_path = public, pg_catalog
as $$ select null::void $$;
comment on function public.refresh_player_recent() is
  'No-op since 19 Oct: pg_cron job player-recent-refresh refreshes player_recent_apps every 15 minutes (the API 8s timeout is too short for it). Kept so the backfill''s calls stay harmless.';

-- THE SETTINGS ARE THE FIX, not decoration. The first scheduled run (19:37
-- UTC) died at pg_cron's own 2-minute statement_timeout: the planner walked
-- the 510MB player_match_stats table by index in player order, a random read
-- per row. A sequential scan and a sort does the same work in ~9s, and the
-- whole concurrent refresh in ~15s.
select cron.schedule('player-recent-refresh', '7,22,37,52 * * * *',
  $$set statement_timeout = '10min'; set enable_indexscan = off; set enable_bitmapscan = off; set work_mem = '64MB'; refresh materialized view concurrently public.player_recent_apps;$$);
