-- 074_gate_requires_independent_anchor.sql
--
-- THE GATE REFUSES TO SCORE A MODEL AGAINST ITS OWN SELECTION RULE.
--
-- This is a PRECONDITION, not a per-architecture note. It runs before sample
-- size, before takeability, before CLV, because a PASS on a self-referential
-- benchmark is not a weak result — it is not a result. Migration 073 has the
-- measurement that forced it.
--
-- Three ways to HOLD:
--   1. no declaration           — an undeclared anchor cannot be shown to differ
--   2. identical anchor         — same book set, same de-vig, same line kind
--   3. mixed anchors in a group — two benchmarks averaged into one figure
--
-- And one way to PASS with a warning: the book sets INTERSECT but the anchors
-- are not identical. That is the DIXON_COLES case and it is real, not
-- hypothetical. Its selection anchor is `devigTwoWay(best over, best under)` —
-- the Shin de-vig of the bettable panel's own best two-way vector — and EVERY
-- BTTS closing line in `closing_lines` has basis='consensus', the median of
-- that same panel, because Pinnacle does not price BTTS. Not the same yardstick;
-- not a different one either. Say so rather than let it read clean.
--
-- BOOK SETS ARE COMPARED AS ACTUAL BOOK LISTS, not as labels. A scope renamed,
-- narrowed or widened cannot silently stop overlapping.
--
-- THE ANCHOR TRAVELS WITH THE DATA. `paper_trades.scoring_anchor` is a column,
-- not a gate parameter, because a default parameter can be overridden by
-- whoever calls the gate and a column cannot. The row records which benchmark
-- produced its own no_vig_clv.

create table if not exists scoring_anchor (
  anchor_key   text primary key,
  book_set     text[] not null,
  devig_method text not null,
  line_kind    text not null,
  source_table text not null,
  description  text
);

comment on table scoring_anchor is
  'Every benchmark a CLV figure can be measured against, described by the three things that make a yardstick: WHICH BOOKS, WHICH DE-VIG, WHICH LINE. Timestamp is deliberately NOT part of the key — "the same line at a later moment" is exactly the tautology paper_trade_gate refuses.';

insert into scoring_anchor (anchor_key, book_set, devig_method, line_kind, source_table, description) values
  ('pinnacle_anchor', array['pinnacle'], 'shin', 'own_vector', 'closing_lines',
   'Pinnacle''s own last strictly-pre-kickoff vector, Shin-de-vigged. The platform''s definition of fair value — which is why it cannot score a model that selects against it.'),
  ('bettable_panel_consensus', array['bet365','williamhill','betvictor','unibet_uk','betfair_sb_uk','paddypower','skybet','betano','10bet','dafabet','sbo','marathonbet'],
   'shin', 'panel_median', 'closing_lines',
   'closing_lines basis=''consensus'': the median across the bettable panel when Pinnacle did not quote. This is what every BTTS closing line is, because Pinnacle does not price BTTS.'),
  ('independent_consensus', array['bet365','williamhill','betvictor','unibet_uk','betfair_sb_uk','paddypower','skybet','betano','10bet','dafabet','sbo','marathonbet'],
   'shin', 'panel_median', 'closing_lines_independent',
   'Median pre-kickoff close across the bettable panel with PINNACLE EXCLUDED, Shin-de-vigged, minimum 5 books. Built so a Pinnacle-anchored selection rule can be scored against something it never referenced.')
on conflict (anchor_key) do update
  set book_set = excluded.book_set, devig_method = excluded.devig_method,
      line_kind = excluded.line_kind, source_table = excluded.source_table,
      description = excluded.description;

create table if not exists model_selection_anchor (
  model        text not null,
  market       text not null,
  book_set     text[] not null,
  devig_method text not null,
  line_kind    text not null,
  declared_at  timestamptz not null default now(),
  notes        text,
  primary key (model, market)
);

comment on table model_selection_anchor is
  'What each model optimises against when it chooses a selection. A model with no row here cannot be gated — paper_trade_gate HOLDs rather than PASSing, because an undeclared anchor cannot be shown to differ from the scoring anchor.';

insert into model_selection_anchor (model, market, book_set, devig_method, line_kind, notes) values
  ('MARKET_ANCHORED','h2h', array['pinnacle'], 'shin', 'own_vector',
   'computeValues.js: edge = anchorProb[outcome] * best_bettable_price - 1, where anchorProb is fairFromAnchor(pinnacle) in lib/marketAnchor.js. The fair line IS Shin-de-vigged Pinnacle.'),
  ('DIXON_COLES','totals', array['bet365','williamhill','betvictor','unibet_uk','betfair_sb_uk','paddypower','skybet','betano','10bet','dafabet','sbo','marathonbet'],
   'shin', 'panel_best_vector',
   'lib/secondaryMarkets.js: the DC sheet is anchored to marketNoVigOver() and then shrunk toward devigTwoWay(best over, best under) — the Shin de-vig of the bettable panel''s own best two-way vector.'),
  ('DIXON_COLES','btts', array['bet365','williamhill','betvictor','unibet_uk','betfair_sb_uk','paddypower','skybet','betano','10bet','dafabet','sbo','marathonbet'],
   'shin', 'panel_best_vector',
   'Same shrinkToMarket path as totals, against devigTwoWay(best yes, best no).'),
  ('API_PREDICTIVE','h2h', array[]::text[], 'none', 'model_probability',
   'Five distinct probabilities keyed to price bands. No price line is de-vigged; the edge is modelProb * odds - 1.'),
  ('LAMBDA_MC','h2h', array[]::text[], 'none', 'model_probability',
   'Edge from the lambda Monte-Carlo price sheet. No de-vigged price line in the selection rule.')
