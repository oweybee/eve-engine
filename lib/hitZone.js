'use strict';

/**
 * lib/hitZone.js — is there a region of live match state where the PRICE is wrong?
 *
 * The pure half of the in-play momentum study. `scripts/inplayHitZone.js` does
 * the reading and the printing; everything that decides an answer is here, so
 * it can be tested without a database and so the next person can see what was
 * measured rather than what was hoped for.
 *
 * ── THE BASELINE IS THE PRICE, NOT OUR MODEL ────────────────────────────────
 *
 * The question is NOT "does dominance predict goals" — it obviously does, and
 * the bookmaker is watching the same match. It is:
 *
 *     does dominance predict the result BEYOND what the price already knows?
 *
 * So every observation is a RESIDUAL against the Shin-de-vigged market, and a
 * zone is interesting only where realised outcomes beat what the market was
 * charging. Measured against our own `model_prob` instead we would rediscover
 * that INPLAY_DIXON_COLES is uncalibrated above 0.85, which is already known
 * and is a fact about us rather than about football.
 *
 * ── CLUSTER BY MATCH, ALWAYS ────────────────────────────────────────────────
 *
 * The series writes 30-60 ticks per match and they share ONE result. 20,000
 * ticks is not 20,000 observations. Every zone therefore contributes AT MOST
 * ONE observation per match — the first tick that enters it, which is also the
 * only one a bettor could act on, since after that the price has moved.
 *
 * ── THE CONTROL IS THE MARKET'S OWN CALIBRATION ─────────────────────────────
 *
 * Before any hypothesis is read, `calibrationCurve` checks that the de-vigged
 * price predicts the result. The in-play market is the sharpest thing in this
 * dataset, so if it comes out badly calibrated the JOIN is wrong — an inverted
 * away leg, a mismatched tick, a completed flag that lied — and nothing else
 * the study says can be trusted. **A broken pipeline and a real edge look
 * identical in a zone table and completely different in a calibration curve.**
 *
 * A RED CARD IS NOT THE CONTROL, though it is the measured thing to hand
 * (x0.6178 / x1.6018 in lib/inplayState). The market reprices a sending-off
 * within seconds, so the correct residual there is ZERO — it would test whether
 * bookmakers watch football, and pass whatever our code did.
 *
 * ── THE HYPOTHESES ARE PRE-REGISTERED AND FEW ───────────────────────────────
 *
 * Eight statistics crossed with five minute bands and three outcomes is 120
 * cells, and ~6 clear |z| >= 2 by chance alone. That is the trap `/leagues`
 * leads against ("not one club-season in 785 clears the corrected bar") and
 * `/models` leads against ("not one architecture clears |z| >= 2"). So the list
 * is fixed in this file, `bonferroniZ` states the corrected bar for however
 * many are tested, and `splitByTime` keeps a holdout the zones were not chosen
 * on. A zone that clears the corrected bar on the explore half and fails on the
 * holdout is a description of the past.
 *
 * ── THE DRAW IS EXCLUDED, AND SAYING SO IS THE POINT ────────────────────────
 *
 * Every feature here is a DIFFERENTIAL from one side's perspective, and the
 * draw has no side. Folding it in as "closeness" would be a different
 * hypothesis wearing the same name. Home and away only; the draw legs are still
 * used to de-vig the vector, which needs all three.
 */

const { shinDevig } = require('./devig');

// ── the numbers a zone gets ─────────────────────────────────────────────────

/**
 * Inverse standard normal (Acklam), for the multiple-testing bar.
 * Accurate to ~1.15e-9 over the whole range, which is far beyond what a
 * significance threshold needs.
 */
function invNorm(p) {
  if (!(p > 0 && p < 1)) return NaN;
  const a = [-3.969683028665376e+01, 2.209460984245205e+02, -2.759285104469687e+02,
             1.383577518672690e+02, -3.066479806614716e+01, 2.506628277459239e+00];
  const b = [-5.447609879822406e+01, 1.615858368580409e+02, -1.556989798598866e+02,
             6.680131188771972e+01, -1.328068155288572e+01];
  const c = [-7.784894002430293e-03, -3.223964580411365e-01, -2.400758277161838e+00,
             -2.549732539343734e+00, 4.374664141464968e+00, 2.938163982698783e+00];
  const d = [7.784695709041462e-03, 3.224671290700398e-01, 2.445134137142996e+00,
             3.754408661907416e+00];
  const pLow = 0.02425, pHigh = 1 - pLow;
  let x;
  if (p < pLow) {
    const q = Math.sqrt(-2 * Math.log(p));
    x = (((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5])
      / ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1);
  } else if (p <= pHigh) {
    const q = p - 0.5, r = q * q;
    x = (((((a[0] * r + a[1]) * r + a[2]) * r + a[3]) * r + a[4]) * r + a[5]) * q
      / (((((b[0] * r + b[1]) * r + b[2]) * r + b[3]) * r + b[4]) * r + 1);
  } else {
    const q = Math.sqrt(-2 * Math.log(1 - p));
    x = -(((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5])
      / ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1);
  }
  return x;
}

