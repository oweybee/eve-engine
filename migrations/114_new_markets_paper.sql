-- 114: paper trading for double chance, draw no bet, Asian handicap, corners and cards. RECORD ONLY.
--
-- THIS FILE IS A RECORD. The SQL below was applied directly to production via
-- the Supabase MCP on 16 Oct 2026 and is reproduced verbatim from
-- supabase_migrations.schema_migrations (statements column), in the order it
-- was applied. It must NOT be re-run: several blocks rewrite a live function
-- by string replacement on pg_get_functiondef(), and cron.schedule() calls are
-- not idempotent. pg_get_functiondef() in the database is the source of truth
-- for every function named here; if it disagrees with this file, the database
-- wins. Each block is checked against md5(statements[1]) at the time of
-- recording.
--
-- Applied as (schema_migrations version, name):
--   20261016152905  new_markets_paper_114a
--   20261016152955  new_markets_paper_114b
--   20261016153007  new_markets_paper_114c
--   20261016153138  new_markets_extra_tables_114d
--   20261016153209  new_markets_read_extra_114e
--   20261016153726  match_extras_due_114f
--
-- What it built: paper trading for the new markets (double chance, draw no
-- bet, Asian handicap, corners, cards) under MARKET_ANCHORED_* model names with
-- publish = false: log_new_market_paper_trades(), capture_new_market_closes(),
-- settle_new_market_paper_trades(), gate_watch_notify(), their pg_cron jobs,
-- the odds_extra / odds_extra_latest quote tables and ingest_fixture_odds_extra(),
-- closing_lines_thin and the thin_panel_consensus scoring anchor,
-- match_extra_stats, and match_extras_due() feeding the match-extras edge
-- function. 116 later published these markets on the owner's ruling.

-- 20261016152905 new_markets_paper_114a
create or replace function public.price_was_takeable(p_match_id uuid, p_market text, p_market_line numeric, p_selection text, p_at timestamp with time zone, p_price numeric, p_window interval default '00:30:00'::interval)
returns boolean language sql stable
set search_path to 'public', 'pg_catalog'
as $function$
  select case when max(px) is null then null
              else p_price <= max(px) * 1.001 end
  from (
    select case
             when p_selection in ('home', 'over', 'btts_yes', 'dc_1x', 'dnb_home', 'ah_home') then o.home_odds
             when p_selection in ('draw', 'dc_12')                                          then o.draw_odds
             else o.away_odds
           end as px
    from public.odds o
    where o.match_id = p_match_id
      and coalesce(o.market, 'h2h') = coalesce(p_market, 'h2h')
      and coalesce(o.market_line, -1) = coalesce(p_market_line, -1)
      and o.fetched_at between p_at - p_window and p_at + p_window
      and o.bookmaker = any (array['bet365','williamhill','betvictor','unibet_uk','betfair_sb_uk',
                                   'paddypower','skybet','betano','10bet','dafabet','sbo','marathonbet'])
  ) q
  where px > 1;
$function$;

insert into public.model_selection_anchor (model, market, book_set, devig_method, line_kind, notes) values
  ('MARKET_ANCHORED_DC', 'dc', array['pinnacle'], 'shin', 'own_vector', 'log_new_market_paper_trades(): fair = sums of Shin-de-vigged Pinnacle 1X2 (1X = h+d, 12 = h+a, X2 = d+a); edge = fair * best UK price - 1.'),
  ('MARKET_ANCHORED_DNB', 'dnb', array['pinnacle'], 'shin', 'own_vector', 'fair = Shin-de-vigged Pinnacle 1X2 with the draw removed: h/(h+a), a/(h+a).'),
  ('MARKET_ANCHORED_AH', 'ah', array['pinnacle'], 'shin', 'own_vector', 'fair = Shin-de-vigged Pinnacle Asian handicap at the SAME line, whole and half lines only (no quarter lines). Whole-line pushes settle void.'),
  ('MARKET_ANCHORED_CORNERS', 'corners', array['pinnacle'], 'shin', 'own_vector', 'fair = Shin-de-vigged Pinnacle corners over/under at the SAME line.'),
  ('MARKET_ANCHORED_CARDS', 'cards', array['pinnacle'], 'shin', 'own_vector', 'fair = Shin-de-vigged Pinnacle cards over/under at the SAME line. Settled on total cards shown (yellow + red, one each).')
on conflict do nothing;

insert into public.model_calibration (model_architecture, sigma_p, sigma_source, z_gate, n_settled, publish, notes, calibrated_at)
select m, 0.03, 'floor', 1, 0, false,
       'UNPROVEN. MARKET_ANCHORED rule extended to ' || mk || ', added 16 Oct 2026 for paper trading. Writes paper_trades only. publish=false until paper_trade_gate() returns PASS and the owner rules.',
       now()
