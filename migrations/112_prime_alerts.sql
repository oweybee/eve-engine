-- 112: PRIME alerts to the owner's Discord, with a rendered card. RECORD ONLY.
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
--   20261016142729  prime_alerts_core
--   20261016142758  prime_alerts_sender
--   20261016142944  prime_card_data
--   20261016143206  prime_alerts_card_embed
--   20261016143617  prime_card_data_fair
--
-- What it built: the PRIME alert pipeline. v_prime_alert_state picks the best
-- fresh UK price for each pending prematch signal against its PRIME floor
-- (prime_floor_odds = 1.05 / model_prob, rounded up to 2dp); send_prime_alerts() (pg_cron
-- 'prime-alerts', every minute) writes a 'live' alert when a PRIME is takeable
-- and a 'gone' alert when the price later drops under the floor, and posts each
-- to the owner's private Discord webhook (vault secret
-- prime_alert_discord_webhook). prime_card_data() feeds the prime-card edge
-- function (supabase/functions/prime-card), whose PNG is embedded in the alert.
-- The selection text inside send_prime_alerts/prime_card_data is the pre-116
-- inline CASE; 116 added public.selection_label() for every market.

-- 20261016142729 prime_alerts_core
create or replace function public.prime_post_books()
returns text[] language sql immutable as
$f$ select array['bet365','williamhill','betvictor','betfair_sb_uk','betano']::text[] $f$;

create or replace function public.prime_book_label(k text)
returns text language sql immutable as
$f$ select case k when 'bet365' then 'bet365' when 'williamhill' then 'William Hill'
  when 'betvictor' then 'BetVictor' when 'betfair_sb_uk' then 'Betfair Sportsbook'
  when 'betano' then 'Betano' else k end $f$;

create or replace function public.prime_floor_odds(p_model_prob numeric)
returns numeric language sql immutable as
$f$ select case when p_model_prob is null or p_model_prob <= 0 then null
  else ceil(1.05 / p_model_prob * 100) / 100 end $f$;

create or replace function public.prime_ko_label(p timestamptz)
returns text language sql stable as
$f$ select case
  when (p at time zone 'Europe/London')::date = (now() at time zone 'Europe/London')::date then
    to_char(p at time zone 'Europe/London', 'HH24:MI')
    || case when extract(hour from p at time zone 'Europe/London') >= 17 then ' tonight' else ' today' end
  when (p at time zone 'Europe/London')::date = (now() at time zone 'Europe/London')::date + 1 then
    to_char(p at time zone 'Europe/London', 'HH24:MI') || ' tomorrow'
  else to_char(p at time zone 'Europe/London', 'Dy DD Mon, HH24:MI') end $f$;

create or replace view public.v_prime_alert_state as
select v.id as signal_id, v.match_id, v.market, v.market_line, v.outcome, v.rung,
       v.model_prob, v.mxs, v.kickoff_at,
       public.prime_floor_odds(v.model_prob) as floor_odds,
       q.bookmaker, q.odds, q.confirmed_at, q.price_since
from public.value_signals v
left join lateral (
  select x.* from (
    select ol.bookmaker,
           case when v.outcome = any (array['home','over','btts_yes']) then ol.home_odds
                when v.outcome = 'draw' then ol.draw_odds
                else ol.away_odds end as odds,
           ol.confirmed_at, ol.price_since
    from public.odds_latest ol
    where ol.match_id = v.match_id and ol.market = v.market
      and ol.market_line is not distinct from v.market_line
      and ol.bookmaker = any (public.prime_post_books())
      and ol.confirmed_at > now() - coalesce(public.price_max_age(extract(epoch from v.kickoff_at - now()) / 3600.0), interval '15 minutes')
      and not public.odds_latest_is_frozen(ol.match_id, ol.bookmaker, ol.market, ol.market_line, ol.price_since)
  ) x
  where x.odds is not null
  order by (x.odds >= public.prime_floor_odds(v.model_prob)) desc, (x.bookmaker = 'betano') asc, x.odds desc
  limit 1
) q on true
where coalesce(v.result, 'pending') = 'pending'
  and coalesce(v.phase, 'prematch') = 'prematch'
  and v.kickoff_at > now()
  and v.model_prob is not null;

