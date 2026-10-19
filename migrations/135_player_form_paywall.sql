-- 135 — player hit rates are a paid feature (owner ruling, 19 Oct 2026).
--
-- 134 granted player_form() to anon as free shop-window content. Owen ruled
-- the other way the same day: hit rates are paywalled. The rule is the one
-- match_stats already uses (tiered_read_match_stats): paid tiers see any team;
-- free and signed-out users see only the teams in the free preview fixture(s),
-- so the preview card still shows the full product.
--
-- A refusal RAISES 42501 (PostgREST answers 403) instead of returning no rows,
-- because "locked" and "no data yet" must look different to the frontend: one
-- draws the upgrade prompt, the other draws nothing.
--
-- The body moves to player_form_unchecked (service_role only, for the engine
-- and the social/content scripts); player_form is the gated public door.
-- Verified 19 Oct 2026: anon on a non-preview team -> 42501; anon on a preview
-- fixture's teams -> allowed; an 'edge' subscriber -> rows.

alter function public.player_form(integer[], integer, uuid) rename to player_form_unchecked;
revoke all on function public.player_form_unchecked(integer[], integer, uuid) from public, anon, authenticated;
grant execute on function public.player_form_unchecked(integer[], integer, uuid) to service_role;

create or replace function public.player_form_allowed(p_team_api_ids integer[])
returns boolean
language sql
stable
security definer
set search_path = public, pg_catalog
as $$
  select public.current_tier() <> 'free'
      or (
        coalesce(array_length(p_team_api_ids, 1), 0) > 0
        and not exists (
          select 1 from unnest(p_team_api_ids) as req(team_api_id)
          where req.team_api_id::text not in (
            select t.external_id
            from public.matches m
            join public.teams t on t.id in (m.home_team_id, m.away_team_id)
            where m.external_id in (select public.preview_fixture_external_ids())
              and t.external_id is not null
          )
        )
      );
$$;
revoke all on function public.player_form_allowed(integer[]) from public;
grant execute on function public.player_form_allowed(integer[]) to anon, authenticated, service_role;

create or replace function public.player_form(
  p_team_api_ids integer[],
  p_last         integer default 10,
  p_league_id    uuid    default null
)
returns table (
  player_id integer, player_name text, team_api_id integer, team_name text, player_position text,
  last_kickoff timestamptz, apps integer, starts integer, minutes integer, goals integer, assists integer,
  games_scored integer, shot_games integer, shot_minutes integer, shots integer, sot integer,
  games_1plus_shot integer, games_2plus_shots integer, games_1plus_sot integer, games_2plus_sot integer,
  shots_p90 numeric, sot_p90 numeric, card_games integer, yellows integer, reds integer, games_carded integer,
  foul_games integer, foul_minutes integer, fouls_committed integer, fouls_drawn integer,
  games_1plus_foul integer, games_2plus_fouls integer, fouls_p90 numeric
)
language plpgsql
stable
security definer
set search_path = public, pg_catalog
as $$
begin
  if not public.player_form_allowed(p_team_api_ids) then
    raise exception 'player hit rates are a paid feature'
      using errcode = '42501', hint = 'upgrade';
  end if;
  return query select * from public.player_form_unchecked(p_team_api_ids, p_last, p_league_id);
end;
$$;
revoke all on function public.player_form(integer[], integer, uuid) from public;
grant execute on function public.player_form(integer[], integer, uuid) to anon, authenticated, service_role;

comment on function public.player_form(integer[], integer, uuid) is
  'Paywalled last-N player hit rates. Paid tiers: any team. Free/anon: only the teams in today''s free preview fixture (same rule as match_stats), otherwise raises 42501 (PostgREST 403). Body is player_form_unchecked (service_role only). See migrations 134-135.';