from (values ('MARKET_ANCHORED_DC','double chance'), ('MARKET_ANCHORED_DNB','draw no bet'), ('MARKET_ANCHORED_AH','Asian handicap'),
             ('MARKET_ANCHORED_CORNERS','corners over/under'), ('MARKET_ANCHORED_CARDS','cards over/under')) v(m, mk)
where not exists (select 1 from public.model_calibration c where c.model_architecture = v.m);

create or replace function public.log_new_market_paper_trades()
returns integer language plpgsql security definer
set search_path to 'public', 'pg_catalog'
as $f$
declare n int := 0; r record; res record;
begin
  for r in
    with fx as (
      select m.id as match_id, m.kickoff_at,
             coalesce(public.price_max_age((extract(epoch from m.kickoff_at - now()) / 3600.0)::numeric), interval '15 minutes') as max_age
      from public.matches m
      where m.kickoff_at > now() + interval '10 minutes' and m.kickoff_at < now() + interval '48 hours'
        and coalesce(m.status, 'scheduled') in ('scheduled', 'NS', 'TBD')
    ),
    q as (
      select ol.match_id, ol.bookmaker, ol.market, ol.market_line, ol.home_odds, ol.draw_odds, ol.away_odds, fx.kickoff_at
      from public.odds_latest ol join fx on fx.match_id = ol.match_id
      where ol.market in ('h2h', 'dc', 'dnb', 'ah', 'corners', 'cards')
        and ol.confirmed_at > now() - fx.max_age
        and not public.odds_latest_is_frozen(ol.match_id, ol.bookmaker, ol.market, ol.market_line, ol.price_since)
    ),
    p3 as (
      select match_id, public.shin_devig(array[home_odds, draw_odds, away_odds]::float8[]) as p
      from q where bookmaker = 'pinnacle' and market = 'h2h'
    ),
    p2 as (
      select match_id, market, market_line, public.shin_devig(array[home_odds, away_odds]::float8[]) as p
      from q where bookmaker = 'pinnacle' and market in ('ah', 'corners', 'cards')
    ),
    uk as (select * from q where bookmaker = any (public.prime_post_books())),
    legs as (
      select u.match_id, u.kickoff_at, 'MARKET_ANCHORED_DC'::text as model, 'dc'::text as market, null::numeric as line,
             s.sel, s.price, u.bookmaker, s.fair
      from uk u join p3 on p3.match_id = u.match_id and p3.p is not null
      cross join lateral (values ('dc_1x', u.home_odds, p3.p[1] + p3.p[2]),
                                 ('dc_12', u.draw_odds, p3.p[1] + p3.p[3]),
                                 ('dc_x2', u.away_odds, p3.p[2] + p3.p[3])) s(sel, price, fair)
      where u.market = 'dc'
      union all
      select u.match_id, u.kickoff_at, 'MARKET_ANCHORED_DNB', 'dnb', null, s.sel, s.price, u.bookmaker, s.fair
      from uk u join p3 on p3.match_id = u.match_id and p3.p is not null
      cross join lateral (values ('dnb_home', u.home_odds, p3.p[1] / (p3.p[1] + p3.p[3])),
                                 ('dnb_away', u.away_odds, p3.p[3] / (p3.p[1] + p3.p[3]))) s(sel, price, fair)
      where u.market = 'dnb'
      union all
      select u.match_id, u.kickoff_at,
             case u.market when 'ah' then 'MARKET_ANCHORED_AH' when 'corners' then 'MARKET_ANCHORED_CORNERS' else 'MARKET_ANCHORED_CARDS' end,
             u.market, u.market_line, s.sel, s.price, u.bookmaker, s.fair
      from uk u join p2 on p2.match_id = u.match_id and p2.market = u.market
                       and p2.market_line = u.market_line and p2.p is not null
      cross join lateral (values (case when u.market = 'ah' then 'ah_home' else 'over' end, u.home_odds, p2.p[1]),
                                 (case when u.market = 'ah' then 'ah_away' else 'under' end, u.away_odds, p2.p[2])) s(sel, price, fair)
      where u.market in ('ah', 'corners', 'cards')
        and (u.market <> 'ah' or u.market_line * 2 = floor(u.market_line * 2))
    ),
    ranked as (
      select l.*,
             count(*) over w as books, avg(l.price) over w as avgp,
             row_number() over (partition by l.match_id, l.model, l.line, l.sel order by l.price desc, l.bookmaker) as rn
      from legs l
      where l.price > 1 and l.fair > 0 and l.fair < 1
      window w as (partition by l.match_id, l.model, l.line, l.sel)
    )
    select * from ranked
    where rn = 1 and fair >= 0.30 and price <= 4.50 and books >= 2 and fair * price - 1 >= 0.02
  loop
    select * into res from public.insert_paper_trade(
      r.match_id, r.kickoff_at, r.model, 'v1', r.market, r.sel,
      round(r.fair::numeric, 4), r.price, r.line, r.bookmaker, r.books::int, round(r.avgp::numeric, 4),
      null, 0.03, null, now(), null,
      format('pinnacle fair %s edge %s', round((1 / r.fair)::numeric, 4), round((r.fair * r.price - 1)::numeric, 4)));
    if res.status = 'inserted' then n := n + 1; end if;
  end loop;
  return n;
