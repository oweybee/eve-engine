-- 191: the nine Security Definer View advisories, resolved (24 Oct 2026).
-- ALREADY APPLIED to production as `security_definer_views_resolved`
-- (schema_migrations version 20261023235011), via the Supabase MCP, after a
-- rolled-back rehearsal. Recorded here so the repo matches the database.
-- Numbered 191, not 184: a parallel session applied 180-183 the same night.
--
-- GROUP 2 - PUBLIC BY RULING. v_best_prices (130) and v_price_curve (133) were
-- made definer on the owner's instruction: a best price and a best-price curve
-- are facts every bookmaker publishes. v_best_prices_extra is the same ruling for
-- the new markets. performance_signals is settled history only, which is never
-- gated. v_league_base_rates is league averages. v_match_extras is past corners
-- and cards per match (owner, 24 Oct: free). The definer view moves to
-- `open_layer`, a schema PostgREST does not serve (PGRST106 on Accept-Profile:
-- open_layer, verified), and a security_invoker view of the same name and
-- columns stays in `public` over it. Readers see exactly what they saw before at
-- every tier; the bypass is now a declared decision rather than an advisory.
--
-- GROUP 1 - LEAKS AGAINST THE 130 RULING ("no edge, no fair price, no model").
-- v_market_fair_probs handed every visitor the de-vigged fair price on every
-- priced match, and v_odds_extra_history every book's new-market price history
-- by name. odds_extra and odds_extra_latest had RLS on and NO policies, so they
-- gain the same 047-shaped tier rule odds_latest already carries, and both views
-- become security_invoker. Plus sees everything; free sees the preview matches.
--
-- MEASURED in the rehearsal and again live, anon / Plus:
--   six public views          identical before and after, both seats
--   v_market_fair_probs       18,074 -> 147 anon      18,074 Plus (unchanged)
--   v_odds_extra_history      38,468 -> 272 anon      38,468 Plus (unchanged)
--   site-shaped read, 60 matches: fair 238 -> 256ms anon, 227ms Plus;
--   history 148 -> 15ms anon, 49ms Plus. Well inside the 3s/8s timeouts.
-- All five frontend readers of the two gated views run in the BROWSER with the
-- caller's JWT (lib/marketSignals, extraPredictions, extraMovers, boardPrices,
-- portal/bookPrices), so no Plus member is served the free preview by a server
-- route. Reversible: drop the two policies, set security_invoker = false on the
-- two views; for group 2 drop each public wrapper and
-- `alter view open_layer.<v> set schema public`.
set local lock_timeout = '5s';

create schema if not exists open_layer;
comment on schema open_layer is
  'Definer views that publish derived figures from gated tables ON PURPOSE. Not exposed by PostgREST; reached only through the security_invoker views of the same name in public. See migration 191.';
revoke all on schema open_layer from public;
grant usage on schema open_layer to anon, authenticated, service_role;

do $g2$
declare v text;
begin
  foreach v in array array['v_best_prices','v_best_prices_extra','v_price_curve','performance_signals','v_league_base_rates','v_match_extras'] loop
    execute format('alter view public.%I set schema open_layer', v);
    execute format('revoke all on open_layer.%I from anon, authenticated', v);
    execute format('grant select on open_layer.%I to anon, authenticated, service_role', v);
    execute format('create view public.%I with (security_invoker = true) as select * from open_layer.%I', v, v);
    execute format('revoke all on public.%I from anon, authenticated', v);
    execute format('grant select on public.%I to anon, authenticated, service_role', v);
    execute format('comment on view public.%I is %L', v,
      'Public by owner ruling. security_invoker wrapper over open_layer.' || v || ', the definer view that bypasses the tier gate on purpose (migration 191).');
  end loop;
end $g2$;

create policy tiered_read_odds_extra on public.odds_extra for select to anon, authenticated
  using (((select public.current_tier()) <> 'free') or (match_id in (select public.preview_priced_match_ids())));
create policy tiered_read_odds_extra_latest on public.odds_extra_latest for select to anon, authenticated
  using (((select public.current_tier()) <> 'free') or (match_id in (select public.preview_priced_match_ids())));
alter view public.v_market_fair_probs set (security_invoker = true);
alter view public.v_odds_extra_history set (security_invoker = true);

-- ASSERTED, NOT EYEBALLED. Any failure rolls the whole migration back.
do $assert$
declare v text; full_n bigint; anon_n bigint;
begin
  foreach v in array array['v_best_prices','v_best_prices_extra','v_price_curve','performance_signals','v_league_base_rates','v_match_extras'] loop
    execute format('select count(*) from open_layer.%I', v) into full_n;
    set local role anon;
    execute format('select count(*) from public.%I', v) into anon_n;
    reset role;
    if anon_n <> full_n then raise exception '191: % changed for anon (% vs %)', v, anon_n, full_n; end if;
  end loop;
  foreach v in array array['v_market_fair_probs','v_odds_extra_history'] loop
    execute format('select count(*) from public.%I', v) into full_n;
    set local role anon;
    execute format('select count(*) from public.%I', v) into anon_n;
    reset role;
    if full_n > 0 and anon_n >= full_n then raise exception '191: % is not capped for anon (% of %)', v, anon_n, full_n; end if;
  end loop;
  if exists (select 1 from pg_class c where c.relnamespace = 'public'::regnamespace and c.relkind = 'v'
              and c.relname in ('v_best_prices','v_best_prices_extra','v_price_curve','performance_signals','v_league_base_rates','v_match_extras','v_market_fair_probs','v_odds_extra_history')
              and not coalesce((select option_value::boolean from pg_options_to_table(c.reloptions) where option_name = 'security_invoker'), false)) then
    raise exception '191: a public view is still security definer';
  end if;
end $assert$;