/**
 * The |z| a finding must clear once `k` zones have been tested.
 *
 * At k=1 this is the familiar 1.96. It rises with k because testing more
 * places to look means chance produces more winners: at k=8 the bar is 2.73,
 * and a table of eight zones where the best reads 2.4 has found nothing.
 */
function bonferroniZ(k, alpha = 0.05) {
  const kk = Math.max(1, Math.floor(k));
  return Math.abs(invNorm(alpha / (2 * kk)));
}

/** Expected number of zones clearing |z| >= 2 by chance alone, out of k. */
function expectedFalsePositives(k, bar = 2) {
  // two-tailed tail mass beyond `bar`, approximated through the same inverse
  // by solving invNorm(alpha/2) = -bar
  const alpha = 2 * (1 - normCdf(bar));
  return k * alpha;
}

/** Standard normal CDF (Abramowitz & Stegun 7.1.26 on erf). */
function normCdf(x) {
  const t = 1 / (1 + 0.2316419 * Math.abs(x));
  const d = 0.3989422804014327 * Math.exp(-x * x / 2);
  const p = d * t * (0.319381530 + t * (-0.356563782 + t * (1.781477937
          + t * (-1.821255978 + t * 1.330274429))));
  return x > 0 ? 1 - p : p;
}

/**
 * What a zone actually did.
 *
 * `expected` is the mean de-vigged market probability over the observations —
 * what the price was charging — and `realised` is how often it landed. `z` is
 * the calibration miss against that expectation, which is the powerful test;
 * `returnZ` is the flat-stake return over its own standard error, which is what
 * a bettor would feel and is far noisier. **They answer different questions and
 * the return one will almost never clear a bar at these sample sizes.**
 *
 * @param {Array<{pMarket:number, won:boolean, odds:number}>} obs
 */
function zoneStats(obs) {
  const rows = (obs ?? []).filter(o =>
    Number.isFinite(o?.pMarket) && o.pMarket > 0 && o.pMarket < 1 && typeof o.won === 'boolean');
  const n = rows.length;
  if (!n) return { n: 0, expected: null, realised: null, z: null, flatReturn: null, returnZ: null };

  const expected = rows.reduce((s, o) => s + o.pMarket, 0) / n;
  const realised = rows.reduce((s, o) => s + (o.won ? 1 : 0), 0) / n;
  const se = Math.sqrt(expected * (1 - expected) / n);
  const z = se > 0 ? (realised - expected) / se : null;

  const priced = rows.filter(o => Number.isFinite(o.odds) && o.odds > 1);
  let flatReturn = null, returnZ = null;
  if (priced.length) {
    const rets = priced.map(o => (o.won ? o.odds : 0) - 1);
    const mean = rets.reduce((a, b) => a + b, 0) / rets.length;
    flatReturn = mean;
    if (rets.length > 1) {
      const varr = rets.reduce((s, r) => s + (r - mean) ** 2, 0) / (rets.length - 1);
      const rse = Math.sqrt(varr / rets.length);
      returnZ = rse > 0 ? mean / rse : null;
    }
  }
  return { n, expected, realised, z, flatReturn, returnZ };
}

/**
 * The control: does the de-vigged price predict the result?
 *
 * Read this BEFORE any zone table. A market that comes out badly calibrated
 * here is a broken join, not a discovery.
 */
function calibrationCurve(obs, edges = [0, 0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 0.9, 1]) {
  const bands = [];
  for (let i = 0; i < edges.length - 1; i++) {
    const lo = edges[i], hi = edges[i + 1];
    const inBand = (obs ?? []).filter(o =>
      Number.isFinite(o?.pMarket) && o.pMarket >= lo && (i === edges.length - 2 ? o.pMarket <= hi : o.pMarket < hi));
    bands.push({ lo, hi, ...zoneStats(inBand) });
  }
  return bands;
}

// ── shaping the observations ────────────────────────────────────────────────

const SELECTIONS = Object.freeze(['home', 'draw', 'away']);

/**
 * Group h2h series rows into one vector per (match, instant).
 * A tick missing any leg is dropped: three prices are de-vigged together, and
 * a two-legged vector makes the surviving two wrong rather than merely fewer.
 */