end $f$;

revoke all on function public.log_new_market_paper_trades() from public, anon, authenticated;

-- 20261016152955 new_markets_paper_114b
create or replace function public.capture_new_market_closes()
returns integer language plpgsql security definer
set search_path to 'public', 'pg_catalog'
as $f$
declare n int := 0; u int := 0;
begin
  create temp table _nm_close on commit drop as
  with fx as (
    select id as match_id, kickoff_at from public.matches
    where kickoff_at between now() - interval '5 minutes' and now() + interval '20 minutes'
  ),
  q as (
    select ol.*, fx.kickoff_at from public.odds_latest ol join fx on fx.match_id = ol.match_id
    where ol.market in ('dc', 'dnb', 'ah', 'corners', 'cards')
      and ol.confirmed_at <= fx.kickoff_at
      and ol.bookmaker = any (array['bet365','williamhill','betvictor','unibet_uk','betfair_sb_uk',
                                    'paddypower','skybet','betano','10bet','dafabet','sbo','marathonbet'])
  ),
  per_book as (
    select q.match_id, q.kickoff_at, q.market, q.market_line, q.bookmaker, q.confirmed_at, s.sel, s.price,
           s.price_inv / ((1 / q.home_odds + 1 / q.draw_odds + 1 / q.away_odds) / 2) as prob,
           (1 / q.home_odds + 1 / q.draw_odds + 1 / q.away_odds) / 2 as overround
    from q cross join lateral (values ('dc_1x', q.home_odds, 1 / q.home_odds), ('dc_12', q.draw_odds, 1 / q.draw_odds),
                                      ('dc_x2', q.away_odds, 1 / q.away_odds)) s(sel, price, price_inv)
    where q.market = 'dc' and q.home_odds > 1 and q.draw_odds > 1 and q.away_odds > 1
    union all
    select q.match_id, q.kickoff_at, q.market, q.market_line, q.bookmaker, q.confirmed_at, s.sel, s.price,
           s.prob, 1 / q.home_odds + 1 / q.away_odds
    from q cross join lateral (
      select public.shin_devig(array[q.home_odds, q.away_odds]::float8[]) as p) d
    cross join lateral (values (case q.market when 'dnb' then 'dnb_home' when 'ah' then 'ah_home' else 'over' end, q.home_odds, d.p[1]),
                               (case q.market when 'dnb' then 'dnb_away' when 'ah' then 'ah_away' else 'under' end, q.away_odds, d.p[2])) s(sel, price, prob)
    where q.market <> 'dc' and q.home_odds > 1 and q.away_odds > 1 and d.p is not null
  )
  select match_id, max(kickoff_at) as kickoff_at, market, market_line, sel,
         round((percentile_cont(0.5) within group (order by price))::numeric, 3) as closing_odds,
         round((percentile_cont(0.5) within group (order by prob))::numeric, 6) as no_vig_prob,
         count(distinct bookmaker)::int as book_count, array_agg(distinct bookmaker) as books,
         round(avg(overround)::numeric, 4) as overround, max(confirmed_at) as quoted_at
  from per_book
  group by match_id, market, market_line, sel
  having count(distinct bookmaker) >= 5;

  -- Refresh a close already captured for this run window...
  update public.closing_lines_independent c
     set closing_odds = t.closing_odds, no_vig_prob = t.no_vig_prob, no_vig_odds = round(1 / t.no_vig_prob, 4),
         book_count = t.book_count, books = t.books, overround = t.overround, quoted_at = t.quoted_at,
         captured_at = now(), lead_minutes = round((extract(epoch from t.kickoff_at - t.quoted_at) / 60.0)::numeric, 1)
    from _nm_close t
   where c.match_id = t.match_id and c.market = t.market and c.selection = t.sel
     and c.market_line is not distinct from t.market_line
     and t.no_vig_prob > 0 and t.no_vig_prob < 1;
  get diagnostics u = row_count;

  -- ...and add the ones not captured yet.
  insert into public.closing_lines_independent (match_id, market, market_line, selection, closing_odds, no_vig_prob, no_vig_odds,
                                                book_count, books, overround, kickoff_at, quoted_at, captured_at, lead_minutes)
  select t.match_id, t.market, t.market_line, t.sel, t.closing_odds, t.no_vig_prob, round(1 / t.no_vig_prob, 4),
         t.book_count, t.books, t.overround, t.kickoff_at, t.quoted_at, now(),
         round((extract(epoch from t.kickoff_at - t.quoted_at) / 60.0)::numeric, 1)
  from _nm_close t
  where t.no_vig_prob > 0 and t.no_vig_prob < 1
    and not exists (select 1 from public.closing_lines_independent c
                     where c.match_id = t.match_id and c.market = t.market and c.selection = t.sel
                       and c.market_line is not distinct from t.market_line);
  get diagnostics n = row_count;
  return n + u;