revoke all on public.v_prime_alert_state from anon, authenticated;

create table if not exists public.prime_alerts (
  signal_id    uuid not null references public.value_signals(id) on delete cascade,
  kind         text not null check (kind in ('live', 'gone')),
  created_at   timestamptz not null default now(),
  sent_at      timestamptz,
  request_id   bigint,
  bookmaker    text,
  odds         numeric,
  floor_odds   numeric,
  confirmed_at timestamptz,
  message      text not null,
  primary key (signal_id, kind)
);
alter table public.prime_alerts enable row level security;

-- 20261016142758 prime_alerts_sender
create or replace function public.send_prime_alerts()
returns integer language plpgsql security definer
set search_path to 'public', 'pg_catalog'
as $f$
declare
  v_hook text; r record; v_sel text; v_fix text; v_msg text;
  v_edge text; v_book text; v_n int := 0;
begin
  select decrypted_secret into v_hook from vault.decrypted_secrets where name = 'prime_alert_discord_webhook';
  if coalesce(v_hook, '') = '' then return -1; end if;

  for r in
    select s.*, th.name as home, ta.name as away, l.name as league
    from public.v_prime_alert_state s
    join public.matches m on m.id = s.match_id
    left join public.teams th on th.id = m.home_team_id
    left join public.teams ta on ta.id = m.away_team_id
    left join public.leagues l on l.id = m.league_id
    where s.rung = 'PRIME' and s.odds >= s.floor_odds
      and not exists (select 1 from public.prime_alerts a where a.signal_id = s.signal_id and a.kind = 'live')
  loop
    v_sel := case r.market
      when 'h2h' then case r.outcome when 'home' then r.home || ' to win' when 'away' then r.away || ' to win' else 'Draw' end
      when 'totals' then initcap(r.outcome) || ' ' || trim_scale(r.market_line)::text || ' goals'
      when 'btts' then 'Both teams to score: ' || case when r.outcome = 'btts_yes' then 'Yes' else 'No' end
      else r.outcome end;
    v_fix  := r.home || ' v ' || r.away;
    v_book := public.prime_book_label(r.bookmaker);
    v_edge := to_char((r.model_prob * r.odds - 1) * 100, 'FM990.0') || '%';
    v_msg :=
      '**PRIME LIVE**' || E'\n'
      || v_fix || E'\n'
      || coalesce(r.league, '') || ', ' || public.prime_ko_label(r.kickoff_at) || E'\n'
      || v_sel || E'\n'
      || to_char(r.odds, 'FM990.00') || ' at ' || v_book
      || ', checked ' || to_char(r.confirmed_at at time zone 'Europe/London', 'HH24:MI') || E'\n'
      || 'Holds PRIME at ' || to_char(r.floor_odds, 'FM990.00') || ' or better'
      || ' | edge ' || v_edge || ' | score ' || coalesce(r.mxs::text, '-') || E'\n'
      || case when r.bookmaker = 'betano'
           then E'\nBETANO ONLY: check betano.co.uk shows ' || to_char(r.floor_odds, 'FM990.00')
                || ' or better before posting. The feed has not always matched the UK site.' || E'\n'
           else '' end
      || E'\nPost (X / Discord):\n```\n'
      || v_fix || ', ' || coalesce(r.league, '') || ', ' || public.prime_ko_label(r.kickoff_at) || E'\n'
      || v_sel || E'\n'
      || to_char(r.odds, 'FM990.00') || ' at ' || v_book || ', checked '
      || to_char(r.confirmed_at at time zone 'Europe/London', 'HH24:MI') || E'\n'
      || 'Prices move. PRIME at ' || to_char(r.floor_odds, 'FM990.00') || ' or better.' || E'\n'
      || 'Edge ' || v_edge || ' | PRIME' || E'\n\n'
      || '18+ | begambleaware.org | Pricing analysis, not advice'
      || E'\n```\nTikTok / Reels (no odds):\n```\n'
      || v_fix || ': ' || v_sel || '. PRIME on the board at maxedge.live' || E'\n'
      || '18+ | begambleaware.org' || E'\n```';
    insert into public.prime_alerts (signal_id, kind, bookmaker, odds, floor_odds, confirmed_at, message)
    values (r.signal_id, 'live', r.bookmaker, r.odds, r.floor_odds, r.confirmed_at, v_msg)
    on conflict do nothing;
  end loop;

  for r in
    select a.signal_id, a.floor_odds, s.odds, s.bookmaker, s.confirmed_at,
           th.name as home, ta.name as away, s.market, s.outcome, s.market_line
    from public.prime_alerts a
    join public.v_prime_alert_state s on s.signal_id = a.signal_id
    join public.matches m on m.id = s.match_id
    left join public.teams th on th.id = m.home_team_id
    left join public.teams ta on ta.id = m.away_team_id
    where a.kind = 'live' and a.sent_at is not null
      and s.odds is not null and s.odds < a.floor_odds
      and not exists (select 1 from public.prime_alerts g where g.signal_id = a.signal_id and g.kind = 'gone')
  loop
    v_sel := case r.market
      when 'h2h' then case r.outcome when 'home' then r.home || ' to win' when 'away' then r.away || ' to win' else 'Draw' end
      when 'totals' then initcap(r.outcome) || ' ' || trim_scale(r.market_line)::text || ' goals'
      when 'btts' then 'Both teams to score: ' || case when r.outcome = 'btts_yes' then 'Yes' else 'No' end
      else r.outcome end;
    v_msg :=
      '**PRIME GONE**' || E'\n'
      || r.home || ' v ' || r.away || ': ' || v_sel || E'\n'
      || 'Best UK price now ' || to_char(r.odds, 'FM990.00') || ' (' || public.prime_book_label(r.bookmaker)
      || ', ' || to_char(r.confirmed_at at time zone 'Europe/London', 'HH24:MI') || '), below the '
      || to_char(r.floor_odds, 'FM990.00') || ' PRIME floor.' || E'\n\n'
      || 'If you posted it, reply to the post:' || E'\n```\n'
      || 'Price update: now ' || to_char(r.odds, 'FM990.00') || ', below our PRIME floor of '
      || to_char(r.floor_odds, 'FM990.00') || '. No longer PRIME at current prices.' || E'\n```';
    insert into public.prime_alerts (signal_id, kind, bookmaker, odds, floor_odds, confirmed_at, message)
    values (r.signal_id, 'gone', r.bookmaker, r.odds, r.floor_odds, r.confirmed_at, v_msg)
    on conflict do nothing;
  end loop;

  for r in
    select a.signal_id, a.kind, a.message
    from public.prime_alerts a
    left join public.v_prime_alert_state s on s.signal_id = a.signal_id
    where a.sent_at is null and a.created_at > now() - interval '30 minutes'
      and (a.kind = 'gone' or s.odds >= s.floor_odds)
    order by a.created_at
  loop
    update public.prime_alerts
       set sent_at = now(),
           request_id = net.http_post(
             url := v_hook,
             headers := '{"Content-Type": "application/json"}'::jsonb,
             body := jsonb_build_object('content', left(r.message, 1990), 'allowed_mentions', jsonb_build_object('parse', '[]'::jsonb), 'flags', 4))
     where signal_id = r.signal_id and kind = r.kind;
    v_n := v_n + 1;
  end loop;

  return v_n;
