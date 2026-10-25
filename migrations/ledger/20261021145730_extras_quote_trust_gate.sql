-- Backfilled from the Supabase migration ledger (supabase_migrations.schema_migrations)
-- version 20261021145730, name extras_quote_trust_gate. Applied directly to production; this file was
-- missing from the repo. Statements copied verbatim from the ledger on 25 Oct 2026.
-- DO NOT re-apply: it is already in the database. Nothing runs this folder.

do $$
declare
  old_expr text := '(ol.extra OR (NOT odds_latest_is_frozen(ol.match_id, ol.bookmaker, ol.market, ol.market_line, ol.price_since)))';
  new_expr text := 'quote_is_trusted(ol.match_id, ol.bookmaker, ol.market, ol.market_line, ol.price_since, ol.extra, ol.home_odds, ol.away_odds)';
  d text; f text;
begin
  -- revalidator's view
  d := pg_get_viewdef('public.v_signal_price_check'::regclass);
  if position(old_expr in d) = 0 then raise exception 'v_signal_price_check: expression not found'; end if;
  execute 'create or replace view public.v_signal_price_check as ' || replace(d, old_expr, new_expr);

  -- PRIME alerts
  d := pg_get_viewdef('public.v_prime_alert_state'::regclass);
  if position(old_expr in d) = 0 then raise exception 'v_prime_alert_state: expression not found'; end if;
  execute 'create or replace view public.v_prime_alert_state as ' || replace(d, old_expr, new_expr);

  -- publisher: extras branch had no check at all
  f := pg_get_functiondef('public.publish_new_market_signals'::regproc);
  if position('where ol.confirmed_at > now() - fx.max_age
    union all' in f) = 0 then raise exception 'publisher: anchor not found'; end if;
  f := replace(f, 'where ol.confirmed_at > now() - fx.max_age
    union all',
   'where ol.confirmed_at > now() - fx.max_age
      and public.quote_is_trusted(ol.match_id, ol.bookmaker, ol.market, ol.market_line, null, true, ol.home_odds, ol.away_odds)
    union all');
  execute f;
end $$;