end $f$;

create table if not exists public.match_extra_stats (
  match_id   uuid primary key references public.matches(id) on delete cascade,
  corners    integer,
  cards      integer,
  yellow     integer,
  red        integer,
  fetched_at timestamptz not null default now()
);
alter table public.match_extra_stats enable row level security;

create or replace function public.settle_new_market_paper_trades()
returns integer language plpgsql security definer
set search_path to 'public', 'pg_catalog'
as $f$
declare r record; n int := 0; won boolean; push boolean; v numeric; d numeric; v_close numeric; v_fair numeric;
begin
  for r in
    select pt.*, m.goals_home as gh, m.goals_away as ga, m.kickoff_at as ko, s.corners, s.cards
    from public.paper_trades pt
    join public.matches m on m.id = pt.match_id
    left join public.match_extra_stats s on s.match_id = pt.match_id
    where pt.result = 'pending'
      and pt.model in ('MARKET_ANCHORED_DC','MARKET_ANCHORED_DNB','MARKET_ANCHORED_AH','MARKET_ANCHORED_CORNERS','MARKET_ANCHORED_CARDS')
      and m.status = 'completed' and m.goals_home is not null and m.goals_away is not null
  loop
    won := null; push := false; v := null;
    if r.market = 'dc' then
      v := r.gh - r.ga;
      won := case r.selection when 'dc_1x' then r.gh >= r.ga when 'dc_12' then r.gh <> r.ga else r.ga >= r.gh end;
    elsif r.market = 'dnb' then
      v := r.gh - r.ga;
      if r.gh = r.ga then push := true; else won := (r.selection = 'dnb_home') = (r.gh > r.ga); end if;
    elsif r.market = 'ah' then
      d := (r.gh - r.ga) + r.market_line;
      if r.selection = 'ah_away' then d := -d; end if;
      v := r.gh - r.ga;
      if d = 0 then push := true; else won := d > 0; end if;
    elsif r.market in ('corners', 'cards') then
      v := case r.market when 'corners' then r.corners else r.cards end;
      if v is null then
        if r.ko < now() - interval '3 days' then
          update public.paper_trades set result = 'void', pl_units = 0, settled_at = now(),
                 notes = coalesce(notes, '') || ' | voided: no ' || r.market || ' stats after 3 days'
           where id = r.id;
          n := n + 1;
        end if;
        continue;
      end if;
      if v = r.market_line then push := true; else won := (r.selection = 'over') = (v > r.market_line); end if;
    else
      continue;
    end if;

    v_close := null; v_fair := null;
    select c.closing_odds, c.no_vig_odds into v_close, v_fair
    from public.closing_lines_independent_valid c
    where c.match_id = r.match_id and c.market = r.market and c.selection = r.selection
      and c.market_line is not distinct from r.market_line
    order by c.captured_at desc limit 1;

    update public.paper_trades
       set result       = case when push then 'void' when won then 'win' else 'loss' end,
           pl_units     = case when push then 0 when won then price_taken - 1 else -1 end,
           actual_value = v,
           closing_price = v_close,
           clv          = case when v_close > 1 then round(ln(price_taken / v_close), 4) end,
           no_vig_clv   = case when v_fair > 1 then round(ln(price_taken / v_fair), 4) end,
           settled_at   = now()
     where id = r.id;
    n := n + 1;
  end loop;
  return n;
end $f$;

revoke all on function public.capture_new_market_closes(), public.settle_new_market_paper_trades() from public, anon, authenticated;

-- 20261016153007 new_markets_paper_114c
create table if not exists public.gate_watch (
  model      text not null,
  market     text not null,
  verdict    text not null,
  changed_at timestamptz not null default now(),
  primary key (model, market)
);
alter table public.gate_watch enable row level security;

