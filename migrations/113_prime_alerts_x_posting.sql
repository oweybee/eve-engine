-- 113: post an alerted PRIME to X in one tap, and reply when the price goes. RECORD ONLY.
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
--   20261016145012  prime_alerts_x_posting
--   20261016145033  prime_alerts_x_links
--
-- What it built: one-tap X posting from the Discord alert. prime_alerts gains a
-- per-alert post_token and the X post bookkeeping columns; send_prime_alerts()
-- appends a link to the prime-post-x edge function (supabase/functions/
-- prime-post-x) and, when a posted PRIME goes, calls it to reply with the price
-- correction.

-- 20261016145012 prime_alerts_x_posting
alter table public.prime_alerts
  add column if not exists post_token text not null default encode(extensions.gen_random_bytes(18), 'hex'),
  add column if not exists x_post_id text,
  add column if not exists x_posted_at timestamptz,
  add column if not exists x_error text;

do $d$
declare src text := pg_get_functiondef('public.prime_card_data'::regproc);
  o text := $o$'floor', to_char(a.floor_odds, 'FM990.00'),$o$;
  n text := $o$'floor', to_char(a.floor_odds, 'FM990.00'),
    'koRel', public.prime_ko_label(v.kickoff_at),
    'checkedTime', to_char(a.confirmed_at at time zone 'Europe/London', 'HH24:MI'),$o$;
begin
  if position(o in src)=0 then raise exception 'pattern missing'; end if;
  execute replace(src, o, n);
end $d$;

-- 20261016145033 prime_alerts_x_links
do $d$
declare src text := pg_get_functiondef('public.send_prime_alerts'::regproc);
  o3 text := $o$    select a.signal_id, a.kind, a.message
    from public.prime_alerts a
    left join public.v_prime_alert_state s on s.signal_id = a.signal_id$o$;
  n3 text := $o$    select a.signal_id, a.kind, a.message, a.post_token, p.x_post_id as parent_x, p.post_token as parent_token
    from public.prime_alerts a
    left join public.prime_alerts p on p.signal_id = a.signal_id and p.kind = 'live' and a.kind = 'gone'
    left join public.v_prime_alert_state s on s.signal_id = a.signal_id$o$;
  o4 text := $o$jsonb_build_object('content', left(r.message, 1990),$o$;
  n4 text := $o$jsonb_build_object('content', left(r.message || case
                 when r.kind = 'live' then E'\n\nPost to X now (one tap, rechecks the price first):\n<https://zlbmpeiuhyllxwegtayu.supabase.co/functions/v1/prime-post-x?id=' || r.signal_id || '&t=' || r.post_token || '>'
                 when r.parent_x is not null then E'\n\nYour X post is being corrected with this reply automatically.'
                 else '' end, 1990),$o$;
  o5 text := $o$    v_n := v_n + 1;
  end loop;

  return v_n;$o$;
  n5 text := $o$    if r.kind = 'gone' and r.parent_x is not null then
      perform net.http_get(url := 'https://zlbmpeiuhyllxwegtayu.supabase.co/functions/v1/prime-post-x?action=reply&id=' || r.signal_id || '&t=' || r.parent_token);
    end if;
    v_n := v_n + 1;
  end loop;

  return v_n;$o$;
begin
  if position(o3 in src)=0 or position(o4 in src)=0 or position(o5 in src)=0 then raise exception 'pattern missing'; end if;
  execute replace(replace(replace(src, o3, n3), o4, n4), o5, n5);
end $d$;