function pivotTicks(rows) {
  const byTick = new Map();
  for (const r of rows ?? []) {
    if (r?.market && r.market !== 'h2h') continue;
    if (!SELECTIONS.includes(r?.selection)) continue;
    const key = `${r.match_id}|${r.captured_at}`;
    let t = byTick.get(key);
    if (!t) {
      t = { matchId: r.match_id, capturedAt: r.captured_at, minute: r.minute,
            goalsHome: r.goals_home, goalsAway: r.goals_away, legs: {} };
      byTick.set(key, t);
    }
    t.legs[r.selection] = r;
  }
  const out = [];
  for (const t of byTick.values()) {
    if (SELECTIONS.every(s => Number(t.legs[s]?.best_odds) > 1)) out.push(t);
  }
  return out.sort((a, b) => Date.parse(a.capturedAt) - Date.parse(b.capturedAt));
}

/**
 * Shin-de-vig one tick's three legs.
 *
 * NOT a proportional de-vig — that is the method lib/devig disqualifies and
 * that `/performance` records as the difference between +4.98% and -1.55% on
 * the same bets.
 *
 * @returns {{home:number, draw:number, away:number}|null}
 */
function marketProbs(tick) {
  const odds = SELECTIONS.map(s => Number(tick?.legs?.[s]?.best_odds));
  if (!odds.every(o => Number.isFinite(o) && o > 1)) return null;
  const d = shinDevig(odds);
  if (!d?.probs) return null;
  return { home: d.probs[0], draw: d.probs[1], away: d.probs[2] };
}

/** Did this selection win? Null when the match has no final score. */
function didWin(selection, goalsHome, goalsAway) {
  const h = num(goalsHome), a = num(goalsAway);
  if (h == null || a == null) return null;
  if (selection === 'home') return h > a;
  if (selection === 'away') return a > h;
  if (selection === 'draw') return h === a;
  return null;
}

/**
 * `Number(null)` IS 0 AND 0 IS FINITE, which is how a missing statistic becomes
 * a real value. Both of the callers below were written with a bare coercion and
 * both were caught by test: an absent xG differenced against a real one gave
 * -0.4 instead of null (teaching the study that untracked competitions create
 * nothing), and an unplayed match reported 0-0, which `didWin` read as a LOSS
 * rather than as no result. lib/inplayState.num and lib/momentum carry the same
 * guard after the same trap.
 */
function num(v) {
  if (v == null || v === '') return null;
  const n = typeof v === 'string' ? parseFloat(v) : Number(v);
  return Number.isFinite(n) ? n : null;
}

function diff(a, b) {
  const x = num(a), y = num(b);
  return (x != null && y != null) ? x - y : null;
}

/**
 * Match state as differentials FROM THE SELECTION'S SIDE.
 *
 * THE ORIENTATION IS THE DANGEROUS PART. Reading `xg_home` as "our xG"
 * regardless of which side the selection backs inverts every away observation
 * and looks completely ordinary in a results table — the same failure
 * lib/headToHead exists to warn about. Pinned by test in both directions.
 *
 * @param {object} m - an inplay_momentum row
 * @param {'home'|'away'} side
 * @param {object} tick - for the scoreline, which the momentum row may not carry
 * @returns {object|null} null for the draw, which has no side
 */
function orientFeatures(m, side, tick = {}) {
  if (side !== 'home' && side !== 'away') return null;
  if (!m) return null;
  const flip = side === 'away' ? -1 : 1;
  const signed = v => (v == null ? null : v * flip);
  const goalsHome = m.goals_home ?? tick.goalsHome;
  const goalsAway = m.goals_away ?? tick.goalsAway;
  const xgDiff = signed(diff(m.xg_home, m.xg_away));
  const goalDiff = signed(diff(goalsHome, goalsAway));
  return {
    minute:      num(m.minute) ?? num(tick.minute),
    goalDiff,
    xgDiff,
    // The classic: creating more than the scoreboard shows.
    xgSurplus:   (xgDiff == null || goalDiff == null) ? null : xgDiff - goalDiff,
    sotDiff:     signed(diff(m.sot_home, m.sot_away)),
    shotsDiff:   signed(diff(m.shots_home, m.shots_away)),
    insideDiff:  signed(diff(m.inside_home, m.inside_away)),
    cornersDiff: signed(diff(m.corners_home, m.corners_away)),
    possDiff:    signed(diff(m.poss_home, m.poss_away)),
    redDiff:     signed(diff(m.reds_home, m.reds_away)),
  };
}