create or replace function public.gate_watch_notify()
returns integer language plpgsql security definer
set search_path to 'public', 'pg_catalog'
as $f$
declare r record; v_hook text; n int := 0; v_prev text; kind text; prev_kind text;
begin
  select decrypted_secret into v_hook from vault.decrypted_secrets where name = 'prime_alert_discord_webhook';
  for r in
    select g.* from public.paper_trade_gate() g
    where g.model in ('MARKET_ANCHORED_TOTALS','MARKET_ANCHORED_DC','MARKET_ANCHORED_DNB','MARKET_ANCHORED_AH',
                      'MARKET_ANCHORED_CORNERS','MARKET_ANCHORED_CARDS')
  loop
    kind := split_part(r.verdict, ' ', 1);
    v_prev := null;
    select verdict into v_prev from public.gate_watch where model = r.model and market = r.market;
    prev_kind := split_part(coalesce(v_prev, ''), ' ', 1);
    insert into public.gate_watch (model, market, verdict) values (r.model, r.market, r.verdict)
    on conflict (model, market) do update set verdict = excluded.verdict,
      changed_at = case when split_part(gate_watch.verdict, ' ', 1) <> split_part(excluded.verdict, ' ', 1) then now() else gate_watch.changed_at end;
    if v_hook is not null and v_prev is not null and kind <> prev_kind and kind in ('PASS', 'FAIL') then
      perform net.http_post(url := v_hook, headers := '{"Content-Type": "application/json"}'::jsonb,
        body := jsonb_build_object('content',
          '**Paper gate: ' || r.model || ' (' || r.market || ') is now ' || kind || '**' || E'\n'
          || r.verdict || E'\n'
          || format('Settled fixtures %s of %s needed | CLV %s%% (z %s) | takeable %s%% | yield %s%%',
                    r.settled_fixtures, r.required_fixtures, coalesce(r.avg_clv_pct::text, 'n/a'), coalesce(r.clv_zscore::text, 'n/a'),
                    coalesce(r.takeable_pct::text, 'n/a'), coalesce(r.yield_pct::text, 'n/a'))
          || case when kind = 'PASS' then E'\nReady for your ruling before anything goes on the public board.' else '' end,
          'allowed_mentions', jsonb_build_object('parse', '[]'::jsonb)));
      n := n + 1;
    end if;
  end loop;
  return n;
end $f$;

revoke all on function public.gate_watch_notify() from public, anon, authenticated;

select cron.schedule('new-market-paper-log',    '2-57/5 * * * *', 'select public.log_new_market_paper_trades()');
select cron.schedule('new-market-closes',       '4-59/5 * * * *', 'select public.capture_new_market_closes()');
select cron.schedule('new-market-paper-settle', '52 * * * *',     'select public.settle_new_market_paper_trades()');
select cron.schedule('paper-gate-watch',        '15 8 * * *',     'select public.gate_watch_notify()');

-- 20261016153138 new_markets_extra_tables_114d
-- New-market quotes live in their own tables so nothing that reads odds_latest /
-- odds (board, match page, price charts, engine) ever sees a market it does not know.
create table if not exists public.odds_extra (
  id bigint generated always as identity primary key,
  match_id uuid not null references public.matches(id) on delete cascade,
  bookmaker text not null, market text not null, market_line numeric,
  home_odds numeric not null, draw_odds numeric, away_odds numeric not null,
  fetched_at timestamptz not null default now()
);
create index if not exists odds_extra_lookup on public.odds_extra (match_id, market, market_line, fetched_at);

create table if not exists public.odds_extra_latest (
  match_id uuid not null references public.matches(id) on delete cascade,
  bookmaker text not null, market text not null, market_line numeric,
  home_odds numeric not null, draw_odds numeric, away_odds numeric not null,
  confirmed_at timestamptz not null,
  constraint odds_extra_latest_key unique nulls not distinct (match_id, bookmaker, market, market_line)
);
alter table public.odds_extra enable row level security;
alter table public.odds_extra_latest enable row level security;

create or replace function public.ingest_fixture_odds_extra(p_match_id uuid, p_rows jsonb, p_fetched_at timestamptz default now())
returns jsonb language plpgsql security definer
set search_path to 'public', 'pg_catalog'
as $f$
declare w int := 0; c int := 0;
begin
  if p_rows is null or jsonb_array_length(p_rows) = 0 then return jsonb_build_object('written', 0, 'changed', 0); end if;

  insert into public.odds_extra (match_id, bookmaker, market, market_line, home_odds, draw_odds, away_odds, fetched_at)
  select distinct on (r.bookmaker, r.market, r.market_line) p_match_id, r.bookmaker, r.market, r.market_line, r.home_odds, r.draw_odds, r.away_odds, p_fetched_at
  from jsonb_to_recordset(p_rows) as r(bookmaker text, market text, market_line numeric, home_odds numeric, draw_odds numeric, away_odds numeric)
  where not exists (
    select 1 from public.odds_extra_latest ol
     where ol.match_id = p_match_id and ol.bookmaker = r.bookmaker and ol.market = r.market
       and ol.market_line is not distinct from r.market_line
       and ol.home_odds = r.home_odds and ol.draw_odds is not distinct from r.draw_odds and ol.away_odds = r.away_odds);
  get diagnostics c = row_count;

  insert into public.odds_extra_latest (match_id, bookmaker, market, market_line, home_odds, draw_odds, away_odds, confirmed_at)
  select distinct on (r.bookmaker, r.market, r.market_line) p_match_id, r.bookmaker, r.market, r.market_line, r.home_odds, r.draw_odds, r.away_odds, p_fetched_at
  from jsonb_to_recordset(p_rows) as r(bookmaker text, market text, market_line numeric, home_odds numeric, draw_odds numeric, away_odds numeric)
  on conflict (match_id, bookmaker, market, market_line) do update
    set home_odds = excluded.home_odds, draw_odds = excluded.draw_odds, away_odds = excluded.away_odds, confirmed_at = excluded.confirmed_at;
  get diagnostics w = row_count;
  -- No expiry step: every reader filters on confirmed_at freshness, so a quote a
  -- refresh stops returning simply ages out.
  return jsonb_build_object('written', w, 'changed', c);
