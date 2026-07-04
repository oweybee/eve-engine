'use strict';

/**
 * lib/secondaryMarkets.js — price O/U, BTTS, corners and cards, then surface
 * cross-market value signals.
 *
 *   Goals O/U + BTTS → Dixon-Coles, anchored to the consensus 1X2 (high trust).
 *   Corners          → Poisson on team corner averages (data-driven).
 *   Cards (bookings) → Poisson on team booking-point averages + referee tilt.
 *
 * A signal fires when the model's probability for a selection, priced against
 * the best available market odds, clears the EV threshold. Pure & testable:
 * all DB access happens in the caller (computeValues).
 */

const dc = require('./dixonColes');

const EV_THRESHOLD        = parseFloat(process.env.EV_THRESHOLD || '0.005');
const TYPICAL_MATCH_CARDS = parseFloat(process.env.TYPICAL_MATCH_CARDS || '4'); // ~2 cards/team
const REF_TILT_MIN = 0.80, REF_TILT_MAX = 1.25;

// How much to trust the pure team-stat Poisson for the DATA-DRIVEN markets
// (corners, cards) vs the market's own no-vig price. These models run on sparse,
// patchy API stats and could otherwise emit wildly off-market probabilities
// (e.g. 92% Under 3.5 cards while the market prices Over) — a misinformation
// risk. Shrinking toward the market caps how far a signal can diverge: at 0.4
// the model can't move the probability more than ~60% of the way from the
// market, so a thin-data outlier can no longer publish a huge fake edge.
const SECONDARY_DATA_TRUST = clampUnit(parseFloat(process.env.SECONDARY_DATA_TRUST || '0.4'));

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
 * @returns {{line, over:{odds,book}, under:{odds,book}} | null}
 */
function bestTwoWay(oddsRows, market) {
  const rows = (oddsRows ?? []).filter(r => (r.market ?? 'h2h') === market);
  if (!rows.length) return null;

  // Group by line. The over odds, the under odds and the reported line MUST come
  // from the SAME handicap — otherwise we'd price a model probability at one line
  // against the best over from a higher line (systematically longer) and fabricate
  // an edge. Within each line take the best (max) over and under.
  const byLine = new Map();
  for (const r of rows) {
    const o = num(r.home_odds), u = num(r.away_odds);
    const lv = r.market_line != null ? num(r.market_line) : null;
    const key = lv != null ? String(lv) : 'null';
    let g = byLine.get(key);
    if (!g) { g = { line: lv, over: { odds: 0, book: null }, under: { odds: 0, book: null } }; byLine.set(key, g); }
    if (o != null && o > g.over.odds)  g.over  = { odds: o, book: r.bookmaker };
    if (u != null && u > g.under.odds) g.under = { odds: u, book: r.bookmaker };
  }

  // Pick the most liquid line with both sides priced (lowest two-way overround).
  let best = null, bestOverround = Infinity;
  for (const g of byLine.values()) {
    if (g.over.odds <= 1 || g.under.odds <= 1) continue;
    const overround = 1 / g.over.odds + 1 / g.under.odds;
    if (overround < bestOverround) { bestOverround = overround; best = g; }
  }
  if (!best) return null;
  return { line: best.line, over: best.over, under: best.under };
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

/** Expected total corners from team for/against averages. */
function cornersLambda(homeStats, awayStats) {
  const home = meanDefined([num(homeStats?.corners_for_avg), num(awayStats?.corners_against_avg)]);
  const away = meanDefined([num(awayStats?.corners_for_avg), num(homeStats?.corners_against_avg)]);
  if (home == null && away == null) return null;
  return (home ?? 5) + (away ?? 5);
}

/**
 * Expected total CARD COUNT from team averages, tilted by the referee. Betfair's
 * "Cards Over/Under 2.5/3.5" market is a card count (the booking-points market
 * has non-parseable runners), so we model it on cards_avg (yellow+red per team).
 */
function cardsLambda(homeStats, awayStats, refStats) {
  const h = num(homeStats?.cards_avg), a = num(awayStats?.cards_avg);
  if (h == null && a == null) return null;
  let lambda = (h ?? TYPICAL_MATCH_CARDS / 2) + (a ?? TYPICAL_MATCH_CARDS / 2);
  const refCards = num(refStats?.cards_avg);
  if (refCards != null) lambda *= clamp(refCards / TYPICAL_MATCH_CARDS, REF_TILT_MIN, REF_TILT_MAX);
  return lambda;
}

// ── pricing core + assembly ──────────────────────────────────────────────────

const side = (sel, prob) => (sel ? { odds: sel.odds, book: sel.book, prob, edge: ev(prob, sel.odds), value: ev(prob, sel.odds) >= EV_THRESHOLD } : null);

/**
 * Price every secondary market for one match — the shared core behind both the
 * value signals and the computed_values columns. Returns null per market when it
 * can't be priced (no odds, or no team stats for corners/cards).
 *
 * @returns {{ totals, btts, corners, bookings }}
 */
function priceSecondaryMarkets(match, consensus, homeStats, awayStats, refStats) {
  const result = { totals: null, btts: null, corners: null, bookings: null };

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
        result.totals = { line, over: side(totals.over, pOver), under: side(totals.under, 1 - pOver) };
      }
      if (btts) {
        const pYes = shrinkToMarket(gm.bttsYes, btts.over, btts.under, GOALS_MARKET_TRUST);
        result.btts = { modelProb: pYes, yes: side(btts.over, pYes), no: side(btts.under, 1 - pYes) };
      }
    }
  }

  const corners = bestTwoWay(match.odds, 'corners');
  if (corners && corners.line != null) {
    const lambda = cornersLambda(homeStats, awayStats);
    if (lambda != null) {
      // Shrink the team-stat Poisson toward the market price so a thin-data
      // outlier can't publish an off-market edge.
      const pOver = shrinkToMarket(poissonOver(lambda, corners.line), corners.over, corners.under);
      result.corners = { line: corners.line, lambda, modelProb: pOver, over: side(corners.over, pOver), under: side(corners.under, 1 - pOver) };
    }
  }

  const bookings = bestTwoWay(match.odds, 'bookings');
  if (bookings && bookings.line != null) {
    const lambda = cardsLambda(homeStats, awayStats, refStats);
    if (lambda != null) {
      const pOver = shrinkToMarket(poissonOver(lambda, bookings.line), bookings.over, bookings.under); // card COUNT over/under
      result.bookings = { line: bookings.line, lambda, modelProb: pOver, over: side(bookings.over, pOver), under: side(bookings.under, 1 - pOver) };
    }
  }

  return result;
}