end $f$;

revoke all on function public.send_prime_alerts() from public, anon, authenticated;

select cron.schedule('prime-alerts', '* * * * *', 'select public.send_prime_alerts()');

-- 20261016142944 prime_card_data
create or replace function public.prime_card_data(p_signal uuid)
returns jsonb language sql stable security definer
set search_path to 'public', 'pg_catalog'
as $f$
  select jsonb_build_object(
    'selection', case v.market
      when 'h2h' then case v.outcome when 'home' then th.name || ' to win' when 'away' then ta.name || ' to win' else 'Draw' end
      when 'totals' then initcap(v.outcome) || ' ' || trim_scale(v.market_line)::text || ' goals'
      when 'btts' then 'Both teams to score: ' || case when v.outcome = 'btts_yes' then 'Yes' else 'No' end
      else v.outcome end,
    'fixture', th.name || ' v ' || ta.name,
    'league', coalesce(l.name, ''),
    'koLabel', to_char(v.kickoff_at at time zone 'Europe/London', 'Dy DD Mon, HH24:MI'),
    'odds', to_char(a.odds, 'FM990.00'),
    'floor', to_char(a.floor_odds, 'FM990.00'),
    'book', public.prime_book_label(a.bookmaker),
    'checked', to_char(a.confirmed_at at time zone 'Europe/London', 'HH24:MI') || ' UK, '
               || to_char(a.confirmed_at at time zone 'Europe/London', 'Dy DD Mon'),
    'edge', to_char((v.model_prob * a.odds - 1) * 100, 'FM990.0') || '%',
    'score', v.mxs,
    'crestUrl', case v.outcome when 'home' then th.crest_url when 'away' then ta.crest_url end
  )
  from public.prime_alerts a
  join public.value_signals v on v.id = a.signal_id
  join public.matches m on m.id = v.match_id
  left join public.teams th on th.id = m.home_team_id
  left join public.teams ta on ta.id = m.away_team_id
  left join public.leagues l on l.id = m.league_id
  where a.signal_id = p_signal and a.kind = 'live'