end $f$;
revoke all on function public.ingest_fixture_odds_extra(uuid, jsonb, timestamptz) from public, anon, authenticated;
grant execute on function public.ingest_fixture_odds_extra(uuid, jsonb, timestamptz) to service_role;

-- Takeability for the new markets reads odds_extra.
create or replace function public.price_was_takeable(p_match_id uuid, p_market text, p_market_line numeric, p_selection text, p_at timestamp with time zone, p_price numeric, p_window interval default '00:30:00'::interval)
returns boolean language sql stable
set search_path to 'public', 'pg_catalog'
as $function$
  select case when max(px) is null then null
              else p_price <= max(px) * 1.001 end
  from (
    select case
             when p_selection in ('home', 'over', 'btts_yes', 'dc_1x', 'dnb_home', 'ah_home') then o.home_odds
             when p_selection in ('draw', 'dc_12')                                          then o.draw_odds
             else o.away_odds
           end as px
    from (
      select match_id, market, market_line, bookmaker, home_odds, draw_odds, away_odds, fetched_at from public.odds
       where coalesce(p_market, 'h2h') not in ('dc', 'dnb', 'ah', 'corners', 'cards')
      union all
      select match_id, market, market_line, bookmaker, home_odds, draw_odds, away_odds, fetched_at from public.odds_extra
       where p_market in ('dc', 'dnb', 'ah', 'corners', 'cards')
    ) o
    where o.match_id = p_match_id
      and coalesce(o.market, 'h2h') = coalesce(p_market, 'h2h')
      and coalesce(o.market_line, -1) = coalesce(p_market_line, -1)
      and o.fetched_at between p_at - p_window and p_at + p_window
      and o.bookmaker = any (array['bet365','williamhill','betvictor','unibet_uk','betfair_sb_uk',
                                   'paddypower','skybet','betano','10bet','dafabet','sbo','marathonbet'])
  ) q
  where px > 1;
$function$;

-- Thin-panel closes: these markets are quoted by 2-4 panel books, below the
-- 5-book floor of closing_lines_independent. Own table, own scoring anchor, so
-- the gate shows exactly which (weaker) benchmark it is reading.
create table if not exists public.closing_lines_thin (
  id uuid primary key default gen_random_uuid(),
  match_id uuid not null references public.matches(id) on delete cascade,
  market text not null, market_line numeric, selection text not null,
  closing_odds numeric not null check (closing_odds > 1),
  no_vig_prob numeric not null check (no_vig_prob > 0 and no_vig_prob < 1),
  no_vig_odds numeric not null,
  book_count integer not null check (book_count >= 2),
  books text[], overround numeric,
  kickoff_at timestamptz not null, quoted_at timestamptz not null check (quoted_at <= kickoff_at),
  captured_at timestamptz not null default now(), lead_minutes numeric,
  constraint closing_lines_thin_key unique nulls not distinct (match_id, market, market_line, selection)
);
alter table public.closing_lines_thin enable row level security;

insert into public.scoring_anchor (anchor_key, book_set, devig_method, line_kind, source_table, description)
values ('thin_panel_consensus',
        array['bet365','williamhill','betvictor','unibet_uk','betfair_sb_uk','paddypower','skybet','betano','10bet','dafabet','sbo','marathonbet'],
        'shin', 'panel_median', 'closing_lines_thin',
        'Median pre-kickoff close across the bettable panel with PINNACLE EXCLUDED, minimum 2 books (DC normalised to sum 2, two-way markets Shin-de-vigged). For markets the feed quotes too thinly for the 5-book independent close: double chance, draw no bet, Asian handicap, corners, cards. Weaker evidence than independent_consensus.')
on conflict do nothing;

