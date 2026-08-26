
-- 103 — the performance record is kept PER BAND, and the bands never merge.
--
-- Owner decision, 26 Aug 2026: broadcast and record EDGE, but report it in its
-- own table rather than folded into the headline.
--
-- ─────────────────────────────────────────────────────────────────────────────
-- WHY THEY MUST NOT MERGE — the arithmetic, since the intuition points the
-- other way. Combining the two backed bands over the settled book to 25 Aug:
--
--                        yield    clustered z   no-vig CLV   fixtures
--   PRIME only          +32.71%       1.72        +0.86%        38
--   EDGE only           +18.45%       0.91        -2.02%        44
--   PRIME + EDGE        +23.94%       1.50        -0.93%        72
--
-- Merging LOWERS the headline yield, LOWERS the z, and FLIPS CLV from positive
-- to negative. The only things it improves are total units and how fast the
-- 100-fixture gate is reached — and reaching a publication bar sooner by adding
-- a weaker cohort is the bar not doing its job.
--
-- THE GATE IS PER BAND FOR THE SAME REASON. One gate over a merged pool can
-- always be cleared early by publishing more of whatever is running hot, which
-- makes the band mix a lever on the published number. Each band earns its own
-- 100 fixtures or stays unpublished.
--
-- The `all_backed` row IS computed, and is marked published = false. It exists
-- so the dilution above stays visible internally rather than being rediscovered
-- every few months. Nothing user-facing may read a row with published = false.
--
-- Reads value_signals only, so it cannot disagree with the engine — which is
-- why this can ship ahead of the ladder in 102. The band definitions below
-- MIRROR lib/signalTier.js; see band_calibration's comment on why that
-- duplication is deliberate.

begin;

create table if not exists public.performance_band (
  band_key           text primary key,
  band_label         text        not null,
  sort_order         int         not null,
  backed             boolean     not null,
  published          boolean     not null,
  edge_min           numeric,
  edge_max           numeric,
  odds_min           numeric,
  odds_max           numeric,
  tracked_from       date        not null,
  total_signals      int         not null,
  settled_signals    int         not null,
  settled_fixtures   int         not null,
  wins               int         not null,
  losses             int         not null,
  win_rate           numeric,
  breakeven_strike   numeric,
  avg_odds           numeric,
  avg_edge           numeric,
  yield              numeric,
  units              numeric,
  yield_se           numeric,
  yield_z            numeric,
  avg_no_vig_clv     numeric,
  clv_n              int,
  top_fixture_share  numeric,
  insufficient       boolean     not null,
  insufficient_reason text,
  calculated_at      timestamptz not null default now()
);

comment on table public.performance_band is
  'The published record, kept SEPARATELY PER BAND. Bands are never summed for '
  'publication: merging PRIME and EDGE lowers yield, lowers z and flips CLV negative '
  '(see migration 103). The 100-settled-fixture gate applies PER BAND — one gate over a '
  'merged pool can be cleared early by publishing more of whatever is running hot. '
  'Rows with published = false are internal and must never reach a user-facing surface.';

comment on column public.performance_band.breakeven_strike is
  'The strike rate this band needs at its average price just to break even (1/avg_odds). '
  'Exists because a strike rate above 50%% reads as good and means nothing on its own — '
  'at 2.35 the bar is 42.6%%, at 1.60 it is 62.5%%. Always show it beside win_rate.';

comment on column public.performance_band.yield_z is
  'FIXTURE-CLUSTERED (CR0). Up to fifteen signals fire on one match; treating them as '
  'independent bets shrinks the SE by roughly root-fifteen and turns noise into a result.';

alter table public.performance_band enable row level security;

drop policy if exists performance_band_anon_read on public.performance_band;
create policy performance_band_anon_read on public.performance_band
  for select using (published);

drop policy if exists performance_band_service on public.performance_band;
create policy performance_band_service on public.performance_band
  for all to service_role using (true) with check (true);

grant select on public.performance_band to anon, authenticated;

commit;
