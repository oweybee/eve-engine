-- 181 - slip_scans: what Slip Scan read off a member's bet slip screenshot
--
-- Owner, 23 Oct 2026: a member uploads a screenshot of their bookmaker slip,
-- MAXEDGE reads the legs, price, stake and bookmaker, matches each leg to a
-- fixture, and the member saves it to the tracker as a bet or as follows.
-- Free accounts get 5 scans a calendar month; Plus has a fair-use limit.
--
-- ── THE IMAGE IS NEVER STORED ────────────────────────────────────────────
--
-- Screenshots show balances and usernames. The image is read in memory by the
-- /api/slip-scan route and discarded. Only the PARSED FIELDS land here, so a
-- read that went wrong can be looked at, and they are deleted after 30 days
-- (the pg_cron job below). The privacy notice says the same.
--
-- ── WHO WRITES ───────────────────────────────────────────────────────────
--
-- The API route, as service_role, after it has checked the caller's token and
-- counted their month. A member reads their own rows and nothing else. The
-- count that enforces the limit is `slip_scans_this_month()`, counted from
-- this table, so a member cannot reset it from the browser.

create table if not exists public.slip_scans (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid not null references auth.users(id) on delete cascade,
  status      text not null default 'read' check (status in ('read','failed','saved')),
  bookmaker   text,
  bet_type    text,
  legs        integer not null default 0,
  parsed      jsonb not null default '{}'::jsonb,
  matched     jsonb not null default '[]'::jsonb,
  saved_as    text check (saved_as in ('bet','follows')),
  model       text,
  created_at  timestamptz not null default now()
);

create index if not exists slip_scans_user_month on public.slip_scans (user_id, created_at desc);

comment on table public.slip_scans is
  'Parsed fields from Slip Scan (never the image). Written by /api/slip-scan as service_role; deleted after 30 days. Migration 181.';

alter table public.slip_scans enable row level security;
revoke all on public.slip_scans from anon, authenticated;
grant select on public.slip_scans to authenticated;

create policy slip_scans_read_own on public.slip_scans
  for select to authenticated
  using (user_id = (select auth.uid()));

-- Scans that count this calendar month (London). A read that found nothing is
-- 'failed' and does not count, so a blurry screenshot does not cost a scan.
create or replace function public.slip_scans_this_month(p_user uuid)
returns integer
language sql stable security definer set search_path = public, pg_catalog
as $$
  select count(*)::int from public.slip_scans
  where user_id = p_user and status <> 'failed'
    and created_at >= date_trunc('month', now() at time zone 'Europe/London') at time zone 'Europe/London';
$$;
revoke all on function public.slip_scans_this_month(uuid) from public, anon, authenticated;
grant execute on function public.slip_scans_this_month(uuid) to service_role;

-- The member's own count, for the "3 of 5 left" line on the upload screen.
create or replace function public.my_slip_scans_this_month()
returns integer
language sql stable security definer set search_path = public, pg_catalog
as $$ select public.slip_scans_this_month(auth.uid()) where auth.uid() is not null; $$;
revoke all on function public.my_slip_scans_this_month() from public, anon;
grant execute on function public.my_slip_scans_this_month() to authenticated;

-- Marks a scan saved, by its owner, once the bet or follows are written.
create or replace function public.mark_slip_scan_saved(p_id uuid, p_as text)
returns boolean
language sql volatile security definer set search_path = public, pg_catalog
as $$
  with u as (update public.slip_scans set status = 'saved', saved_as = p_as
             where id = p_id and user_id = auth.uid() and p_as in ('bet','follows') returning 1)
  select exists (select 1 from u);
$$;
revoke all on function public.mark_slip_scan_saved(uuid, text) from public, anon;
grant execute on function public.mark_slip_scan_saved(uuid, text) to authenticated;

-- 30-day retention.
select cron.schedule('slip-scans-retention', '17 4 * * *',
  $$delete from public.slip_scans where created_at < now() - interval '30 days'$$);
