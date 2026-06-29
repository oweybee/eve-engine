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

const EV_THRESHOLD     = parseFloat(process.env.EV_THRESHOLD || '0.005');
const TYPICAL_MATCH_BP = parseFloat(process.env.TYPICAL_MATCH_BP || '50'); // ~5 yellows/match
const REF_TILT_MIN = 0.80, REF_TILT_MAX = 1.25;

// ── helpers ──────────────────────────────────────────────────────────────────
const num   = x => (x == null || x === '' || !Number.isFinite(Number(x)) ? null : Number(x));
const clamp = (x, lo, hi) => Math.max(lo, Math.min(hi, x));
const ev    = (p, odds) => p * odds - 1;
const meanDefined = arr => { const v = arr.filter(x => x != null && Number.isFinite(x)); return v.length ? v.reduce((a, b) => a + b, 0) / v.length : null; };

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
/** P(total > line) for booking points, modelled in 10-pt (one-yellow) units. */
function bookingsOver(lambdaPts, line) {
  return poissonOver(lambdaPts / 10, line / 10);
}

/**
 * Best available price for a two-way market stored as
 *   over/yes → home_odds, under/no → away_odds (engine convention).
 * @returns {{line, over:{odds,book}, under:{odds,book}} | null}
 */
function bestTwoWay(oddsRows, market) {
  const rows = (oddsRows ?? []).filter(r => (r.market ?? 'h2h') === market);
  if (!rows.length) return null;
  let over = { odds: 0, book: null }, under = { odds: 0, book: null }, line = null;
  for (const r of rows) {
    const o = num(r.home_odds), u = num(r.away_odds);
    if (o != null && o > over.odds)  over  = { odds: o, book: r.bookmaker };
    if (u != null && u > under.odds) under = { odds: u, book: r.bookmaker };
    if (r.market_line != null) line = num(r.market_line);
  }
  if (over.odds <= 1 || under.odds <= 1) return null;
  return { line, over, under };
}

// ── models ───────────────────────────────────────────────────────────────────

/** Dixon-Coles sheet anchored to the consensus 1X2 probabilities. */
function goalsModel(consensus, line = 2.5) {
  const pH = num(consensus?.home?.p_cons), pD = num(consensus?.draw?.p_cons), pA = num(consensus?.away?.p_cons);
  if (pH == null || pD == null || pA == null) return null;
  const [h, d, a] = dc.devig([pH, pD, pA]);
  const fit = dc.fitGoalsTo1x2(h, d, a);
  return dc.priceSheet(fit.lambda, fit.mu, { totalsLines: [line] });
}

/** Expected total corners from team for/against averages. */
function cornersLambda(homeStats, awayStats) {
  const home = meanDefined([num(homeStats?.corners_for_avg), num(awayStats?.corners_against_avg)]);
  const away = meanDefined([num(awayStats?.corners_for_avg), num(homeStats?.corners_against_avg)]);
  if (home == null && away == null) return null;
  return (home ?? 5) + (away ?? 5);
}

/** Expected total booking points from team averages, tilted by the referee. */
function bookingsLambda(homeStats, awayStats, refStats) {
  const h = num(homeStats?.booking_points_avg), a = num(awayStats?.booking_points_avg);
  if (h == null && a == null) return null;
  let lambda = (h ?? TYPICAL_MATCH_BP / 2) + (a ?? TYPICAL_MATCH_BP / 2);
  const refBp = num(refStats?.booking_points_avg);
  if (refBp != null) lambda *= clamp(refBp / TYPICAL_MATCH_BP, REF_TILT_MIN, REF_TILT_MAX);
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
    const gm = goalsModel(consensus, line);
    if (gm) {
      if (totals) result.totals = { line, over: side(totals.over, gm.pOver[line]), under: side(totals.under, gm.pUnder[line]) };
      if (btts)   result.btts   = { modelProb: gm.bttsYes, yes: side(btts.over, gm.bttsYes), no: side(btts.under, gm.bttsNo) };
    }
  }

  const corners = bestTwoWay(match.odds, 'corners');
  if (corners && corners.line != null) {
    const lambda = cornersLambda(homeStats, awayStats);
    if (lambda != null) {
      const pOver = poissonOver(lambda, corners.line);
      result.corners = { line: corners.line, lambda, modelProb: pOver, over: side(corners.over, pOver), under: side(corners.under, 1 - pOver) };
    }
  }

  const bookings = bestTwoWay(match.odds, 'bookings');
  if (bookings && bookings.line != null) {
    const lambda = bookingsLambda(homeStats, awayStats, refStats);
    if (lambda != null) {
      const pOver = bookingsOver(lambda, bookings.line);
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
  bestTwoWay, goalsModel, cornersLambda, bookingsLambda,
  poissonOver, bookingsOver, priceSecondaryMarkets,
  buildSecondarySignals, secondaryComputedValues, EV_THRESHOLD,
};
