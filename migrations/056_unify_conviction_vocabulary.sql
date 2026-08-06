-- 056_unify_conviction_vocabulary.sql
--
-- STAGED, NOT APPLIED. Read the whole header before running it.
--
-- WHAT THIS DOES, IN ONE LINE. Finishes the contract migration 033 promised and
-- bounds the two tier vocabularies the schema carries, so the database can hold
-- exactly the words the engine and the site can say and no others.
--
-- ORDERING. This runs AFTER 048, which adds `value_signals.mxs_band`. If 048
-- has not been applied, step 2 below is a no-op by design (the guard checks the
-- column exists) and the migration still succeeds — apply it again after 048
-- and step 2 lands. Nothing here depends on 049/050/051.
--
-- ─────────────────────────────────────────────────────────────────────────────
-- THE PROBLEM IT CLOSES
--
-- Two ladders exist and both are legitimate:
--
--   signal_category   ELIGIBILITY. Prime | Value | Longshot, from the price and
--                     the EV edge (lib/signalTier.js classifyTier). Decides what
--                     is suggested and what the performance record counts.
--
--   mxs_band          CONVICTION. PRIME | WATCH | NOTED | NOISE, from the
--                     MaxEdgeScore alone (048 maxedge_band). Decides how
--                     strongly a row reads.
--
-- Until 6 Aug 2026 the FIRST one's words were also the words printed on the
-- site, next to badges drawn from the second one. Two of the words were shared
-- and neither meant the same thing on both sides: a board row said PRIME
-- because its price sat in the profitable box, and a match card said PRIME
-- because MXS >= 65. The frontend unified on the conviction ladder
-- (eve-frontend/lib/semantics.ts, lib/maxedge.ts) and the eligibility ladder
-- kept its job and lost its words.
--
-- The schema never bounded either one:
--
--   * `value_signals_signal_category_check` still admits the four legacy values
--     033 left in on purpose — 'Longshot Edge', 'Standard', 'PriceMove',
--     'InPlay' — with a comment saying a later migration would contract them
--     "once every deploy has shipped". Every deploy has shipped. Nothing has
--     written a legacy value since 033's backfill, and the frontend type that
--     read 'Longshot Edge' was deleted on 6 Aug.
--
--   * `mxs_band` has no constraint at all. It is a free-text column filled by a
--     function, which is fine right up until something writes 'STRONG' into it.
--
-- A vocabulary the schema still accepts is a vocabulary something will
-- eventually write. This is the same argument that deleted the `--c-*` palette
-- from the frontend rather than disabling it.
--
-- ─────────────────────────────────────────────────────────────────────────────
-- SAFETY. Both statements are CHECK constraints over columns that already hold
-- only conforming values, so both are verified against the live table before
-- being installed. If either raises, DO NOT widen the constraint to make it
-- pass — find what wrote the offending value, because that writer is the bug.
-- The counts each guard prints are there so an operator can see what was
-- checked rather than trusting that it was.
--
-- REVERSIBLE. Dropping either constraint restores the prior state exactly; no
-- data is rewritten anywhere in this file.

begin;

-- ---------------------------------------------------------------------------
-- 1. Contract signal_category to the three canonical eligibility buckets.
--    This is the CONTRACT half of migration 033's expand-and-contract.
-- ---------------------------------------------------------------------------

do $$
declare
  n_legacy bigint;
begin
  select count(*) into n_legacy
  from public.value_signals
  where signal_category is not null
    and signal_category not in ('Prime', 'Value', 'Longshot');

  if n_legacy > 0 then
    raise exception
      'ABORTING: % value_signals rows still carry a legacy signal_category. '
      'Re-run migration 033 step 3b to recompute them, then apply this again. '
      'Do not widen this constraint.', n_legacy;
  end if;

  raise notice '056: signal_category is clean, contracting the CHECK.';
end $$;

alter table public.value_signals
  drop constraint if exists value_signals_signal_category_check;
alter table public.value_signals
  add constraint value_signals_signal_category_check
  check (signal_category = any (array['Prime'::text, 'Value'::text, 'Longshot'::text]));

comment on column public.value_signals.signal_category is
  'ELIGIBILITY bucket, from price + EV edge (lib/signalTier.js classifyTier): '
  'Prime = suggested and tracked, Value = shown, Longshot = quarantined at odds 3.00+. '
  'This is NOT what the site prints on a row - that is mxs_band, the conviction '
  'ladder. The two answer different questions and are allowed to disagree.';

-- ---------------------------------------------------------------------------
-- 2. Bound mxs_band to the four rungs. Guarded, because 048 may not be applied.
-- ---------------------------------------------------------------------------

do $$
declare
  n_bad bigint;
begin
  if not exists (
    select 1 from information_schema.columns
    where table_schema = 'public'
      and table_name   = 'value_signals'
      and column_name  = 'mxs_band'
  ) then
    raise notice '056: mxs_band does not exist yet (migration 048 is not applied). '
                 'Skipping step 2 - re-run this migration after 048.';
    return;
  end if;

  select count(*) into n_bad
  from public.value_signals
  where mxs_band is not null
    and mxs_band not in ('PRIME', 'WATCH', 'NOTED', 'NOISE');

  if n_bad > 0 then
    raise exception
      'ABORTING: % value_signals rows carry an mxs_band outside the four rungs. '
      'maxedge_band() cannot produce one, so something else wrote it.', n_bad;
  end if;

  execute $ddl$
    alter table public.value_signals
      drop constraint if exists value_signals_mxs_band_check
  $ddl$;
  execute $ddl$
    alter table public.value_signals
      add constraint value_signals_mxs_band_check
      check (mxs_band = any (array['PRIME'::text, 'WATCH'::text, 'NOTED'::text, 'NOISE'::text]))
  $ddl$;
  execute $ddl$
    comment on column public.value_signals.mxs_band is
      'CONVICTION rung, from mxs alone (maxedge_band, migration 048): '
      'PRIME 65+ (the only backed rung) | WATCH 40-64 | NOTED 25-39 | NOISE 0-24. '
      'NULL means the row could not be scored - which is a different statement '
      'from NOISE, and the UI renders them differently: an absent badge against '
      'a badge that says we looked and found nothing. '
      'Keep these four strings in step with LABELS in lib/signalTier.js and '
      'convictionMeta in eve-frontend/lib/semantics.ts.'
  $ddl$;

  raise notice '056: mxs_band bounded to the four rungs.';
end $$;

commit;

-- ---------------------------------------------------------------------------
-- VERIFY (run after applying; both should return zero rows)
-- ---------------------------------------------------------------------------
--
--   select signal_category, count(*)
--     from value_signals group by 1 order by 2 desc;
--   -- expect only Prime / Value / Longshot
--
--   select mxs_band, count(*)
--     from value_signals group by 1 order by 2 desc;
--   -- expect only PRIME / WATCH / NOTED / NOISE and null
--
--   -- the band never disagrees with the score it was derived from:
--   select count(*) from value_signals
--    where mxs is not null and mxs_band is distinct from maxedge_band(mxs);
--   -- expect 0
