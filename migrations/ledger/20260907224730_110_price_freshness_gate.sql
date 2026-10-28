-- Backfilled from the Supabase migration ledger (supabase_migrations.schema_migrations)
-- version 20260907224730, name 110_price_freshness_gate. Applied directly to production; this file was
-- missing from the repo. Statements copied verbatim from the ledger on 25 Oct 2026.
-- DO NOT re-apply: it is already in the database. Nothing runs this folder.


-- =====================================================================
-- 110: Price freshness gate.
--
-- The board published computed_values rows filtered only on kickoff being
-- in the future, never on how old the PRICE was. Measured 7 Sep 2026:
-- 100% of board-eligible rows carried a price over 1h old, 28% over 7 days,
-- worst 52.9 days -- all under a "live, refreshes every 30s" badge whose
-- 30s is a client setInterval, not a data clock.
--
-- The age was always knowable: computed_values.odds_fetched_at. It was
-- simply never selected or tested. This adds the test.
--
-- NOTE: prune_stale_prices() is NOT this guard and never was -- it keys on
-- kickoff_at < now(), so it is disk retention for played fixtures and can
-- never touch an upcoming one however ancient its price.
-- =====================================================================

create table if not exists public.price_freshness_policy (
  tier              text primary key,
  max_hours_to_ko   numeric not null,      -- upper bound of the window
  max_price_age     interval not null,     -- older than this = not publishable
  publish           boolean not null default true,
  note              text
);

comment on table public.price_freshness_policy is
  'Maximum age a quoted price may reach before the board must stop showing it, banded by time to kickoff. Tightens as kickoff approaches because that is where the money is. Data, not code: change a threshold here and every reader follows. Never widen a band to make the board look fuller.';

insert into public.price_freshness_policy (tier, max_hours_to_ko, max_price_age, publish, note) values
  ('imminent', 3,     interval '15 minutes', true,  'Inside 3h of kickoff. Prices move fastest and users act immediately.'),
  ('near',     24,    interval '60 minutes', true,  'Inside 24h. Hourly refresh is affordable at this volume.'),
  ('ahead',    168,   interval '6 hours',    true,  'Inside a week. Twice-daily refresh.'),
  ('distant',  999999,interval '6 hours',    false, 'Beyond a week. Never refreshed in practice and not actionable: do not publish at all.')
on conflict (tier) do nothing;

alter table public.price_freshness_policy enable row level security;

drop policy if exists price_freshness_policy_read on public.price_freshness_policy;
create policy price_freshness_policy_read on public.price_freshness_policy
  for select using (true);

-- Which tier a fixture sits in, given hours to kickoff.
create or replace function public.price_tier(hours_to_ko numeric)
returns text language sql immutable as $$
  select tier from public.price_freshness_policy
  where hours_to_ko < max_hours_to_ko
  order by max_hours_to_ko asc
  limit 1;
$$;

-- The maximum age a price may reach for that fixture.
create or replace function public.price_max_age(hours_to_ko numeric)
returns interval language sql stable as $$
  select max_price_age from public.price_freshness_policy
  where hours_to_ko < max_hours_to_ko
  order by max_hours_to_ko asc
  limit 1;
$$;

comment on function public.price_max_age(numeric) is
  'Freshness budget for a fixture this far from kickoff. Read by v_board_rows; also the contract the refresh queue is built to satisfy.';

