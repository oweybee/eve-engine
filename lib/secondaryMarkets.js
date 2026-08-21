'use strict';

/**
 * lib/secondaryMarkets.js — price O/U and BTTS, then surface cross-market value
 * signals.
 *
 *   Goals O/U + BTTS → Dixon-Coles, anchored to the consensus 1X2 (high trust).
 *
 * Corners and cards were removed in Phase 0 of the engine consolidation (18 Aug
 * 2026): six signals ever, none published, none tested against prices, and not
 * a function of the goal lambdas so they could never join the goals engine.
 *
 * A signal fires when the model's probability for a selection, priced against
 * the best available market odds, clears the EV threshold. Pure & testable:
 * all DB access happens in the caller (computeValues).
 */

const dc = require('./dixonColes');
const { shinDevig } = require('./devig');
// The book policy, not a second copy of it. `bestTwoWay` builds a price vector
// that gets de-vigged and written to `market_prob`, exactly as computeConsensus
// does for h2h, so it has to answer "which books count" the same way.
const { BETTABLE_BOOKS } = require('./marketAnchor');

const EV_THRESHOLD        = parseFloat(process.env.EV_THRESHOLD || '0.005');
const TYPICAL_MATCH_CARDS = parseFloat(process.env.TYPICAL_MATCH_CARDS || '4'); // ~2 cards/team
const REF_TILT_MIN = 0.80, REF_TILT_MAX = 1.25;

// How much to trust the pure team-stat Poisson for the DATA-DRIVEN markets
// vs the market's own no-vig price. Those models ran on sparse,
// patchy API stats and could otherwise emit wildly off-market probabilities
// (e.g. 92% Under 3.5 cards while the market prices Over) — a misinformation
// risk. Shrinking toward the market caps how far a signal can diverge: at 0.4
// the model can't move the probability more than ~60% of the way from the
// market, so a thin-data outlier can no longer publish a huge fake edge.
const SECONDARY_DATA_TRUST = clampUnit(parseFloat(process.env.SECONDARY_DATA_TRUST || '0.4'));

// Palpable-error guard, same threshold and same shape as computeValues'. A lone
// book more than this multiple off the median is a mistake, not a price.
const OUTLIER_MULT = parseFloat(process.env.ODDS_OUTLIER_MULT || '3');

const BETTABLE_SET = new Set(BETTABLE_BOOKS);

// Trust for the goals-derived markets (O/U, BTTS). The Dixon-Coles sheet is fit
// to the 1X2 market, so pricing O/U or BTTS off it is really claiming to know
// goals better than the goals market itself — and a Poisson/DC fit to 1X2
// systematically OVER-states P(both teams score), which was leaking a near
// constant +edge onto BTTS-yes across the whole board. We now (a) anchor the
// (λ,μ) fit to the market's O/U line and (b) shrink O/U + BTTS toward the
// market's no-vig price. Because best price beats the no-vig line, a genuine
// price edge survives the shrink while the structural model bias does not.
const GOALS_MARKET_TRUST = clampUnit(parseFloat(process.env.GOALS_MARKET_TRUST || '0.4'));

// ── helpers ──────────────────────────────────────────────────────────────────
const num   = x => (x == null || x === '' || !Number.isFinite(Number(x)) ? null : Number(x));
const clamp = (x, lo, hi) => Math.max(lo, Math.min(hi, x));
function clampUnit(x) { return Number.isFinite(x) ? Math.max(0, Math.min(1, x)) : 0.4; }
const ev    = (p, odds) => p * odds - 1;
const meanDefined = arr => { const v = arr.filter(x => x != null && Number.isFinite(x)); return v.length ? v.reduce((a, b) => a + b, 0) / v.length : null; };

/** Market's no-vig P(over) from the two-way prices, or null if unpriced. */
function marketNoVigOver(over, under) {
  const o = num(over?.odds), u = num(under?.odds);
  if (o == null || u == null || o <= 1 || u <= 1) return null;
  const io = 1 / o, iu = 1 / u;
  return io / (io + iu);
}

