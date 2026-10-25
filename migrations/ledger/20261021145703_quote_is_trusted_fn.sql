-- Backfilled from the Supabase migration ledger (supabase_migrations.schema_migrations)
-- version 20261021145703, name quote_is_trusted_fn. Applied directly to production; this file was
-- missing from the repo. Statements copied verbatim from the ledger on 25 Oct 2026.
-- DO NOT re-apply: it is already in the database. Nothing runs this folder.

-- One rule for "can we stand behind this soft-book quote?", shared by the
-- publisher, the revalidator and PRIME alerts. 21 Oct 2026: two PRIMEs went
-- live on Bet365 prices API-Football had stopped updating (Real Madrid v
-- Leipzig U4.5 cards 1.62 when Bet365 was 1.44; Reading -1 1.88 when it was
-- 1.675). Extras were exempt from the frozen check entirely.
create or replace function public.quote_is_trusted(
  p_match uuid, p_book text, p_market text, p_line numeric,
  p_price_since timestamptz, p_extra boolean, p_home numeric, p_away numeric)
returns boolean
language plpgsql stable security definer
set search_path to 'public', 'pg_catalog'
as $$
declare
  v_mkt text := case p_market when 'bookings' then 'cards' else p_market end;
  v_h2h_since timestamptz;
  t_book timestamptz; t_pin timestamptz;
  pin_home numeric; pin_away numeric;
begin
  if not coalesce(p_extra, false) then
    return not public.odds_latest_is_frozen(p_match, p_book, p_market, p_line, p_price_since);
  end if;
  if p_book = 'pinnacle' then return true; end if;

  -- 1. Fixture rule: the book's 1X2 on this match is frozen while the market
  --    moved, so the rest of its payload for the fixture is stale too.
  select price_since into v_h2h_since from public.odds_latest
   where match_id = p_match and bookmaker = p_book and market = 'h2h' and market_line is null;
  if v_h2h_since is not null
     and public.odds_latest_is_frozen(p_match, p_book, 'h2h', null, v_h2h_since) then
    return false;
  end if;

  -- 2. Line rule: this line hasn't changed for 6h+, Pinnacle has changed it
  --    since, and the book still sits 10%+ above Pinnacle on either side.
  select max(fetched_at) into t_book from public.odds_extra
   where match_id = p_match and market = v_mkt and market_line is not distinct from p_line and bookmaker = p_book;
  select max(fetched_at) into t_pin from public.odds_extra
   where match_id = p_match and market = v_mkt and market_line is not distinct from p_line and bookmaker = 'pinnacle';
  select home_odds, away_odds into pin_home, pin_away from public.odds_extra_latest
   where match_id = p_match and market = v_mkt and market_line is not distinct from p_line and bookmaker = 'pinnacle';
  if t_book is not null and t_book < now() - interval '6 hours'
     and t_pin is not null and t_pin > t_book + interval '1 hour'
     and ((p_home is not null and pin_home is not null and p_home >= pin_home * 1.10)
       or (p_away is not null and pin_away is not null and p_away >= pin_away * 1.10)) then
    return false;
  end if;
  return true;
end $$;