-- 20261016153209 new_markets_read_extra_114e
create or replace function public.log_new_market_paper_trades()
returns integer language plpgsql security definer
set search_path to 'public', 'pg_catalog'
as $f$
declare n int := 0; r record; res record;
begin
  for r in
    with fx as (
      select m.id as match_id, m.kickoff_at,
             coalesce(public.price_max_age((extract(epoch from m.kickoff_at - now()) / 3600.0)::numeric), interval '15 minutes') as max_age
      from public.matches m
      where m.kickoff_at > now() + interval '10 minutes' and m.kickoff_at < now() + interval '48 hours'
        and coalesce(m.status, 'scheduled') in ('scheduled', 'NS', 'TBD')
    ),
    q as (
      select ol.match_id, ol.bookmaker, ol.market, ol.market_line, ol.home_odds, ol.draw_odds, ol.away_odds, fx.kickoff_at
      from public.odds_extra_latest ol join fx on fx.match_id = ol.match_id
      where ol.confirmed_at > now() - fx.max_age
    ),
    p3 as (
      select ol.match_id, public.shin_devig(array[ol.home_odds, ol.draw_odds, ol.away_odds]::float8[]) as p
      from public.odds_latest ol join fx on fx.match_id = ol.match_id
      where ol.bookmaker = 'pinnacle' and ol.market = 'h2h'
        and ol.confirmed_at > now() - fx.max_age
        and not public.odds_latest_is_frozen(ol.match_id, ol.bookmaker, ol.market, ol.market_line, ol.price_since)
    ),
    p2 as (
      select match_id, market, market_line, public.shin_devig(array[home_odds, away_odds]::float8[]) as p
      from q where bookmaker = 'pinnacle' and market in ('ah', 'corners', 'cards')
    ),
    uk as (select * from q where bookmaker = any (public.prime_post_books())),
    legs as (
      select u.match_id, u.kickoff_at, 'MARKET_ANCHORED_DC'::text as model, 'dc'::text as market, null::numeric as line,
             s.sel, s.price, u.bookmaker, s.fair
      from uk u join p3 on p3.match_id = u.match_id and p3.p is not null
      cross join lateral (values ('dc_1x', u.home_odds, p3.p[1] + p3.p[2]),
                                 ('dc_12', u.draw_odds, p3.p[1] + p3.p[3]),
                                 ('dc_x2', u.away_odds, p3.p[2] + p3.p[3])) s(sel, price, fair)
      where u.market = 'dc'
      union all
      select u.match_id, u.kickoff_at, 'MARKET_ANCHORED_DNB', 'dnb', null, s.sel, s.price, u.bookmaker, s.fair
      from uk u join p3 on p3.match_id = u.match_id and p3.p is not null
      cross join lateral (values ('dnb_home', u.home_odds, p3.p[1] / (p3.p[1] + p3.p[3])),
                                 ('dnb_away', u.away_odds, p3.p[3] / (p3.p[1] + p3.p[3]))) s(sel, price, fair)
      where u.market = 'dnb'
      union all
      select u.match_id, u.kickoff_at,
             case u.market when 'ah' then 'MARKET_ANCHORED_AH' when 'corners' then 'MARKET_ANCHORED_CORNERS' else 'MARKET_ANCHORED_CARDS' end,
             u.market, u.market_line, s.sel, s.price, u.bookmaker, s.fair
      from uk u join p2 on p2.match_id = u.match_id and p2.market = u.market
                       and p2.market_line = u.market_line and p2.p is not null
      cross join lateral (values (case when u.market = 'ah' then 'ah_home' else 'over' end, u.home_odds, p2.p[1]),
                                 (case when u.market = 'ah' then 'ah_away' else 'under' end, u.away_odds, p2.p[2])) s(sel, price, fair)
      where u.market in ('ah', 'corners', 'cards')
        and (u.market <> 'ah' or u.market_line * 2 = floor(u.market_line * 2))
    ),
    ranked as (
      select l.*,
             count(*) over w as books, avg(l.price) over w as avgp,
             row_number() over (partition by l.match_id, l.model, l.line, l.sel order by l.price desc, l.bookmaker) as rn
      from legs l
      where l.price > 1 and l.fair > 0 and l.fair < 1
      window w as (partition by l.match_id, l.model, l.line, l.sel)
    )
    select * from ranked
    where rn = 1 and fair >= 0.30 and price <= 4.50 and books >= 2 and fair * price - 1 >= 0.02
  loop
    select * into res from public.insert_paper_trade(
      r.match_id, r.kickoff_at, r.model, 'v1', r.market, r.sel,
      round(r.fair::numeric, 4), r.price, r.line, r.bookmaker, r.books::int, round(r.avgp::numeric, 4),
      null, 0.03, null, now(), null,
      format('pinnacle fair %s edge %s', round((1 / r.fair)::numeric, 4), round((r.fair * r.price - 1)::numeric, 4)));
    if res.status = 'inserted' then
      update public.paper_trades set scoring_anchor = 'thin_panel_consensus' where id = res.trade_id;
      n := n + 1;
    end if;
  end loop;
  return n;
end $f$;

