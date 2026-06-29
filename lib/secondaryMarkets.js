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

// ── signal assembly ──────────────────────────────────────────────────────────

function candidate(match_id, market, line, outcome, prob, sel, arch) {
  const e = ev(prob, sel.odds);
  if (!(e >= EV_THRESHOLD)) return null;
  return {
    match_id, market, market_line: line ?? null, outcome,
    detected_odds: sel.odds, detected_edge: parseFloat(e.toFixed(6)),
    bookmaker: sel.book, model_architecture: arch, model_prob: prob,
  };
}

/**
 * Build all secondary-market signal candidates for one match.
 * @param {object} match     { id, odds }
 * @param {object} consensus computeConsensus() output (has home/draw/away.p_cons)
 * @param {object} homeStats team_statistics row for the home team (or null)
 * @param {object} awayStats team_statistics row for the away team (or null)
 * @param {object} refStats  referee_stats row (or null)
 */
function buildSecondarySignals(match, consensus, homeStats, awayStats, refStats) {
  const out = [];
  const push = c => { if (c) out.push(c); };

  // Goals O/U + BTTS (Dixon-Coles)
  const totals = bestTwoWay(match.odds, 'totals');
  const btts   = bestTwoWay(match.odds, 'btts');
  if (totals || btts) {
    const line = totals?.line ?? 2.5;
    const gm = goalsModel(consensus, line);
    if (gm) {
      if (totals) {
        push(candidate(match.id, 'totals', line, 'over',  gm.pOver[line],  totals.over,  'DIXON_COLES'));
        push(candidate(match.id, 'totals', line, 'under', gm.pUnder[line], totals.under, 'DIXON_COLES'));
      }
      if (btts) {
        push(candidate(match.id, 'btts', null, 'btts_yes', gm.bttsYes, btts.over,  'DIXON_COLES'));
        push(candidate(match.id, 'btts', null, 'btts_no',  gm.bttsNo,  btts.under, 'DIXON_COLES'));
      }
    }
  }

  // Corners (data-driven Poisson)
  const corners = bestTwoWay(match.odds, 'corners');
  if (corners && corners.line != null) {
    const lambda = cornersLambda(homeStats, awayStats);
    if (lambda != null) {
      const pOver = poissonOver(lambda, corners.line);
      push(candidate(match.id, 'corners', corners.line, 'over',  pOver,     corners.over,  'CORNERS_MODEL'));
      push(candidate(match.id, 'corners', corners.line, 'under', 1 - pOver, corners.under, 'CORNERS_MODEL'));
    }
  }

  // Cards / booking points (data-driven Poisson + referee tilt)
  const bookings = bestTwoWay(match.odds, 'bookings');
  if (bookings && bookings.line != null) {
    const lambda = bookingsLambda(homeStats, awayStats, refStats);
    if (lambda != null) {
      const pOver = bookingsOver(lambda, bookings.line);
      push(candidate(match.id, 'bookings', bookings.line, 'over',  pOver,     bookings.over,  'CARDS_MODEL'));
      push(candidate(match.id, 'bookings', bookings.line, 'under', 1 - pOver, bookings.under, 'CARDS_MODEL'));
    }
  }

  return out;
}

module.exports = {
  bestTwoWay, goalsModel, cornersLambda, bookingsLambda,
  poissonOver, bookingsOver, buildSecondarySignals, EV_THRESHOLD,
};