/**
 * The momentum row closest in time to a tick, within tolerance.
 *
 * The two tables are written by one pass but not in one statement, and the
 * stats gate is 90 seconds against a 60-second loop, so an exact timestamp
 * match would throw most of the corpus away. A tolerance wider than the stats
 * refresh would pair a tick with state from a different phase of the match, so
 * it defaults to that refresh interval.
 */
function nearestMomentum(rows, capturedAt, toleranceMs = 90_000) {
  const t = Date.parse(capturedAt);
  if (!Number.isFinite(t)) return null;
  let best = null, bestGap = Infinity;
  for (const m of rows ?? []) {
    const gap = Math.abs(Date.parse(m.captured_at) - t);
    if (Number.isFinite(gap) && gap < bestGap) { best = m; bestGap = gap; }
  }
  return bestGap <= toleranceMs ? best : null;
}

// ── the pre-registered hypotheses ───────────────────────────────────────────

/**
 * FIXED IN THIS FILE, on purpose. Adding one after seeing the data is how a
 * table of 120 cells with six chance winners gets written, and `bonferroniZ`
 * reads its length. If a new idea is worth testing, add it here, say so, and
 * accept the higher bar for everything.
 *
 * `enter` is a predicate on oriented features. Each returns AT MOST ONE
 * observation per match — the first tick that satisfies it, which is the only
 * one a bettor could have acted on.
 */
const HYPOTHESES = Object.freeze([
  {
    key: 'xg_surplus',
    label: 'Creating more than the scoreboard shows',
    why: 'the price follows the score; chances should lead it',
    enter: f => f.xgSurplus != null && f.xgSurplus >= 1.0 && f.minute >= 30 && f.minute <= 80,
  },
  {
    key: 'xg_surplus_behind',
    label: 'Ahead on chances, behind on the scoreboard',
    why: 'the sharpest form of the same idea — the market is anchored on a goal',
    enter: f => f.xgSurplus != null && f.xgSurplus >= 1.0 && f.goalDiff != null
             && f.goalDiff < 0 && f.minute >= 30 && f.minute <= 80,
  },
  {
    key: 'sot_dominance',
    label: 'Sustained shots-on-target dominance',
    why: 'a cruder proxy than xG and available in every competition',
    enter: f => f.sotDiff != null && f.sotDiff >= 4 && f.minute >= 30 && f.minute <= 80,
  },
  {
    key: 'territory',
    label: 'Territorial dominance (possession and corners)',
    why: 'a deliberate near-null — territory without chances should price at zero',
    enter: f => f.possDiff != null && f.possDiff >= 20 && f.cornersDiff != null
             && f.cornersDiff >= 4 && f.minute >= 30 && f.minute <= 80,
  },
]);

/**
 * One observation per match for a hypothesis: the FIRST tick that enters.
 *
 * @param {Array} observations - every (match, side, tick) row, time-ordered
 */
function firstEntryPerMatch(observations, hypothesis) {
  const seen = new Set();
  const out = [];
  for (const o of observations ?? []) {
    if (!o.features) continue;
    const key = `${o.matchId}|${o.selection}`;
    if (seen.has(key)) continue;
    if (!hypothesis.enter(o.features)) continue;
    seen.add(key);
    out.push(o);
  }
  return out;
}

/**
 * Split by KICKOFF, not at random.
 *
 * A random split leaks: two ticks from one match land on both sides, and the
 * holdout then contains matches the zone was chosen on. A time split is also
 * the honest shape for a forward test — the holdout is literally the future.
 */
function splitByTime(observations, exploreFraction = 0.5) {
  const rows = (observations ?? []).filter(o => Number.isFinite(Date.parse(o?.kickoffAt)));
  const matches = [...new Set(rows.map(o => o.matchId))]
    .map(id => ({ id, t: Date.parse(rows.find(o => o.matchId === id).kickoffAt) }))
    .sort((a, b) => a.t - b.t);
  const cut = Math.floor(matches.length * exploreFraction);
  const exploreIds = new Set(matches.slice(0, cut).map(m => m.id));
  return {
    explore: rows.filter(o => exploreIds.has(o.matchId)),
    holdout: rows.filter(o => !exploreIds.has(o.matchId)),
    exploreMatches: cut,
    holdoutMatches: matches.length - cut,
  };
}

module.exports = {
  SELECTIONS, HYPOTHESES, num,
  invNorm, normCdf, bonferroniZ, expectedFalsePositives,
  zoneStats, calibrationCurve,
  pivotTicks, marketProbs, didWin, orientFeatures, nearestMomentum,
  firstEntryPerMatch, splitByTime,
};
