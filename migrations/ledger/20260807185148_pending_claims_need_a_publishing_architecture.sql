-- Backfilled from the Supabase migration ledger (supabase_migrations.schema_migrations)
-- version 20260807185148, name pending_claims_need_a_publishing_architecture. Applied directly to production; this file was
-- missing from the repo. Statements copied verbatim from the ledger on 25 Oct 2026.
-- DO NOT re-apply: it is already in the database. Nothing runs this folder.

-- A PENDING CLAIM FROM A DISQUALIFIED MODEL IS NOT READABLE BY A CLIENT.
--
-- Found 7 Aug 2026, chasing "why are selections coming from API_PREDICTIVE if
-- they have been disqualified?".
--
-- THE DISQUALIFICATION LIVED ENTIRELY IN JAVASCRIPT. Every read path in the app
-- filters on `PUBLISHED_ARCHITECTURES`, and all of them are currently correct —
-- but that is a promise kept by eleven separate call sites remembering the same
-- `.in(...)` clause, over an anon key that ships in the browser bundle. Anyone
-- querying the REST API directly got the unfiltered rows.
--
-- AND THE FREE PREVIEW WAS SPENDING ITS WHOLE ALLOWANCE ON THEM.
-- `preview_value_signal_ids()` handed out the five most recent signals by
-- `detected_at`, with no regard for architecture or result. At the moment this
-- was written those five were three LAMBDA_MC rows (no `model_calibration` row
-- at all) and two API_PREDICTIVE rows (publish = false). Not one DIXON_COLES.
-- So the database granted a free member exactly five rows, the app filtered all
-- five out, and /signals rendered empty — a paywall that let you through a door
-- into an empty room.
--
-- TWO CHANGES, AND THEY ONLY WORK TOGETHER. The policy denies the rows; the
-- preview function has to stop pointing at rows that will now be denied, or the
-- free member's five-row allowance is still spent on nothing.
--
-- THE RULE IS THE ONE THE APP ALREADY FOLLOWS, lifted out of JavaScript:
-- lib/fixtures.js says it plainly — "SETTLED rows stay, whoever produced them:
-- a -47% yield is history and hiding it would be the same sin in the other
-- direction. PENDING rows from an architecture that may not publish are
-- removed, because those are still being offered as something to back."
--
-- So SETTLED history stays readable for every architecture. `/performance` and
-- the public ledger are untouched; MARKET_CONSENSUS's -47% yield stays visible,
-- which is the point of publishing a record at all. Only PENDING claims are
-- gated, because only a pending claim is an offer.
--
-- IT FAILS CLOSED. An architecture with no `model_calibration` row (LAMBDA_MC),
-- a null `publish`, or a null `result` all fall on the deny side.
--
-- IT CANNOT LOOSEN THE PRODUCT'S OWN GATE. `lib/publication.ts` still refuses
-- anything not in its own `PUBLICATION` map and is deliberately NOT driven by
-- this column, so flipping `publish` in a SQL console cannot start publishing a
-- model in the UI. This is a backstop underneath that gate, never a substitute.
--
-- NOT APPLIED TO `computed_values`, deliberately. Its rows are mostly PRICES,
-- and the publication gate's whole design is that an ungated row survives as a
-- best-price board with its claims stripped. Hiding those rows would delete
-- real prices to suppress a claim already handled.
--
-- service_role bypasses RLS, so the engine is unaffected.

-- 1. The gate.
drop policy if exists pending_needs_a_publishing_architecture on public.value_signals;
create policy pending_needs_a_publishing_architecture
  on public.value_signals
  as restrictive
  for select
  to anon, authenticated
  using (
    coalesce(result, 'pending') <> 'pending'
    or exists (
      select 1 from public.model_calibration mc
      where mc.model_architecture = value_signals.model_architecture
        and mc.publish
    )
  );

-- 2. The free preview must offer rows that survive it.
create or replace function public.preview_value_signal_ids()
returns setof uuid
language sql
stable security definer
set search_path to 'public', 'pg_catalog'
as $function$
  select v.id
  from public.value_signals v
  where coalesce(v.result, 'pending') = 'pending'
    and exists (
      select 1 from public.model_calibration mc
      where mc.model_architecture = v.model_architecture and mc.publish)
  order by v.detected_at desc nulls last
  limit public.free_preview_limit()
$function$;

-- 3. Assertions. A permission change that quietly empties a surface is worse
--    than the hole it closed, so this fails the migration rather than the page.
do $$
declare
  preview_rows int;
  unpublished_in_preview int;
  settled_visible int;
begin
  select count(*) into preview_rows from public.preview_value_signal_ids();

  select count(*) into unpublished_in_preview
  from public.value_signals v
  where v.id in (select public.preview_value_signal_ids())
    and not exists (select 1 from public.model_calibration mc
                    where mc.model_architecture = v.model_architecture and mc.publish);

  select count(*) into settled_visible
  from public.value_signals
  where coalesce(result,'pending') <> 'pending';

  if unpublished_in_preview > 0 then
    raise exception 'the free preview still offers % rows from a non-publishing architecture', unpublished_in_preview;
  end if;

  if preview_rows = 0 then
    raise warning 'the free preview is empty — no pending signal from a publishing architecture exists right now. Correct, but check it is not permanent.';
  end if;

  raise notice 'free preview now offers % rows, all from publishing architectures; % settled rows remain readable by everyone',
    preview_rows, settled_visible;
end $$;
