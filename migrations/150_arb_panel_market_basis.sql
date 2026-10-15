-- 150: an arbitrage best-price panel gets a market side from a vector that has
-- a margin, and says which one.
--
-- WHY (15 Oct 2026). 121 MARKET_ANCHORED value_signals carried an edge and no
-- score: the best price per outcome across books summed to <= 1 (an arb across
-- books, commonest close to kickoff), devigProbs correctly refused to de-vig
-- it, so market_prob was null and scoreSignal returned an empty verdict. The
-- settled record says that cohort is the architecture's strongest (n=105,
-- no-vig CLV +6.4%, 94% beat the close, against n=558, +2.6%, 78% scored), so
-- the engine now takes the market side from the advised book's own full 1X2
-- line, then from the median panel, and skips the row only when neither is
-- de-viggable and coherent (computeValues.js marketSide()).
--
-- Two additive changes, nothing rewritten:
--   * gap_basis admits 'advised_book_line' and 'median_panel' beside
--     'implied' and 'devigged'. 'devigged' keeps meaning the best-price panel;
--     it is not renamed, because existing rows and two readers
--     (postToX.js, eve-frontend lib/signals.ts) test for exactly that string.
--   * is_arb_panel boolean not null default false. Existing rows read false,
--     INCLUDING the historical arb rows — this migration does not backfill;
--     identify those by mxs is null and model_prob is null instead.
--
-- The coherence trigger (score_needs_coherent_market_prob) is unchanged and
-- still applies to both new bases; the engine checks coherence first so a
-- fallback that would be stripped is not written.

begin;

alter table public.value_signals
  drop constraint if exists value_signals_gap_basis_check;
alter table public.value_signals
  add constraint value_signals_gap_basis_check
  check (gap_basis is null
         or gap_basis = any (array['implied', 'devigged', 'advised_book_line', 'median_panel']));

alter table public.value_signals
  add column if not exists is_arb_panel boolean not null default false;

comment on column public.value_signals.is_arb_panel is
  'True when the best-price panel at detection had overround <= 1, so market_prob came from a fallback vector named in gap_basis (migration 150). Not backfilled: rows before 150 read false.';

do $$
declare n int;
begin
  -- Nothing existing may have moved: no row carries a new basis or the flag.
  select count(*) into n from public.value_signals
   where is_arb_panel or gap_basis in ('advised_book_line', 'median_panel');
  if n <> 0 then raise exception '150: % existing rows already carry a new basis/flag', n; end if;
end $$;

commit;