on conflict (model, market) do update
  set book_set = excluded.book_set, devig_method = excluded.devig_method,
      line_kind = excluded.line_kind, notes = excluded.notes, declared_at = now();

alter table paper_trades add column if not exists scoring_anchor text not null default 'pinnacle_anchor';
do $$ begin
  alter table paper_trades add constraint paper_trades_scoring_anchor_fk
    foreign key (scoring_anchor) references scoring_anchor(anchor_key);
exception when duplicate_object then null; end $$;

comment on column paper_trades.scoring_anchor is
  'Which entry in scoring_anchor produced this row''s closing_price / clv / no_vig_clv. paper_trade_gate reads it to check the benchmark is not the model''s own selection anchor.';

-- The return type gains `scoring_anchor`, so the old signature must go first.
drop function if exists public.paper_trade_gate(integer, numeric, numeric, numeric, numeric, numeric);

create or replace function public.paper_trade_gate(
  p_min_fixtures    integer default 150,
  p_min_clv         numeric default 0.005,
  p_min_clv_zscore  numeric default 2.0,
  p_min_takeable    numeric default null,
  p_min_coverage    numeric default null,
  p_detect          numeric default 0.010
)
returns table(
  model text, market text, settled integer, settled_fixtures integer,
  required_fixtures integer, clustered_sd_pct numeric, takeable_pct numeric,
  coverage_pct numeric, avg_clv_pct numeric, clv_takeable_pct numeric,
  clv_zscore numeric, yield_pct numeric, scoring_anchor text, verdict text
)
language sql stable
set search_path to 'public', 'pg_catalog'
as $function$
  with r as (
    select pt.*,
           public.price_was_takeable(pt.match_id, pt.market, pt.market_line,
                                     pt.selection, pt.logged_at, pt.price_taken) as verdict_raw
    from public.paper_trades pt
  ),
  t as (
    select r.*, coalesce(r.verdict_raw, false) as takeable, (r.verdict_raw is not null) as checkable
    from r
  ),
  -- Which benchmark produced this group's CLV. More than one and the figure is
  -- an average over two yardsticks, which is not a figure.
  anc as (
    select model, market, count(distinct scoring_anchor)::int as n_anchors, min(scoring_anchor) as anchor_key
    from t group by 1, 2
  ),
  ind as (
    select anc.model, anc.market, anc.n_anchors, anc.anchor_key,
           sa.book_set as score_books, sa.devig_method as score_devig, sa.line_kind as score_line,
           (msa.model is null) as undeclared,
           -- Set equality both ways: @> and <@ together, so order and
           -- duplicates cannot make two identical panels look different.
           (sa.book_set @> msa.book_set and sa.book_set <@ msa.book_set
            and sa.devig_method = msa.devig_method and sa.line_kind = msa.line_kind) as identical,
           (sa.book_set && msa.book_set) as books_overlap
    from anc
    left join public.scoring_anchor sa on sa.anchor_key = anc.anchor_key
    left join public.model_selection_anchor msa on msa.model = anc.model and msa.market = anc.market
  ),
  fx as (
    select model, market, match_id, avg(no_vig_clv) as fv
    from t where no_vig_clv is not null group by 1, 2, 3
  ),
  cl as (
    select model, market, count(*)::int as n_fx, avg(fv) as mu, stddev(fv)::numeric as sd
    from fx group by 1, 2
  ),
  s as (
    select t.model, t.market,
      count(*) filter (where t.result in ('win','loss'))::int as n,
      count(*)::int as n_total,
      count(*) filter (where t.checkable)::int as n_checkable,
      count(*) filter (where t.takeable)::int  as n_takeable,
      count(t.no_vig_clv)::int                 as n_clv,
      avg(t.no_vig_clv) filter (where t.takeable) as clv_takeable,
      sum(t.pl_units) as pl
    from t group by 1, 2
  ),
  z as (
    select s.*, cl.n_fx, cl.mu, cl.sd,
      cl.mu / nullif(cl.sd / sqrt(nullif(cl.n_fx, 0))::numeric, 0) as zscore,
      s.n_takeable::numeric  / nullif(s.n_total, 0) as takeable_rate,
      s.n_checkable::numeric / nullif(s.n_total, 0) as coverage_rate,
      case when cl.n_fx >= 2 and cl.sd is not null
           then cl.sd * (1 + (1.6449 / sqrt(2 * (cl.n_fx - 1)))::numeric) end as sd_hi
    from s join cl on cl.model = s.model and cl.market = s.market
  ),
  g as (
    select z.*, ind.n_anchors, ind.anchor_key, ind.score_books, ind.score_devig, ind.score_line,
           ind.undeclared, ind.identical, ind.books_overlap,
      greatest(p_min_fixtures,
               coalesce(ceil(power(2.802 * z.sd_hi / nullif(p_detect, 0), 2))::int, p_min_fixtures)) as req_fx
    from z join ind on ind.model = z.model and ind.market = z.market
  )
  select g.model, g.market, g.n, g.n_fx, g.req_fx,
    round(100 * g.sd, 2), round(100 * g.takeable_rate, 1), round(100 * g.coverage_rate, 1),
    round(100 * g.mu, 2), round(100 * g.clv_takeable, 2), round(g.zscore, 2),
    round(100 * g.pl / nullif(g.n, 0), 2),
    g.anchor_key,
    case
      -- ── PRECONDITION: the benchmark must not be the selection rule ────────
      when g.n_anchors > 1
        then format('HOLD - %s different scoring anchors mixed into one CLV figure', g.n_anchors)
      when g.anchor_key is null or g.score_books is null
        then format('HOLD - scoring anchor %s is not in scoring_anchor, cannot be checked for independence',
                    coalesce(g.anchor_key, 'null'))
      when g.undeclared
        then format('HOLD - %s/%s has not declared a selection anchor, so independence from the scoring anchor cannot be shown',
                    g.model, g.market)
      when g.identical
        then format('HOLD - scoring anchor (%s) IS the declared selection anchor: same books, %s de-vig, %s. CLV would be the selection rule measured against itself',
                    g.anchor_key, g.score_devig, g.score_line)
      -- ── then the existing questions, in order ─────────────────────────────
      when g.n_fx < g.req_fx
        then format('HOLD - %s settled fixtures, needs %s (powered for +%s%% at sd %s%%)',
                    g.n_fx, g.req_fx, round(100 * p_detect, 1), coalesce(round(100 * g.sd, 2)::text, 'n/a'))
      when g.n_clv = 0
        then 'HOLD - no closing line on any settled trade, CLV unmeasurable'
      when g.n_checkable = 0
        then 'HOLD - takeability unmeasurable on every trade, no contemporaneous quotes'
      when p_min_coverage is not null and g.coverage_rate < p_min_coverage
        then format('HOLD - takeability measurable on only %s%% of trades, needs %s%%',
                    round(100 * g.coverage_rate, 1), round(100 * p_min_coverage, 1))
      when p_min_takeable is not null and g.takeable_rate < p_min_takeable
        then format('FAIL - only %s%% of prices were takeable, needs %s%%',
                    round(100 * g.takeable_rate, 1), round(100 * p_min_takeable, 1))
      when g.mu < p_min_clv
        then format('FAIL - clustered no-vig CLV %s%% below the %s%% bar', round(100 * g.mu, 2), round(100 * p_min_clv, 2))
      when g.zscore is null or g.zscore < p_min_clv_zscore
        then format('FAIL - clustered CLV z %s below %s', coalesce(round(g.zscore, 2)::text, 'n/a'), p_min_clv_zscore)
      else
        format('PASS (anchor %s%s; takeability %s%% over %s%% coverage%s)',
               g.anchor_key,
               case when g.books_overlap then ' - WARNING: shares books with the selection anchor, independence is partial' else '' end,
               round(100 * g.takeable_rate, 1), round(100 * g.coverage_rate, 1),
               case when p_min_takeable is null then ' - not yet thresholded' else '' end)
    end
  from g order by g.model, g.market;