$f$;
revoke all on function public.prime_card_data(uuid) from public, anon, authenticated;
grant execute on function public.prime_card_data(uuid) to service_role;

-- 20261016143206 prime_alerts_card_embed
do $d$
declare src text := pg_get_functiondef('public.send_prime_alerts'::regproc);
  o1 text := $o$body := jsonb_build_object('content', left(r.message, 1990), 'allowed_mentions', jsonb_build_object('parse', '[]'::jsonb), 'flags', 4))$o$;
  n1 text := $o$body := jsonb_build_object('content', left(r.message, 1990), 'allowed_mentions', jsonb_build_object('parse', '[]'::jsonb),
               'embeds', case when r.kind = 'live' then jsonb_build_array(jsonb_build_object('color', 10937470,
                 'image', jsonb_build_object('url', 'https://zlbmpeiuhyllxwegtayu.supabase.co/functions/v1/prime-card?id=' || r.signal_id)))
                 else '[]'::jsonb end))$o$;
  o2 text := $o$E'\nPost (X / Discord):\n```\n'$o$;
  n2 text := $o$E'\nX caption (save the card below and attach it):\n```\n'$o$;
begin
  if position(o1 in src)=0 or position(o2 in src)=0 then raise exception 'pattern missing'; end if;
  execute replace(replace(src,o1,n1),o2,n2);
end $d$;

-- 20261016143617 prime_card_data_fair
do $d$
declare src text := pg_get_functiondef('public.prime_card_data'::regproc);
  o text := $o$'floor', to_char(a.floor_odds, 'FM990.00'),$o$;
  n text := $o$'floor', to_char(a.floor_odds, 'FM990.00'),
    'fair', to_char(1 / v.model_prob, 'FM990.00'),$o$;
begin
  if position(o in src)=0 then raise exception 'pattern missing'; end if;
  execute replace(src, o, n);
end $d$;