/**
 * The two-way market's Shin-de-vigged probabilities — the MARKET SIDE of the
 * score for both legs. Not `marketNoVigOver` above, which is proportional: that
 * one only has to be good enough to shrink a thin-data model toward, whereas
 * this one is written to the ledger and compared against a measured error bar,
 * and lib/devig.js is explicit that proportional de-vig manufactures edge on the
 * longer leg. Returns null on an incomplete market rather than normalising one
 * priced leg to certainty.
 *
 * @returns {{over:number, under:number}|null}
 */
function devigTwoWay(over, under) {
  const r = shinDevig([over?.odds, under?.odds]);
  if (!r.probs) return null;
  // Belt and braces with `bestTwoWay`, which already refuses a line whose
  // two-way overround is at or below 1. `shinDevig` normalises such a vector
  // and raises `arbitrage` rather than refusing — correct for a solver, wrong
  // here, because normalising a sub-1 vector scales both legs ABOVE their own
  // implied probability and reports value on the over and the under at once.
  // Null makes the row unscorable, which is the honest answer.
  if (r.arbitrage) return null;
  return { over: r.probs[0], under: r.probs[1] };
}
/** Shrink a data-model P(over) toward the market's no-vig price (anti-off-market). */
function shrinkToMarket(pModel, over, under, trust = SECONDARY_DATA_TRUST) {
  const pMkt = marketNoVigOver(over, under);
  if (pMkt == null) return pModel;
  return clamp(trust * pModel + (1 - trust) * pMkt, 0, 1);
}

function poissonPMF(k, lambda) {
  if (lambda <= 0) return k === 0 ? 1 : 0;
  let log = k * Math.log(lambda) - lambda;
  for (let i = 1; i <= k; i++) log -= Math.log(i);
  return Math.exp(log);
}
/** P(total > line) for an integer Poisson count (line is a .5 handicap). */
function poissonOver(lambda, line) {
  const maxK = Math.floor(line);
  let cdf = 0;
  for (let k = 0; k <= maxK; k++) cdf += poissonPMF(k, lambda);
  return clamp(1 - cdf, 0, 1);
}

/**
 * Best available price for a two-way market stored as
 *   over/yes → home_odds, under/no → away_odds (engine convention).
 *
 * THE VECTOR THIS RETURNS IS DE-VIGGED AND WRITTEN TO `market_prob`, so it has
 * to be a market that EXISTED. Until 18 Aug 2026 it was not. This function took
 * `max(home_odds)` and `max(away_odds)` over every row the caller handed it —
 * and computeValues hands it TWENTY-FOUR HOURS of price history, from every
 * book on the feed, including `apifootball_live` (an IN-PLAY feed, 2,699 totals
 * rows in the last fortnight) and the excluded books. So the "market" being
 * de-vigged paired the best over seen at one book on Tuesday morning with the
 * best under seen at another book on Tuesday evening, one of them in-play.
 *
 * Measured across 2,802 live totals vectors, the mean overround of what it
 * built was 0.9844 — BELOW ONE — and 778 of them were outright synthetic
 * arbitrages, the worst at 0.361. De-vigging normalises a vector to sum to 1,
 * so a sub-1 vector is scaled UP and `market_prob × detected_odds` lands ABOVE
 * 1: the "fair" line says the outcome is likelier than the price you can take,
 * and BOTH legs clear the EV threshold at once. 60 totals fixtures and 13 BTTS
 * fixtures in `value_signals` have both sides flagged as value. That is not a
 * close call, it is arithmetically impossible, and it was on the board.
 *
 * Worse, the ranking below used to pick the line with the LOWEST overround,
 * which is a direct search for the most corrupted vector on the fixture.
 *
 * The h2h path never had any of this, because `computeConsensus` already
 * deduped to each book's LATEST quote, filtered to bettable books, and dropped
 * palpable outliers. This function did none of the three. It now does all
 * three, in the same order and at the same thresholds — two ways of building a
 * price vector is how the two paths came to disagree in the first place.
 *
 * @returns {{line, over:{odds,book}, under:{odds,book}} | null}
 */
