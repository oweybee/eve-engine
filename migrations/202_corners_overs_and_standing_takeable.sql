-- 202: corners keeps only the two buckets that made money; the price-liveness
-- check reads the quote that was standing when we published; cards match.
-- Owner ruling, 20 Nov 2026. Applied to production the same day.
--
-- 1. CORNERS. MARKET_ANCHORED corners signals, settled to 20 Nov (648 settled,
--    592 with a de-vigged close), by side and line:
--        over  <9      58   ROI +20.1%   no-vig CLV -2.27%
--        over  9-10.5 308   ROI  -0.4%   CLV -2.73%   z -10.5
--        over  11+     53   ROI +18.3%   CLV -1.31%
--        under <9      37   ROI -13.1%   CLV -4.13%
--        under 9-10.5 162   ROI  -2.5%   CLV -3.47%   z -10.3
--        under 11+     26   ROI  -0.6%   CLV -3.01%
--    publish_new_market_signals() now writes a corners signal only for an OVER
--    on a line below 9 or at 11 and above. Every slice still loses to the close
--    on CLV; the two kept buckets are the owner's call on realised return.
--    Forward only: pending and settled rows are untouched.
--
-- 2. price_was_takeable() read prices WRITTEN within +/-30 minutes of the
--    signal. odds_extra is append-on-change, so a price standing for longer was
--    invisible and the only row seen was the next CHANGE, i.e. a different
--    price. Example: Betano dc_1x stood at 1.19 from 07:45 to 14:10 on 18 Nov;
--    the 13:48 signal at 1.19 was marked untakeable off the 14:10 row (1.13).
--    It now reads, per UK book, the latest quote at or before the signal (2-min
--    slack for the same refresh, 24h lookback). MARKET_ANCHORED takeable %:
--        dc 17.5 -> 100   dnb 23.0 -> 100   h2h 71.9 -> 100
--        ah 58.4 -> 100   corners 78.2 -> 100   totals 66.7 -> 97.4
--    With one feed, takeable means "our feed showed it"; it cannot see a book
--    that moved before the feed did, and the old window never measured that.
--    Signature unchanged (p_window kept, now unused) so paper_trade_gate() and
--    signal_price_liveness keep calling it positionally.
--
-- 3. value_signals stores cards as 'bookings', odds_extra as 'cards', so the
--    check never matched a cards signal. 'bookings' now reads 'cards' prices.

begin;

do $$
declare
  def text := pg_get_functiondef('public.publish_new_market_signals()'::regprocedure);
  old text := $o$    where v.fair >= 0.30 and v.price <= 4.50 and v.books >= 2 and v.edge >= 0.02
      and v.market_prob > 0 and v.market_prob < 1
  ),$o$;
  new text := $n$    where v.fair >= 0.30 and v.price <= 4.50 and v.books >= 2 and v.edge >= 0.02
      and v.market_prob > 0 and v.market_prob < 1
      -- 202: corners only as an over below 9 or at 11+ (owner, 20 Nov 2026)
      and (v.market <> 'corners' or (v.sel = 'over' and (v.line < 9 or v.line >= 11)))
  ),$n$;
begin
  if position('202: corners only' in def) > 0 then
    raise notice '[202] corners filter already present';
  else
    if (length(def) - length(replace(def, old, ''))) / length(old) <> 1 then
      raise exception '[202] anchor not found exactly once in publish_new_market_signals';
    end if;
    execute replace(def, old, new);
  end if;
end $$;

create or replace function public.price_was_takeable(
  p_match_id uuid, p_market text, p_market_line numeric, p_selection text,
  p_at timestamp with time zone, p_price numeric, p_window interval default '00:30:00'::interval)
returns boolean
language sql stable
set search_path to 'public', 'pg_catalog'
as $function$
  -- The quote each UK book was STANDING at when we published (202). p_window is
  -- kept for the signature and no longer used.
  select case when max(px) is null then null else p_price <= max(px) * 1.001 end
  from (
    select distinct on (o.bookmaker)
      case
        when p_selection in ('home', 'over', 'btts_yes', 'dc_1x', 'dnb_home', 'ah_home') then o.home_odds
        when p_selection in ('draw', 'dc_12')                                          then o.draw_odds
        else o.away_odds
      end as px
    from (
      select match_id, market, market_line, bookmaker, home_odds, draw_odds, away_odds, fetched_at from public.odds
       where coalesce(p_market, 'h2h') not in ('dc', 'dnb', 'ah', 'corners', 'cards', 'bookings')
      union all
      select match_id, market, market_line, bookmaker, home_odds, draw_odds, away_odds, fetched_at from public.odds_extra
       where p_market in ('dc', 'dnb', 'ah', 'corners', 'cards', 'bookings')
    ) o
    where o.match_id = p_match_id
      and coalesce(o.market, 'h2h') = case coalesce(p_market, 'h2h') when 'bookings' then 'cards' else coalesce(p_market, 'h2h') end
      and coalesce(o.market_line, -1) = coalesce(p_market_line, -1)
      and o.fetched_at <= p_at + interval '2 minutes'
      and o.fetched_at >  p_at - interval '24 hours'
      and o.bookmaker = any (array['bet365','williamhill','betvictor','unibet_uk','betfair_sb_uk',
                                   'paddypower','skybet','betano','10bet','dafabet','sbo','marathonbet'])
    order by o.bookmaker, o.fetched_at desc
  ) q
  where px > 1;
$function$;

do $$
declare d text := pg_get_functiondef('public.publish_new_market_signals()'::regprocedure);
begin
  if position('202: corners only' in d) = 0 then raise exception '[202] corners filter missing after apply'; end if;
end $$;

commit;
