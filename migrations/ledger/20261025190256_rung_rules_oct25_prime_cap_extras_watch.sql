-- Backfilled from the Supabase migration ledger (supabase_migrations.schema_migrations)
-- version 20261025190256, name rung_rules_oct25_prime_cap_extras_watch. Applied directly to production; this file was
-- missing from the repo. Statements copied verbatim from the ledger on 25 Oct 2026.
-- DO NOT re-apply: it is already in the database. Nothing runs this folder.

-- 25 Oct 2026 rung rules, confirmed by Owen. Forward only: anything detected before the cutover keeps
-- the 26 Aug rule for its rung AND its record band, so no settled history moves.
--  1. PRIME box row scoring 80+ is EDGE.
--  2. corners / cards (bookings) top out at WATCH and stay out of the PRIME/EDGE record.
--  5. DIXON_COLES goal totals above 3.5 are no longer published.

do $$ begin
  execute format('create or replace function public.rung_rules_cutover() returns timestamptz
    language sql immutable parallel safe set search_path to ''public'',''pg_catalog''
    as $b$select %L::timestamptz$b$', now()::text);
end $$;

create or replace function public.signal_rung_2026_08(p_odds numeric, p_edge numeric, p_mxs integer)
returns text language sql immutable parallel safe set search_path to 'public','pg_catalog' as $$
  select case
    when p_mxs is null or p_odds is null or p_edge is null then null
    when p_odds >= 1.40 and p_odds < 3.00 and p_edge >= 0.05 and p_edge < 0.07 then
      case when p_mxs >= 60 then 'PRIME' when p_mxs >= 41 then 'EDGE' else public.maxedge_band(p_mxs) end
    when p_odds >= 1.40 and p_odds < 3.00 and p_edge >= 0.07 and p_edge < 0.10 then
      case when p_mxs >= 41 then 'EDGE' else public.maxedge_band(p_mxs) end
    else public.cap_at_watch(public.maxedge_band(p_mxs))
  end;
$$;

create or replace function public.signal_rung(p_odds numeric, p_edge numeric, p_mxs integer)
returns text language sql immutable parallel safe set search_path to 'public','pg_catalog' as $$
  select case
    when p_mxs is null or p_odds is null or p_edge is null then null
    when p_odds >= 1.40 and p_odds < 3.00 and p_edge >= 0.05 and p_edge < 0.07 then
      case when p_mxs >= 60 and p_mxs < 80 then 'PRIME'
           when p_mxs >= 41 then 'EDGE'
           else public.maxedge_band(p_mxs) end
    when p_odds >= 1.40 and p_odds < 3.00 and p_edge >= 0.07 and p_edge < 0.10 then
      case when p_mxs >= 41 then 'EDGE' else public.maxedge_band(p_mxs) end
    else public.cap_at_watch(public.maxedge_band(p_mxs))
  end;
$$;

create or replace function public.rung_capped_market(p_market text)
returns boolean language sql immutable parallel safe set search_path to 'public','pg_catalog' as $$
  select coalesce(p_market, '') in ('corners', 'bookings', 'cards');
$$;

create or replace function public.signal_rung(p_odds numeric, p_edge numeric, p_mxs integer, p_market text)
returns text language sql immutable parallel safe set search_path to 'public','pg_catalog' as $$
  select case when public.rung_capped_market(p_market) and r in ('PRIME', 'EDGE') then 'WATCH' else r end
  from (select public.signal_rung(p_odds, p_edge, p_mxs) as r) x;
$$;

create or replace function public.set_signal_rung()
returns trigger language plpgsql set search_path to 'public','pg_temp' as $$
begin
  if tg_op = 'INSERT' or old.result is not distinct from 'pending' then
    if coalesce(new.detected_at, now()) < public.rung_rules_cutover() then
      new.rung := public.signal_rung_2026_08(new.detected_odds, new.detected_edge, new.mxs);
    else
      new.rung := public.signal_rung(new.detected_odds, new.detected_edge, new.mxs, new.market);
    end if;
  end if;
  return new;
end $$;

create or replace function public.live_signal_rung(p_rung text, p_odds numeric, p_edge numeric, p_mxs integer, p_market text)
returns text language sql immutable parallel safe set search_path to 'public','pg_catalog' as $$
  select case
    when p_odds is null or p_edge is null then null
    when p_rung in ('PRIME','EDGE') and p_edge >= 0.05 and p_odds >= 1.40 and p_odds < 3.00 then
      case when p_rung = 'PRIME' or public.signal_rung(p_odds, p_edge, p_mxs, p_market) = 'PRIME' then 'PRIME' else 'EDGE' end
    else public.signal_rung(p_odds, p_edge, p_mxs, p_market)
  end;
$$;

create or replace function public.record_band(p_odds numeric, p_edge numeric, p_mxs integer, p_market text, p_detected_at timestamptz)
returns text language sql immutable parallel safe set search_path to 'public','pg_catalog' as $$
  select case
    when p_odds is null or p_edge is null then null
    when p_odds >= 1.40 and p_odds < 3.00 and p_edge >= 0.05 and p_edge < 0.10 then
      case
        when p_detected_at < public.rung_rules_cutover() then
          case when p_edge < 0.07 then 'prime' else 'edge' end
        when public.rung_capped_market(p_market) then null
        when p_edge < 0.07 and coalesce(p_mxs, 0) < 80 then 'prime'
        else 'edge'
      end
    when p_odds >= 3.00 and p_odds < 1000 and p_edge >= 0.02 and p_edge < 1.0 then 'longshot'
    else null
  end;
$$;

create or replace function public.record_band_match(p_band text, p_odds numeric, p_edge numeric, p_mxs integer, p_market text, p_detected_at timestamptz)
returns boolean language sql immutable parallel safe set search_path to 'public','pg_catalog' as $$
  select case when p_band = 'all_backed'
              then public.record_band(p_odds, p_edge, p_mxs, p_market, p_detected_at) in ('prime', 'edge')
              else public.record_band(p_odds, p_edge, p_mxs, p_market, p_detected_at) = p_band end;
$$;

do $$
declare d text; n int;
begin
  d := pg_get_viewdef('public.v_signal_price_check'::regclass);
  if position('live_signal_rung(rung, best, edge, mxs)' in d) = 0 then raise exception 'v_signal_price_check: pattern not found'; end if;
  d := replace(d, 'live_signal_rung(rung, best, edge, mxs)', 'live_signal_rung(rung, best, edge, mxs, market)');
  execute 'create or replace view public.v_signal_price_check as ' || d;

  d := pg_get_functiondef('public.publish_new_market_signals'::regproc);
  if position('public.signal_rung(s.price::numeric, round(s.edge::numeric, 4), round(s.mxs_raw * s.eff)::int)' in d) = 0 then raise exception 'publisher: pattern not found'; end if;
  d := replace(d, 'public.signal_rung(s.price::numeric, round(s.edge::numeric, 4), round(s.mxs_raw * s.eff)::int)',
                  'public.signal_rung(s.price::numeric, round(s.edge::numeric, 4), round(s.mxs_raw * s.eff)::int, s.market)');
  execute d;

  d := pg_get_functiondef('public.refresh_performance_by_band'::regproc);
  n := (select count(*) from regexp_matches(d, 'v\.detected_odds >= b\.odds_min and v\.detected_odds < b\.odds_max\s+and v\.detected_edge >= b\.edge_min and v\.detected_edge < b\.edge_max', 'g'));
  if n <> 3 then raise exception 'refresh_performance_by_band: expected 3 band joins, found %', n; end if;
  d := regexp_replace(d, 'v\.detected_odds >= b\.odds_min and v\.detected_odds < b\.odds_max\s+and v\.detected_edge >= b\.edge_min and v\.detected_edge < b\.edge_max',
        'public.record_band_match(b.band_key, v.detected_odds, v.detected_edge, v.mxs, v.market, v.detected_at)', 'g');
  execute d;

  d := pg_get_viewdef('open_layer.performance_signals'::regclass);
  n := (select count(*) from regexp_matches(d, '\(v\.detected_odds >= b\.odds_min\) AND \(v\.detected_odds < b\.odds_max\) AND \(v\.detected_edge >= b\.edge_min\) AND \(v\.detected_edge < b\.edge_max\)', 'g'))
     + (select count(*) from regexp_matches(d, '\(vs\.detected_edge >= p\.edge_min\) AND \(vs\.detected_edge < p\.edge_max\) AND \(vs\.detected_odds >= p\.odds_min\) AND \(vs\.detected_odds < p\.odds_max\)', 'g'));
  if n <> 2 then raise exception 'open_layer.performance_signals: expected 2 band tests, found %', n; end if;
  d := regexp_replace(d, '\(v\.detected_odds >= b\.odds_min\) AND \(v\.detected_odds < b\.odds_max\) AND \(v\.detected_edge >= b\.edge_min\) AND \(v\.detected_edge < b\.edge_max\)',
        'public.record_band_match(b.band_key, v.detected_odds, v.detected_edge, v.mxs, v.market, v.detected_at)', 'g');
  d := regexp_replace(d, '\(vs\.detected_edge >= p\.edge_min\) AND \(vs\.detected_edge < p\.edge_max\) AND \(vs\.detected_odds >= p\.odds_min\) AND \(vs\.detected_odds < p\.odds_max\)',
        'public.record_band_match(p.band_key, vs.detected_odds, vs.detected_edge, vs.mxs, vs.market, vs.detected_at)', 'g');
  execute 'create or replace view open_layer.performance_signals as ' || d;
end $$;

create or replace function public.drop_deep_dc_totals()
returns trigger language plpgsql set search_path to 'public','pg_temp' as $$
begin
  if new.model_architecture = 'DIXON_COLES' and new.market = 'totals' and new.market_line > 3.5 then
    return null;
  end if;
  return new;
end $$;
drop trigger if exists trg_aa_drop_deep_dc_totals on public.value_signals;
create trigger trg_aa_drop_deep_dc_totals before insert on public.value_signals
  for each row execute function public.drop_deep_dc_totals();

do $$ begin
  assert public.signal_rung(2.0, 0.06, 70, 'h2h') = 'PRIME';
  assert public.signal_rung(2.0, 0.06, 85, 'h2h') = 'EDGE';
  assert public.signal_rung(2.0, 0.06, 79, 'h2h') = 'PRIME';
  assert public.signal_rung(2.0, 0.06, 50, 'h2h') = 'EDGE';
  assert public.signal_rung(2.0, 0.08, 85, 'h2h') = 'EDGE';
  assert public.signal_rung(2.0, 0.06, 70, 'corners') = 'WATCH';
  assert public.signal_rung(2.0, 0.08, 70, 'bookings') = 'WATCH';
  assert public.signal_rung(2.0, 0.03, 30, 'corners') = 'SLIGHT';
  assert public.signal_rung(2.0, 0.06, 70, 'ah') = 'PRIME';
  assert public.signal_rung(3.5, 0.06, 70, 'h2h') = 'WATCH';
  assert public.signal_rung_2026_08(2.0, 0.06, 85) = 'PRIME';
  assert public.record_band(2.0, 0.06, 85, 'corners', now() - interval '1 day') = 'prime';
  assert public.record_band(2.0, 0.06, 85, 'h2h', now() + interval '1 minute') = 'edge';
  assert public.record_band(2.0, 0.06, 70, 'corners', now() + interval '1 minute') is null;
  assert public.record_band(2.0, 0.06, 70, 'dnb', now() + interval '1 minute') = 'prime';
  assert public.record_band(4.0, 0.05, 30, 'corners', now() + interval '1 minute') = 'longshot';
end $$;