function bestTwoWay(oddsRows, market) {
  const rows = (oddsRows ?? []).filter(r => (r.market ?? 'h2h') === market);
  if (!rows.length) return null;

  const lineOf = r => (r.market_line != null ? num(r.market_line) : null);
  const lineKey = lv => (lv == null ? 'null' : String(lv));

  // ── 1. One quote per book per line: the LATEST one. ──────────────────────
  // Mirrors computeConsensus's `byBook`. Without it the max below runs over the
  // whole retained history and pairs legs that never coexisted.
  const latest = new Map();
  for (const r of rows) {
    const key = `${lineKey(lineOf(r))}|${r.bookmaker}`;
    const prev = latest.get(key);
    if (!prev || (r.fetched_at ?? '') > (prev.fetched_at ?? '')) latest.set(key, r);
  }

  // ── 2. Books the reader can actually hold an account with. ───────────────
  // The same allow-list computeConsensus applies to the h2h best price. It also
  // removes `apifootball_live`, which is an in-play feed and has no business
  // inside a pre-match vector, and the exchanges, whose pre-commission prices
  // overstate what is takeable.
  const bettable = [...latest.values()].filter(r => BETTABLE_SET.has(r.bookmaker));
  if (!bettable.length) return null;

  // ── 3. Group by line. The over price, the under price and the reported line
  // MUST come from the SAME handicap — otherwise we price a model probability
  // at one line against the best over from a higher line (systematically
  // longer) and fabricate an edge.
  const byLine = new Map();
  for (const r of bettable) {
    const lv = lineOf(r);
    const key = lineKey(lv);
    let g = byLine.get(key);
    if (!g) { g = { line: lv, over: [], under: [] }; byLine.set(key, g); }
    const o = num(r.home_odds), u = num(r.away_odds);
    if (o != null && o > 1) g.over.push({ odds: o, book: r.bookmaker });
    if (u != null && u > 1) g.under.push({ odds: u, book: r.bookmaker });
  }

  let best = null, bestBooks = -1, bestOverround = Infinity;
  for (const g of byLine.values()) {
    const over  = pickBestQuote(g.over);
    const under = pickBestQuote(g.under);
    if (!over || !under) continue;

    const overround = 1 / over.odds + 1 / under.odds;
    // A vector with no margin left is not a market. Either a leg is stale or
    // the two were never quoted against each other; de-vigging it inflates both
    // sides above their own implied probability and manufactures value on
    // both. Refuse the line outright — the edge is computed off this same
    // vector, so a signal built on it would be fake end to end.
    if (overround <= 1) continue;

    // The MOST LIQUID line, not the thinnest overround.
    const books = Math.min(g.over.length, g.under.length);
    if (books > bestBooks || (books === bestBooks && overround < bestOverround)) {
      bestBooks = books;
      bestOverround = overround;
      best = { line: g.line, over, under };
    }
  }
  if (!best) return null;
  return best;
}

/**
 * Best price from one side's quotes, with palpable outliers removed first.
 * Mirrors the guard in computeValues: drop anything more than OUTLIER_MULT from
 * the median, but only with ≥3 quotes (below that there is no stable median),
 * and never drop everyone.
 */
function pickBestQuote(quotes) {
  if (!quotes.length) return null;
  let kept = quotes;
  if (quotes.length >= 3) {
    const s = quotes.map(q => q.odds).sort((a, b) => a - b);
    const mid = Math.floor(s.length / 2);
    const median = s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
    const filtered = quotes.filter(q => q.odds <= median * OUTLIER_MULT && q.odds >= median / OUTLIER_MULT);
    if (filtered.length) kept = filtered;
  }
  return kept.reduce((b, q) => (b == null || q.odds > b.odds ? q : b), null);
}

// ── models ───────────────────────────────────────────────────────────────────

/**
 * Dixon-Coles sheet anchored to the consensus 1X2 probabilities. When the
 * market's no-vig P(over) at `line` is supplied, the (λ,μ) fit is also pinned
 * to that total — otherwise λ+μ is under-constrained by the 1X2 alone and the
 * sheet drifts toward too many goals (inflating O/U-over and BTTS-yes).
 */
function goalsModel(consensus, line = 2.5, anchorOver = null) {
  const pH = num(consensus?.home?.p_cons), pD = num(consensus?.draw?.p_cons), pA = num(consensus?.away?.p_cons);
  if (pH == null || pD == null || pA == null) return null;
  const [h, d, a] = dc.devig([pH, pD, pA]);
  const fitOpts = anchorOver != null ? { anchorTotals: { line, pOver: anchorOver } } : {};
  const fit = dc.fitGoalsTo1x2(h, d, a, fitOpts);
  return dc.priceSheet(fit.lambda, fit.mu, { totalsLines: [line] });
}

