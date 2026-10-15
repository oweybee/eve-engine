-- 150 — MARKET_ANCHORED_TOTALS: the Pinnacle-anchored method on over/under,
-- as a SEPARATE, UNPUBLISHED model. Paper-traded only.
--
-- WHAT IT IS. The h2h rule — edge = Shin-de-vigged Pinnacle prob x best
-- takeable price - 1 — applied one half-goal totals line at a time, against
-- other books quoting THE SAME line. lib/marketAnchorTotals.js decides;
-- paperTradeTotals.js (an engine.yml step) logs every hit through
-- insert_paper_trade() and settles through settle_paper_trade().
--
-- WHY A NEW NAME. `publish` is per architecture and MARKET_ANCHORED's is true.
-- A totals row written under that name would be published the moment it was
-- written. This name has publish = false here and is absent-or-false in both
-- repos' publication maps, so it fails closed everywhere.
--
-- ── TWO DEPARTURES FROM THE BRIEF, BOTH MEASURED (15 Oct 2026) ──────────────
--
-- 1. THE SCORING ANCHOR IS independent_consensus, NOT pinnacle_anchor.
--    paper_trade_gate() (074) HOLDS any model whose scoring anchor IS its
--    selection anchor: "CLV would be the selection rule measured against
--    itself". The selection anchor declared below is {pinnacle}/shin/
--    own_vector, which is pinnacle_anchor exactly — so scoring against
--    Pinnacle's close would put this model on HOLD permanently and the gate
--    could never say PASS. independent_consensus is the panel median with
--    Pinnacle EXCLUDED, built for exactly this case, it carries totals
--    (7,826 rows, current to today), and it is insert_paper_trade()'s default
--    — the anchor every existing paper trade, MARKET_ANCHORED h2h included,
--    is scored on. Pinnacle's own totals close is still in closing_lines
--    (basis 'anchor', 7,454 rows) for anyone who wants that number; it is
--    just not the one the gate may open on.
--
-- 2. NOTHING IS WRITTEN TO value_signals, SO ITS CHECK IS NOT WIDENED.
--    Storable is surfaced here. These read EVERY settled value_signals row
--    with no architecture filter:
--        band_calibration (refresh_band_calibration)
--        bookmaker_prime_performance()   — served to Plus
--        compute_performance_summary()
--    so a settled totals row in value_signals would land in published
--    records whatever `publish` says. The score (model_prob, market_prob,
--    prob_gap, mxs, mxs_band, model_sigma) goes on the paper trade instead —
--    three columns are added below for the half insert_paper_trade() had no
--    room for. Leaving MARKET_ANCHORED_TOTALS OUT of
--    value_signals_model_architecture_check is now a guard: a writer that
--    tried would be refused. Widening it is the migration that comes with
--    publishing, not before.
--
-- ── WHAT IS NOT TOUCHED ─────────────────────────────────────────────────────
-- MARKET_ANCHORED (h2h): its calibration row, publish flag, sigma and anchor
-- declaration are asserted unmoved below. No scoring maths or band cut-point
-- changes; the engine's scoreSignal gains a sigma entry for the new name only.

begin;

alter table public.paper_trades
  add column if not exists market_prob numeric(6,4),
  add column if not exists prob_gap    numeric,
  add column if not exists mxs_band    text;

comment on column public.paper_trades.market_prob is
  'De-vigged market probability of the selection (the score''s market side). Written by paperTradeTotals.js; null on rows logged before 150.';

insert into public.model_selection_anchor (model, market, book_set, devig_method, line_kind, notes)
values ('MARKET_ANCHORED_TOTALS', 'totals', array['pinnacle'], 'shin', 'own_vector',
        'lib/marketAnchorTotals.js: edge = shinDevig(pinnacle over, under)[side] * best takeable price at the SAME half-goal line - 1. The fair line IS Shin-de-vigged Pinnacle; no interpolation between lines.')
on conflict (model, market) do update
  set book_set = excluded.book_set, devig_method = excluded.devig_method,
      line_kind = excluded.line_kind, notes = excluded.notes;

-- publish is deliberately NOT in the update list: a re-run can never move a
-- publication ruling (the 088 rule).
insert into public.model_calibration (model_architecture, sigma_p, sigma_source, z_gate, n_settled, publish, notes, calibrated_at)
values ('MARKET_ANCHORED_TOTALS', 0.03, 'floor', 1, 0, false,
        'UNPROVEN. MARKET_ANCHORED''s Pinnacle-anchored rule extended to over/under (half-goal lines only, same line only), added 15 Oct 2026 for paper trading. Nothing measured: n_settled=0, sigma 3pp is the same conservative floor MARKET_ANCHORED carries, not an estimate. Writes paper_trades only — never value_signals. publish=false until paper_trade_gate() returns PASS and the owner rules.',
        now())
on conflict (model_architecture) do update
  set sigma_p = excluded.sigma_p, sigma_source = excluded.sigma_source,
      notes = excluded.notes, calibrated_at = excluded.calibrated_at;

do $$
declare v text;
begin
  if (select publish from model_calibration where model_architecture = 'MARKET_ANCHORED_TOTALS') is distinct from false then
    raise exception '150: MARKET_ANCHORED_TOTALS must not publish';
  end if;
  if (select publish from model_calibration where model_architecture = 'MARKET_ANCHORED') is distinct from true
     or (select sigma_p from model_calibration where model_architecture = 'MARKET_ANCHORED') <> 0.03 then
    raise exception '150: MARKET_ANCHORED calibration moved';
  end if;
  if not exists (select 1 from model_selection_anchor where model = 'MARKET_ANCHORED' and market = 'h2h'
                   and book_set = array['pinnacle'] and devig_method = 'shin' and line_kind = 'own_vector') then
    raise exception '150: MARKET_ANCHORED h2h selection anchor moved';
  end if;
  select pg_get_constraintdef(oid) into v from pg_constraint where conname = 'value_signals_model_architecture_check';
  if v like '%MARKET_ANCHORED_TOTALS%' then
    raise exception '150: value_signals must not admit MARKET_ANCHORED_TOTALS while it is unpublished';
  end if;
  -- The gate can judge it: declared selection anchor, and it is NOT the
  -- default scoring anchor, so the independence check does not HOLD it.
  if exists (select 1 from model_selection_anchor msa join scoring_anchor sa
               on sa.anchor_key = 'independent_consensus'
              where msa.model = 'MARKET_ANCHORED_TOTALS' and msa.market = 'totals'
                and (sa.book_set && msa.book_set)) then
    raise exception '150: independent_consensus overlaps the selection anchor';
  end if;
end $$;

commit;

-- Health read:
--   select * from paper_trade_gate() where model = 'MARKET_ANCHORED_TOTALS';
--   select date_trunc('day', logged_at) d, count(*), count(settled_at) settled,
--          avg(pl_units) filter (where settled_at is not null) yield,
--          avg(no_vig_clv) clv_independent
--     from paper_trades where model = 'MARKET_ANCHORED_TOTALS' group by 1 order by 1;
-- Pinnacle-close CLV, ad hoc, for comparison only (the gate does not open on it):
--   select avg(ln(pt.price_taken / cl.no_vig_odds))
--     from paper_trades pt join closing_lines_valid cl
--       on cl.match_id = pt.match_id and cl.market = 'totals' and cl.basis = 'anchor'
--      and cl.selection = pt.selection and cl.market_line = pt.market_line
--    where pt.model = 'MARKET_ANCHORED_TOTALS' and pt.settled_at is not null;
