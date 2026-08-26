
-- 096 — band_calibration: a dated snapshot of how every rung's edge band is
-- actually performing, so a band that stops paying is caught by a job rather
-- than by someone remembering to look.
--
-- WHY A NEW TABLE RATHER THAN FIXING edge_calibration. That table sweeps 141
-- candidate boxes looking for the BEST one and stores a single recommendation.
-- It answers "where should the box be". This one answers a different and more
-- operational question — "are the boxes we already ship still working" — one
-- row per band per run, so drift is a time series instead of a verdict. Both
-- are wanted. edge_calibration's own comment says its output is never applied
-- automatically; the same rule governs this table, and `status` is an ALERT,
-- never an instruction the engine reads.
--
-- The band list below MIRRORS lib/signalTier.js. It is duplicated on purpose
-- and the duplication is the point: if someone moves a cutoff in the engine and
-- not here, the tracker keeps measuring the OLD band and the mismatch shows up
-- as a coverage gap rather than as silence.

begin;

create table if not exists public.band_calibration (
  id                uuid primary key default gen_random_uuid(),
  as_of_date        date        not null,
  window_days       int         not null,
  band_key          text        not null,
  band_label        text        not null,
  edge_min          numeric     not null,
  edge_max          numeric     not null,
  odds_min          numeric     not null,
  odds_max          numeric     not null,
  backed            boolean     not null,
  n                 int         not null,
  fixtures          int         not null,
  wins              int         not null,
  strike            numeric,
  avg_odds          numeric,
  avg_edge          numeric,
  yield             numeric,
  units             numeric,
  yield_se          numeric,
  yield_z           numeric,
  avg_no_vig_clv    numeric,
  clv_n             int,
  top_fixture_share numeric,
  status            text        not null,
  note              text,
  calculated_at     timestamptz not null default now(),
  unique (as_of_date, window_days, band_key)
);

comment on table public.band_calibration is
  'Dated per-band health snapshot for the published rungs. One row per band per run. '
  'yield_z is FIXTURE-CLUSTERED (CR0) — signals on one match are not independent bets. '
  'top_fixture_share is the share of the band''s net units contributed by its single best '
  'fixture: a band above ~0.5 is one result wearing a trend. `status` is an ALERT ONLY; '
  'no engine code reads this table and no band ever moves automatically.';

comment on column public.band_calibration.top_fixture_share is
  'Best single fixture''s units / band net units. Null when net units are ~0. Above 0.5 the '
  'band''s headline is one match.';

alter table public.band_calibration enable row level security;

drop policy if exists band_calibration_service_only on public.band_calibration;
create policy band_calibration_service_only on public.band_calibration
  for all using (true) with check (true);
revoke all on public.band_calibration from anon, authenticated;

create index if not exists band_calibration_band_date_idx
  on public.band_calibration (band_key, as_of_date desc);

commit;