// CORNERS AND CARDS ARE GONE — Phase 0 of the engine consolidation, 18 Aug 2026.
//
// `cornersLambda` and `cardsLambda` were Poisson estimators over API team-stat
// averages, shrunk 60% toward the market because the stats were too sparse to
// trust. Between them they produced SIX signals ever — 4 corners, 2 bookings —
// and the last was written on 17 July. lib/publication.js has always refused to
// publish either (n=4 and n=2 settled), and neither has ever been tested
// against prices.
//
// They are not a loss to the consolidation: corners and cards are NOT a
// function of the goal lambdas, so they could never have folded into the
// goals engine anyway. They stay a genuinely separate future workstream, and
// when they come back they come back through the paper harness and the gate
// like anything else — not as dead codepaths nobody measured.

// ── pricing core + assembly ──────────────────────────────────────────────────

/** One priced leg. `marketProb` is the de-vigged market probability for THIS
 *  leg — carried onto the signal so the score is a margin-free comparison on
 *  both sides. Null when the two-way market could not be de-vigged, which makes
 *  the row unscorable rather than scored against a margin-carrying number. */
const side = (sel, prob, marketProb = null) =>
  (sel ? { odds: sel.odds, book: sel.book, prob, marketProb, edge: ev(prob, sel.odds), value: ev(prob, sel.odds) >= EV_THRESHOLD } : null);

/**
 * Price every secondary market for one match — the shared core behind both the
 * value signals and the computed_values columns. Returns null per market when it
 * can't be priced (no odds).
 *
 * @returns {{ totals, btts }}
 */
function priceSecondaryMarkets(match, consensus, homeStats, awayStats, refStats) {
  const result = { totals: null, btts: null };

  const totals = bestTwoWay(match.odds, 'totals');
  const btts   = bestTwoWay(match.odds, 'btts');
  if (totals || btts) {
    const line = totals?.line ?? 2.5;
    // Anchor (λ,μ) to the market's own O/U total so the sheet can't drift to a
    // systematically higher goal expectation than the goals market implies.
    const anchorOver = totals ? marketNoVigOver(totals.over, totals.under) : null;
    const gm = goalsModel(consensus, line, anchorOver);
    if (gm) {
      // Shrink both goals-derived markets toward the market no-vig price. This
      // strips the structural model bias (chronic BTTS-yes / O/U-over edge)
      // while leaving intact the genuine value of a best price that beats the
      // no-vig line.
      if (totals) {
        const pOver = shrinkToMarket(gm.pOver[line], totals.over, totals.under, GOALS_MARKET_TRUST);
        const mkt = devigTwoWay(totals.over, totals.under);
        result.totals = {
          line,
          over:  side(totals.over,  pOver,     mkt?.over  ?? null),
          under: side(totals.under, 1 - pOver, mkt?.under ?? null),
        };
      }
      if (btts) {
        const pYes = shrinkToMarket(gm.bttsYes, btts.over, btts.under, GOALS_MARKET_TRUST);
        const mkt = devigTwoWay(btts.over, btts.under);
        result.btts = {
          modelProb: pYes,
          yes: side(btts.over,  pYes,     mkt?.over  ?? null),
          no:  side(btts.under, 1 - pYes, mkt?.under ?? null),
        };
      }
    }
  }

  return result;
}

