-- Backfilled from the Supabase migration ledger (supabase_migrations.schema_migrations)
-- version 20261016140746, name stopgap_unconfirmed_best_functions. Applied directly to production; this file was
-- missing from the repo. Statements copied verbatim from the ledger on 25 Oct 2026.
-- DO NOT re-apply: it is already in the database. Nothing runs this folder.

-- STOPGAP (16 Oct 2026). Remove when eve-engine computeValues ignores quotes missing from the latest poll.
create or replace function public.best_book_is_current(p_match uuid, p_book text, p_market text, p_line numeric)
returns boolean language sql stable set search_path = public, pg_temp as $$
  with m as (
    select bookmaker, confirmed_at from odds_latest
    where match_id = p_match and market = p_market
      and market_line is not distinct from p_line
  ), latest as (select max(confirmed_at) t from m)
  select case
    when (select t from latest) is null then true
    else exists (select 1 from m, latest
                 where m.bookmaker = p_book
                   and m.confirmed_at >= latest.t - interval '5 minutes')
  end
$$;

create or replace function public.clear_edge_on_unconfirmed_best()
returns trigger language plpgsql set search_path = public, pg_temp as $$
begin
  if new.best_home_book is not null and not best_book_is_current(new.match_id, new.best_home_book, 'h2h', null) then
    new.home_edge := null; new.home_value := false; end if;
  if new.best_draw_book is not null and not best_book_is_current(new.match_id, new.best_draw_book, 'h2h', null) then
    new.draw_edge := null; new.draw_value := false; end if;
  if new.best_away_book is not null and not best_book_is_current(new.match_id, new.best_away_book, 'h2h', null) then
    new.away_edge := null; new.away_value := false; end if;
  if new.over_book is not null and not best_book_is_current(new.match_id, new.over_book, 'totals', new.totals_line) then
    new.over_edge := null; new.over_value := false; end if;
  if new.under_book is not null and not best_book_is_current(new.match_id, new.under_book, 'totals', new.totals_line) then
    new.under_edge := null; new.under_value := false; end if;
  if new.btts_yes_book is not null and not best_book_is_current(new.match_id, new.btts_yes_book, 'btts', null) then
    new.btts_yes_edge := null; new.btts_yes_value := false; end if;
  if new.btts_no_book is not null and not best_book_is_current(new.match_id, new.btts_no_book, 'btts', null) then
    new.btts_no_edge := null; new.btts_no_value := false; end if;
  if new.max_edge is not null then
    new.max_edge := greatest(new.home_edge, new.draw_edge, new.away_edge, new.over_edge, new.under_edge,
                             new.btts_yes_edge, new.btts_no_edge, new.corners_over_edge, new.corners_under_edge,
                             new.bookings_over_edge, new.bookings_under_edge);
  end if;
  return new;
end $$;
