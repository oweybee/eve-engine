-- Backfilled from the Supabase migration ledger (supabase_migrations.schema_migrations)
-- version 20260829103259, name 114_paper_harness_anchors. Applied directly to production; this file was
-- missing from the repo. Statements copied verbatim from the ledger on 25 Oct 2026.
-- DO NOT re-apply: it is already in the database. Nothing runs this folder.

-- 114_paper_harness_anchors.sql
-- Establishes paper_trades as the pre-flight gate for model promotion, with
-- closing_lines_independent_valid as the universal scoring benchmark.
--
-- model_selection_anchor already carries all five model/market pairs, so there
-- is nothing to insert there. The real change is the SCORING side:
-- paper_trades.scoring_anchor defaulted to 'pinnacle_anchor', which is
-- byte-identical to MARKET_ANCHORED's selection anchor and trips the gate's
-- self-reference refusal.
--
-- corners and bookings are deliberately not declared: closing_lines_independent
-- holds h2h, btts and totals only, and none of the four architectures produces a
-- corners or bookings signal.

alter table public.paper_trades
  alter column scoring_anchor set default 'independent_consensus';

comment on column public.paper_trades.scoring_anchor is
  'Which benchmark this trade''s clv and no_vig_clv were measured against. FK to scoring_anchor. Defaults to independent_consensus (12-book panel, Shin, panel median, Pinnacle excluded) since migration 114: the previous default, pinnacle_anchor, is identical to MARKET_ANCHORED''s declared selection anchor, and paper_trade_gate refuses a CLV measured against the selection rule itself.';

-- Register the promotion candidates.
-- NOTE: paper_models' primary key is (model) alone, so it cannot hold two
-- markets for one model. DIXON_COLES runs both totals and btts; only one can be
-- registered. paper_trade_gate does not read paper_models -- it joins
-- paper_trades to model_selection_anchor and scoring_anchor -- so this is a
-- registry entry, not a gating requirement.

insert into public.paper_models (model, version, market, status, hypothesis, notes)
values
  ('MARKET_ANCHORED', 'v1', 'h2h', 'testing',
   'Shin-de-vigged Pinnacle is closer to true than the bettable panel, so where the panel is longer than Pinnacle implies, the panel price is wrong.',
   'Scored against independent_consensus, which excludes Pinnacle. Selection anchor is {pinnacle}; the two are disjoint, so the CLV is not self-referential.'),
  ('API_PREDICTIVE', 'v1', 'h2h', 'testing',
   'A model probability built from form, lineups and match stats disagrees with the market often enough to be priced against it.',
   'Selection anchor is a pure model probability with no book input, so independence from any price benchmark is total.'),
  ('LAMBDA_MC', 'v1', 'h2h', 'testing',
   'A goal-rate simulation produces a 1X2 distribution the market prices lazily.',
   'Selection anchor is a pure model probability. Smallest sample of the four.'),
  ('DIXON_COLES', 'v1', 'totals', 'testing',
   'Attack/defence fitted jointly by weighted MLE prices total goals better than the panel does.',
   'Also runs btts; paper_models PK is (model) so only totals is registered here. WARNING: the selection anchor uses the SAME 12-book panel as independent_consensus (differing only in panel_best_vector vs panel_median), so paper_trade_gate will PASS with a partial-independence warning rather than cleanly.')
on conflict (model) do update
  set version    = excluded.version,
      market     = excluded.market,
      status     = excluded.status,
      hypothesis = excluded.hypothesis,
      notes      = excluded.notes;