$function$;

comment on function public.paper_trade_gate(integer, numeric, numeric, numeric, numeric, numeric) is
  'Publication gate. Asks, in order: is the benchmark independent of the selection rule; is the sample big enough for its own variance; is the price takeable; is the clustered CLV real. The independence question is first because a PASS on a self-referential benchmark is not a weak result, it is not a result.';

-- ── PROBED, NOT REASONED ABOUT (19 Aug 2026, rolled-back transaction) ────────
-- All six branches were driven with synthetic paper_trades over real fixtures
-- and the transaction rolled back; paper_trades is still at 0 rows.
--
--   scoring anchor == selection anchor  -> HOLD "scoring anchor (pinnacle_anchor)
--                                          IS the declared selection anchor..."
--   model with no declaration           -> HOLD "...has not declared a selection anchor..."
--   two anchors in one group            -> HOLD "2 different scoring anchors mixed..."
--   anchor absent from scoring_anchor   -> HOLD "...not in scoring_anchor..."
--   DIXON_COLES/btts on the panel
--     consensus (books overlap, line
--     kind differs)                     -> PASS "...- WARNING: shares books with the
--                                          selection anchor, independence is partial..."
--   MARKET_ANCHORED on independent_
--     consensus (no book overlap)       -> PASS, no warning