/** Flatten priced markets into +EV signal candidates (detected_edge ≥ threshold). */
function buildSecondarySignals(match, consensus, homeStats, awayStats, refStats) {
  const p = priceSecondaryMarkets(match, consensus, homeStats, awayStats, refStats);
  const out = [];
  const add = (sel, market, line, outcome, arch) => {
    if (!sel || !sel.value) return;
    out.push({
      match_id: match.id, market, market_line: line ?? null, outcome,
      detected_odds: sel.odds, detected_edge: parseFloat(sel.edge.toFixed(6)),
      bookmaker: sel.book, model_architecture: arch, model_prob: sel.prob,
    });
  };
  if (p.totals)   { add(p.totals.over, 'totals', p.totals.line, 'over', 'DIXON_COLES'); add(p.totals.under, 'totals', p.totals.line, 'under', 'DIXON_COLES'); }
  if (p.btts)     { add(p.btts.yes, 'btts', null, 'btts_yes', 'DIXON_COLES'); add(p.btts.no, 'btts', null, 'btts_no', 'DIXON_COLES'); }
  if (p.corners)  { add(p.corners.over, 'corners', p.corners.line, 'over', 'CORNERS_MODEL'); add(p.corners.under, 'corners', p.corners.line, 'under', 'CORNERS_MODEL'); }
  if (p.bookings) { add(p.bookings.over, 'bookings', p.bookings.line, 'over', 'CARDS_MODEL'); add(p.bookings.under, 'bookings', p.bookings.line, 'under', 'CARDS_MODEL'); }
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
  if (p.corners) Object.assign(cv, {
    corners_line: p.corners.line, corners_lambda: round(p.corners.lambda, 2), corners_model_prob: round(p.corners.modelProb),
    corners_over_odds:  p.corners.over?.odds  ?? null, corners_over_edge:  round(p.corners.over?.edge),  corners_over_value:  !!p.corners.over?.value,
    corners_under_odds: p.corners.under?.odds ?? null, corners_under_edge: round(p.corners.under?.edge), corners_under_value: !!p.corners.under?.value,
  });
  if (p.bookings) Object.assign(cv, {
    bookings_line: p.bookings.line, bookings_lambda: round(p.bookings.lambda, 2), bookings_model_prob: round(p.bookings.modelProb),
    bookings_over_odds:  p.bookings.over?.odds  ?? null, bookings_over_edge:  round(p.bookings.over?.edge),  bookings_over_value:  !!p.bookings.over?.value,
    bookings_under_odds: p.bookings.under?.odds ?? null, bookings_under_edge: round(p.bookings.under?.edge), bookings_under_value: !!p.bookings.under?.value,
  });
  return cv;
}

module.exports = {
  bestTwoWay, goalsModel, cornersLambda, cardsLambda,
  poissonOver, priceSecondaryMarkets,
  buildSecondarySignals, secondaryComputedValues, EV_THRESHOLD,
};