/**
 * Flatten priced markets into +EV signal candidates (detected_edge >= threshold).
 *
 * `census` IS AN OUT-PARAMETER AND IT EXISTS BECAUSE "NOTHING WRITTEN" HAS FOUR
 * CAUSES. On 21 Aug 2026 the goals sheet wrote 158 signals in a fortnight and 8
 * of them carried a score, which reads as a guard destroying the model's output
 * — and the guard is not what was happening. Three separate things were:
 *
 *   * 12-19 Aug: the two-way vector was incoherent, `market_prob x detected_odds`
 *     landed above 1, and migration 060's write-layer guard stripped the score.
 *     That guard is CORRECT and the rows it caught were not signals.
 *   * 14-20 Aug: `team_statistics` was stale — the fetch was being SIGKILLed at
 *     its step timeout — so the goals model could not price at all and
 *     `over_edge` was null on every computed_values row for a week.
 *   * 21 Aug onward, with both fixed: the model prices 190 fixtures and the best
 *     leg on each averages -2.75%, p90 -1.34%, max +0.07%. Exactly one row in
 *     190 is positive at all. THERE IS NO EDGE TO PUBLISH.
 *
 * All three present identically from outside: an empty board. This counts them
 * apart at the point where the answer is known, so the next person reading
 * "[secondary] no new signals" is told which of the four it was rather than
 * guessing — the same rule `/api/inplay` already applies to an empty board.
 */
function buildSecondarySignals(match, consensus, homeStats, awayStats, refStats, census = null) {
  const p = priceSecondaryMarkets(match, consensus, homeStats, awayStats, refStats);
  const out = [];
  if (census) {
    for (const [key, legs] of [['totals', p.totals ? [p.totals.over, p.totals.under] : null],
                               ['btts',   p.btts   ? [p.btts.yes,   p.btts.no]     : null]]) {
      const c = census[key] ??= { unpriced: 0, priced: 0, positive: 0, value: 0, best: null };
      if (!legs) { c.unpriced += 1; continue; }
      c.priced += 1;
      const best = Math.max(...legs.filter(Boolean).map(l => l.edge));
      if (Number.isFinite(best)) {
        if (c.best == null || best > c.best) c.best = best;
        if (best > 0) c.positive += 1;
      }
      if (legs.some(l => l?.value)) c.value += 1;
    }
  }
  const add = (sel, market, line, outcome, arch) => {
    if (!sel || !sel.value) return;
    out.push({
      match_id: match.id, market, market_line: line ?? null, outcome,
      detected_odds: sel.odds, detected_edge: parseFloat(sel.edge.toFixed(6)),
      bookmaker: sel.book, model_architecture: arch, model_prob: sel.prob,
      // The market side of the score, margin removed — see `devigTwoWay`.
      market_prob: sel.marketProb,
    });
  };
  if (p.totals)   { add(p.totals.over, 'totals', p.totals.line, 'over', 'DIXON_COLES'); add(p.totals.under, 'totals', p.totals.line, 'under', 'DIXON_COLES'); }
  if (p.btts)     { add(p.btts.yes, 'btts', null, 'btts_yes', 'DIXON_COLES'); add(p.btts.no, 'btts', null, 'btts_no', 'DIXON_COLES'); }
  return out;
}

/** Map priced markets onto computed_values columns (feeds the feed/detail/suggested-bets). */
function secondaryComputedValues(match, consensus, homeStats, awayStats, refStats) {
  const p = priceSecondaryMarkets(match, consensus, homeStats, awayStats, refStats);
  const round = (x, d = 4) => (x == null ? null : parseFloat(x.toFixed(d)));
  const cv = {};

  if (p.totals) Object.assign(cv, {
    totals_line: p.totals.line,
    over_odds:  p.totals.over?.odds  ?? null, over_book:  p.totals.over?.book  ?? null, over_edge:  round(p.totals.over?.edge),  over_value:  !!p.totals.over?.value,
    under_odds: p.totals.under?.odds ?? null, under_book: p.totals.under?.book ?? null, under_edge: round(p.totals.under?.edge), under_value: !!p.totals.under?.value,
  });
  if (p.btts) Object.assign(cv, {
    btts_model_prob: round(p.btts.modelProb),
    btts_yes_odds: p.btts.yes?.odds ?? null, btts_yes_book: p.btts.yes?.book ?? null, btts_yes_edge: round(p.btts.yes?.edge), btts_yes_value: !!p.btts.yes?.value,
    btts_no_odds:  p.btts.no?.odds  ?? null, btts_no_book:  p.btts.no?.book  ?? null, btts_no_edge:  round(p.btts.no?.edge),  btts_no_value:  !!p.btts.no?.value,
  });
  return cv;
}

module.exports = {
  bestTwoWay, goalsModel,
  poissonOver, priceSecondaryMarkets,
  buildSecondarySignals, secondaryComputedValues, EV_THRESHOLD,
};