create or replace function public.capture_new_market_closes()
returns integer language plpgsql security definer
set search_path to 'public', 'pg_catalog'
as $f$
declare n int := 0;
begin
  with fx as (
    select id as match_id, kickoff_at from public.matches
    where kickoff_at between now() - interval '5 minutes' and now() + interval '20 minutes'
  ),
  q as (
    select ol.*, fx.kickoff_at from public.odds_extra_latest ol join fx on fx.match_id = ol.match_id
    where ol.confirmed_at <= fx.kickoff_at
      and ol.bookmaker = any (array['bet365','williamhill','betvictor','unibet_uk','betfair_sb_uk',
                                    'paddypower','skybet','betano','10bet','dafabet','sbo','marathonbet'])
  ),
  per_book as (
    select q.match_id, q.kickoff_at, q.market, q.market_line, q.bookmaker, q.confirmed_at, s.sel, s.price,
           s.price_inv / ((1 / q.home_odds + 1 / q.draw_odds + 1 / q.away_odds) / 2) as prob,
           (1 / q.home_odds + 1 / q.draw_odds + 1 / q.away_odds) / 2 as overround
    from q cross join lateral (values ('dc_1x', q.home_odds, 1 / q.home_odds), ('dc_12', q.draw_odds, 1 / q.draw_odds),
                                      ('dc_x2', q.away_odds, 1 / q.away_odds)) s(sel, price, price_inv)
    where q.market = 'dc' and q.home_odds > 1 and q.draw_odds > 1 and q.away_odds > 1
    union all
    select q.match_id, q.kickoff_at, q.market, q.market_line, q.bookmaker, q.confirmed_at, s.sel, s.price,
           s.prob, 1 / q.home_odds + 1 / q.away_odds
    from q cross join lateral (
      select public.shin_devig(array[q.home_odds, q.away_odds]::float8[]) as p) d
    cross join lateral (values (case q.market when 'dnb' then 'dnb_home' when 'ah' then 'ah_home' else 'over' end, q.home_odds, d.p[1]),
                               (case q.market when 'dnb' then 'dnb_away' when 'ah' then 'ah_away' else 'under' end, q.away_odds, d.p[2])) s(sel, price, prob)
    where q.market <> 'dc' and q.home_odds > 1 and q.away_odds > 1 and d.p is not null
  ),
  agg as (
    select match_id, max(kickoff_at) as kickoff_at, market, market_line, sel,
           round((percentile_cont(0.5) within group (order by price))::numeric, 3) as closing_odds,
           round((percentile_cont(0.5) within group (order by prob))::numeric, 6) as no_vig_prob,
           count(distinct bookmaker)::int as book_count, array_agg(distinct bookmaker) as books,
           round(avg(overround)::numeric, 4) as overround, max(confirmed_at) as quoted_at
    from per_book
    group by match_id, market, market_line, sel
    having count(distinct bookmaker) >= 2
  ),
  up as (
    insert into public.closing_lines_thin (match_id, market, market_line, selection, closing_odds, no_vig_prob, no_vig_odds,
                                           book_count, books, overround, kickoff_at, quoted_at, captured_at, lead_minutes)
    select match_id, market, market_line, sel, closing_odds, no_vig_prob, round(1 / no_vig_prob, 4),
           book_count, books, overround, kickoff_at, quoted_at, now(),
           round((extract(epoch from kickoff_at - quoted_at) / 60.0)::numeric, 1)
    from agg where no_vig_prob > 0 and no_vig_prob < 1
    on conflict (match_id, market, market_line, selection) do update
      set closing_odds = excluded.closing_odds, no_vig_prob = excluded.no_vig_prob, no_vig_odds = excluded.no_vig_odds,
          book_count = excluded.book_count, books = excluded.books, overround = excluded.overround,
          quoted_at = excluded.quoted_at, captured_at = excluded.captured_at, lead_minutes = excluded.lead_minutes
    returning 1)
  select count(*) into n from up;
  return n;
end $f$;

do $d$
declare src text := pg_get_functiondef('public.settle_new_market_paper_trades'::regproc);
  o text := $o$from public.closing_lines_independent_valid c$o$;
  nn text := $o$from public.closing_lines_thin c$o$;
  o2 text := $o$    order by c.captured_at desc limit 1;$o$;
  n2 text := $o$      and c.lead_minutes <= public.closing_line_max_lead_minutes()
    order by c.captured_at desc limit 1;$o$;
begin
  if position(o in src) = 0 or position(o2 in src) = 0 then raise exception 'pattern missing'; end if;
  execute replace(replace(src, o, nn), o2, n2);
end $d$;

-- 20261016153726 match_extras_due_114f
create or replace function public.match_extras_due()
returns table(match_id uuid, external_id text)
language sql stable security definer
set search_path to 'public', 'pg_catalog'
as $f$
  select distinct m.id, m.external_id
  from public.paper_trades pt
  join public.matches m on m.id = pt.match_id
  where pt.result = 'pending' and pt.market in ('corners', 'cards')
    and m.status = 'completed' and m.external_id ~ '^\d+$'
    and m.kickoff_at < now() - interval '2 hours'
    and not exists (select 1 from public.match_extra_stats s where s.match_id = m.id)
  limit 40
$f$;
revoke all on function public.match_extras_due() from public, anon, authenticated;
grant execute on function public.match_extras_due() to service_role;
grant execute on function public.settle_new_market_paper_trades() to service_role;

select cron.schedule('match-extras-hourly', '38 * * * *',
  (select replace(command, '/functions/v1/refresh-odds', '/functions/v1/match-extras') from cron.job where jobname = 'refresh-odds'));
