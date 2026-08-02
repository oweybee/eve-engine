'use strict';

/**
 * EVE / Max Edge — Edge-band calibration
 *
 * Pure, side-effect-free statistics used by edgeReview.js to answer one
 * question from the settled book rather than from a hunch:
 *
 *   "Which edge band actually pays, and is the PRIME box still the right one?"
 *
 * The PRIME box in lib/signalTier.js (odds 1.40–3.00, edge 4–10%) came from a
 * single Jun 15 – Jul 3 back-test. That is a fit, not a law: it was chosen
 * because it was the best cell in the matrix ON THE DATA IT WAS CHOSEN FROM,
 * which is exactly the procedure that manufactures a band that then decays.
 * Everything here is built to keep that from happening twice:
 *
 *   1. IN-SAMPLE / OUT-OF-SAMPLE SPLIT. Rows detected before PERFORMANCE_EPOCH
 *      are the window the current box was fitted on and can never confirm it.
 *      A candidate band has to survive on the rows detected AFTER the fit.
 *   2. INTERVALS, NOT POINTS. Yield on a few dozen bets at 2.50 is mostly
 *      noise. Every cell carries a bootstrap interval, and the recommendation
 *      ranks on the lower bound, so a 2-bet band at +180% cannot win.
 *   3. MULTIPLE-COMPARISON HONESTY. Sweeping ~250 boxes over ~300 bets will
 *      always surface a "profitable" one. The sweep reports how many boxes it
 *      tested so the best-of-N is read as best-of-N, never as a discovery.
 *   4. CLV AS THE LEADING INDICATOR. Closing-line value converges an order of
 *      magnitude faster than realised yield, so a band can be judged on CLV
 *      long before its P&L resolves. It is reported alongside every cell.
 *
 * Nothing here mutates a threshold. The script recommends; moving the PRIME
 * box stays a human edit to lib/signalTier.js, made on evidence this produces.
 */

const { dedupeConflicts, THRESHOLDS } = require('./signalTier');

/** One-sided/two-sided normal quantiles used by the Wilson interval. */
const Z_95_TWO_SIDED = 1.959964;

// ---------------------------------------------------------------------------
// Row helpers
// ---------------------------------------------------------------------------

/**
 * Numeric coercion that does NOT launder absence into zero. Number(null) is 0
 * and Number('') is 0, so the naive version silently turns a missing price into
 * a valid one — the exact shape that has shipped repeatedly in this codebase.
 */
const num = v => {
  if (v == null || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};

/** Profit in units from a 1u stake at the detected price. */
function profitOf(row) {
  const odds = num(row.detected_odds);
  if (odds == null) return null;
  return row.result === 'win' ? odds - 1 : -1;
}

/** A row is usable for calibration only if it is settled and priced. */
function isSettled(row) {
  return (row.result === 'win' || row.result === 'loss') &&
         num(row.detected_odds) != null &&
         num(row.detected_edge) != null;
}

/**
 * A box is the filter a bettor could have applied BEFORE kickoff: an odds
 * window and an edge window. `edgeMax === null` means unbounded above.
 */
function inBox(row, box) {
  const o = num(row.detected_odds);
  const e = num(row.detected_edge);
  if (o == null || e == null) return false;
  if (o < box.oddsMin || o >= box.oddsMax) return false;
  if (e < box.edgeMin) return false;
  if (box.edgeMax != null && e >= box.edgeMax) return false;
  return true;
}

/**
 * Rows a box would actually have bet: filter FIRST, then collapse
 * mutually-exclusive picks. Order matters — deduping the whole book first and
 * filtering after would credit a box with a pick it never selected, and would
 * silently drop a match whose best-edge outcome fell outside the box while a
 * second, in-box outcome on the same match was there to be bet.
 */
function applyBox(rows, box) {
  return dedupeConflicts(rows.filter(r => inBox(r, box)));
}

// ---------------------------------------------------------------------------
// Statistics
// ---------------------------------------------------------------------------

function mean(xs) {
  return xs.length ? xs.reduce((s, x) => s + x, 0) / xs.length : null;
}

/** Sample standard deviation (n−1). Null below two observations. */
function stdev(xs) {
  if (xs.length < 2) return null;
  const m = mean(xs);
  return Math.sqrt(xs.reduce((s, x) => s + (x - m) ** 2, 0) / (xs.length - 1));
}

function median(xs) {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

/**
 * CLV outside ±100% is not closing-line value, it is a bad closing price: the
 * settled book carries rows as extreme as −467%, which would mean the market
 * moved more than five times against a bet between detection and kickoff. A
 * handful of those drags a band's mean CLV by tens of points and would make the
 * leading indicator read backwards. They are clamped rather than dropped —
 * their SIGN is real information, only the magnitude is junk — and counted, so
 * the underlying data fault stays visible instead of being quietly absorbed.
 */
const CLV_LIMIT = 1.0;
const clampClv = v => Math.max(-CLV_LIMIT, Math.min(CLV_LIMIT, v));

/**
 * Wilson score interval for a strike rate — correct at the small samples and
 * extreme proportions where the normal approximation falls apart (and 0/21
 * longshots is exactly that case).
 */
function wilson(wins, n, z = Z_95_TWO_SIDED) {
  if (!n) return { lo: null, hi: null };
  const p = wins / n;
  const d = 1 + (z * z) / n;
  const centre = p + (z * z) / (2 * n);
  const half = z * Math.sqrt((p * (1 - p)) / n + (z * z) / (4 * n * n));
  return { lo: Math.max(0, (centre - half) / d), hi: Math.min(1, (centre + half) / d) };
}

/**
 * Deterministic PRNG (mulberry32). The bootstrap must give the same interval
 * for the same book on every run, or the daily snapshot records sampling jitter
 * as though it were drift.
 */
function mulberry32(seed) {
  let a = seed >>> 0;
  return function next() {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Seed derived from the data, so the same book always draws the same resamples. */
function seedFrom(profits) {
  let h = 2166136261;
  h = Math.imul(h ^ profits.length, 16777619);
  for (const p of profits) {
    h = Math.imul(h ^ Math.round(p * 1000), 16777619);
  }
  return h >>> 0;
}

/**
 * Percentile bootstrap interval for mean profit per bet (level-stakes yield).
 * Bootstrap rather than a t-interval because the payoff distribution is a
 * two-point spike — −1 and (odds−1) — which is violently right-skewed at long
 * prices, so a symmetric interval understates how often a "profitable" band is
 * one winner away from breaking even.
 */
function bootstrapYield(profits, { iterations = 2000, alpha = 0.10 } = {}) {
  const n = profits.length;
  if (n < 2) return { lo: null, hi: null, iterations: 0 };
  const rand = mulberry32(seedFrom(profits));
  const means = new Array(iterations);
  for (let b = 0; b < iterations; b++) {
    let sum = 0;
    for (let i = 0; i < n; i++) sum += profits[(rand() * n) | 0];
    means[b] = sum / n;
  }
  means.sort((a, b) => a - b);
  const at = q => means[Math.min(iterations - 1, Math.max(0, Math.floor(q * iterations)))];
  return { lo: at(alpha / 2), hi: at(1 - alpha / 2), iterations };
}

/**
 * How many settled bets a band needs before its yield is resolved to ±target.
 * The honest answer to "is the band right yet?" is usually "not yet, and here
 * is how far off you are" — this turns that into a number instead of a feeling.
 */
function sampleNeeded(profits, target = 0.05, z = Z_95_TWO_SIDED) {
  const sd = stdev(profits);
  if (sd == null || target <= 0) return null;
  return Math.ceil((z * sd / target) ** 2);
}

/**
 * Inverse standard normal CDF (Acklam's rational approximation, ~1e-9 absolute).
 * Needed because the multiplicity correction below asks for quantiles far out
 * in the tail, where a hard-coded table of the usual 1.96 / 1.645 is no use.
 */
function normalQuantile(p) {
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
  let q, r;
  if (p < pLow) {
    q = Math.sqrt(-2 * Math.log(p));
    return (((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5]) /
           ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1);
  }
  if (p > pHigh) return -normalQuantile(1 - p);
  q = p - 0.5;
  r = q * q;
  return (((((a[0] * r + a[1]) * r + a[2]) * r + a[3]) * r + a[4]) * r + a[5]) * q /
         (((((b[0] * r + b[1]) * r + b[2]) * r + b[3]) * r + b[4]) * r + 1);
}

/**
 * Per-test significance level after a Šidák correction for K comparisons.
 * Sweeping 250 boxes over 300 bets guarantees a "profitable" one at the
 * uncorrected 5% level — that is arithmetic, not a discovery. This is the
 * correction that stops the sweep from re-running the mistake the current box
 * came from.
 */
function sidakAlpha(alpha, k) {
  if (!(k > 1)) return alpha;
  return 1 - Math.pow(1 - alpha, 1 / k);
}

/**
 * A conservative one-sided lower bound on a band's yield, at confidence z.
 *
 * Takes the SMALLER of two estimates because each covers the other's blind spot:
 *
 *   • The normal bound on mean profit handles bands whose prices vary, where
 *     strike rate alone would misstate the payout — but it collapses when every
 *     bet in the band settled the same way, since the observed variance is then
 *     zero and the interval claims a certainty the sample cannot support.
 *   • The Wilson bound on strike rate, mapped through the band's average price,
 *     is immune to that degeneracy (0/6 and 6/6 both get honest intervals) but
 *     assumes a roughly uniform payout across the band.
 *
 * A band has to satisfy both readings to be called profitable.
 */
function yieldLowerBound({ profits, wins, avgOdds, z }) {
  const n = profits.length;
  if (!n) return null;

  const sd = stdev(profits);
  const normalLo = sd != null && n > 1
    ? mean(profits) - z * (sd / Math.sqrt(n))
    : -Infinity;

  const strikeLo = wilson(wins, n, z).lo;
  const wilsonLo = strikeLo != null && avgOdds != null
    ? strikeLo * avgOdds - 1
    : -Infinity;

  const bound = Math.min(normalLo, wilsonLo);
  return Number.isFinite(bound) ? bound : null;
}

// ---------------------------------------------------------------------------
// Cell summary
// ---------------------------------------------------------------------------

/**
 * Everything worth knowing about one slice of the settled book.
 *
 * `clvT` is the t-statistic of mean CLV against zero. It is the fastest signal
 * in here: beating the close is observable per bet, where a win is not, so a
 * band can show a credible CLV edge on a sample far too small to resolve yield.
 */
function summarise(rows, opts = {}) {
  const settled = rows.filter(isSettled);
  const n = settled.length;
  const wins = settled.filter(r => r.result === 'win').length;
  const profits = settled.map(profitOf).filter(p => p != null);
  const profit = profits.reduce((s, p) => s + p, 0);
  const clvRaw = settled.map(r => num(r.clv)).filter(v => v != null);
  const clvOutliers = clvRaw.filter(v => Math.abs(v) > CLV_LIMIT).length;
  const clvs = clvRaw.map(clampClv);
  const clvSd = stdev(clvs);

  const strike = n ? wins / n : null;
  const yieldPct = n ? profit / n : null;
  const ci = n >= (opts.minForCi ?? 5)
    ? bootstrapYield(profits, opts.bootstrap)
    : { lo: null, hi: null, iterations: 0 };

  return {
    n,
    wins,
    losses: n - wins,
    strike,
    strikeCi: wilson(wins, n),
    profit,
    profits,
    yield: yieldPct,
    yieldLo: ci.lo,
    yieldHi: ci.hi,
    avgOdds: mean(settled.map(r => num(r.detected_odds)).filter(v => v != null)),
    avgEdge: mean(settled.map(r => num(r.detected_edge)).filter(v => v != null)),
    avgClv: clvs.length ? mean(clvs) : null,
    medianClv: median(clvs),
    clvN: clvs.length,
    clvOutliers,
    clvT: clvs.length >= 2 && clvSd > 0
      ? mean(clvs) / (clvSd / Math.sqrt(clvs.length))
      : null,
    needForFivePoints: sampleNeeded(profits, 0.05),
  };
}

// ---------------------------------------------------------------------------
// Band table
// ---------------------------------------------------------------------------

/** Default edge cut-points for the descriptive table (not the sweep). */
const DEFAULT_EDGE_BANDS = [0.00, 0.02, 0.04, 0.06, 0.08, 0.10, 0.15, 0.25, Infinity];

/**
 * The descriptive picture: how the book performed across fixed edge bands, at
 * the odds window given. This is the table that shows the SHAPE of the edge
 * response — whether it rises to a peak and falls away (a real sweet spot) or
 * wanders (no signal yet). The sweep below only ever proposes a band; this is
 * what tells you whether proposing one is even warranted.
 */
function edgeBandTable(rows, { bands = DEFAULT_EDGE_BANDS, oddsMin = 0, oddsMax = Infinity } = {}) {
  const out = [];
  for (let i = 0; i < bands.length - 1; i++) {
    const edgeMin = bands[i];
    const edgeMax = Number.isFinite(bands[i + 1]) ? bands[i + 1] : null;
    const box = { oddsMin, oddsMax, edgeMin, edgeMax };
    out.push({ edgeMin, edgeMax, ...summarise(applyBox(rows, box)) });
  }
  return out;
}

/** The same, sliced by odds instead — context for whether the box's price window holds. */
const DEFAULT_ODDS_BANDS = [1.0, 1.4, 2.0, 3.0, 5.0, Infinity];

function oddsBandTable(rows, { bands = DEFAULT_ODDS_BANDS, edgeMin = 0, edgeMax = null } = {}) {
  const out = [];
  for (let i = 0; i < bands.length - 1; i++) {
    const oddsMin = bands[i];
    const oddsMax = bands[i + 1];
    const box = { oddsMin, oddsMax, edgeMin, edgeMax };
    out.push({ oddsMin, oddsMax, ...summarise(applyBox(rows, box)) });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Sweep
// ---------------------------------------------------------------------------

function range(from, to, step) {
  const out = [];
  // Accumulate on integers — 0.02 + 0.01 + 0.01 is not 0.04 in binary floating
  // point, and a band boundary that lands at 0.039999 silently reclassifies rows.
  const scale = 1000;
  for (let v = Math.round(from * scale); v <= Math.round(to * scale); v += Math.round(step * scale)) {
    out.push(v / scale);
  }
  return out;
}

const DEFAULT_SWEEP = {
  edgeMins: range(0.02, 0.10, 0.01),
  edgeMaxes: [...range(0.04, 0.20, 0.01), 0.25, 0.30, null],
  oddsMin: THRESHOLDS.PRIME_ODDS_MIN,
  oddsMax: THRESHOLDS.PRIME_ODDS_MAX,
  minSpan: 0.02,
  minSample: 20,
  alpha: 0.05,      // family-wise, split across every box the sweep tests
};

/**
 * Evaluates every (edgeMin, edgeMax) box at a fixed odds window and ranks by a
 * MULTIPLICITY-ADJUSTED LOWER BOUND on yield — never by yield itself.
 *
 * Two corrections, and the sweep is worthless without either:
 *
 *   • Lower bound, not point estimate. Ranking on the point estimate is exactly
 *     how the current box was picked, and the maximum of many noisy estimates
 *     is a biased estimate of the maximum. The lower bound is the yield a band
 *     has earned the right to claim, and it penalises thin samples on its own.
 *   • Šidák over the number of boxes actually eligible. Take the best of 250
 *     bands at the ordinary 5% level and you find a "winner" from pure noise
 *     essentially every time. The correction is applied to the eligible count,
 *     not the tested count, because boxes that failed the sample floor were
 *     never candidates for selection.
 */
function sweepBoxes(rows, opts = {}) {
  const cfg = { ...DEFAULT_SWEEP, ...opts };
  const candidates = [];
  let tested = 0;

  for (const edgeMin of cfg.edgeMins) {
    for (const edgeMax of cfg.edgeMaxes) {
      if (edgeMax != null && edgeMax - edgeMin < cfg.minSpan) continue;
      tested++;
      const box = { oddsMin: cfg.oddsMin, oddsMax: cfg.oddsMax, edgeMin, edgeMax };
      const stats = summarise(applyBox(rows, box));
      if (stats.n < cfg.minSample) continue;
      candidates.push({ box, ...stats });
    }
  }

  const perTestAlpha = sidakAlpha(cfg.alpha, candidates.length);
  const z = candidates.length ? normalQuantile(1 - perTestAlpha) : Z_95_TWO_SIDED;

  for (const c of candidates) {
    c.yieldLoAdj = yieldLowerBound({ profits: c.profits, wins: c.wins, avgOdds: c.avgOdds, z });
  }

  candidates.sort((a, b) => (b.yieldLoAdj ?? -Infinity) - (a.yieldLoAdj ?? -Infinity));
  return {
    tested,
    eligible: candidates.length,
    familyAlpha: cfg.alpha,
    perTestAlpha,
    z,
    candidates,
  };
}

// ---------------------------------------------------------------------------
// Recommendation
// ---------------------------------------------------------------------------

const CURRENT_BOX = {
  oddsMin: THRESHOLDS.PRIME_ODDS_MIN,
  oddsMax: THRESHOLDS.PRIME_ODDS_MAX,
  edgeMin: THRESHOLDS.PRIME_EDGE_MIN,
  edgeMax: THRESHOLDS.PRIME_EDGE_MAX,
};

function sameBox(a, b) {
  return a.edgeMin === b.edgeMin && a.edgeMax === b.edgeMax &&
         a.oddsMin === b.oddsMin && a.oddsMax === b.oddsMax;
}

const fmtBox = box =>
  `odds ${box.oddsMin.toFixed(2)}–${box.oddsMax === Infinity ? '∞' : box.oddsMax.toFixed(2)}, ` +
  `edge ${(box.edgeMin * 100).toFixed(1)}%–${box.edgeMax == null ? '∞' : `${(box.edgeMax * 100).toFixed(1)}%`}`;

/**
 * Turns the sweep into one of four verdicts. The gate is deliberately hard to
 * pass: a threshold that moves every time a weekend goes badly is not a
 * threshold, it is a random walk with extra steps.
 *
 *   'insufficient' — the current box has too few settled bets to judge at all.
 *   'hold'         — nothing beats the current box on evidence. The default.
 *   'advisory'     — a candidate beats it in-sample AND holds up out-of-sample,
 *                    but on a sample too small to act on. Watch it.
 *   'shift'        — the same, on a sample large enough to justify the edit.
 *
 * Out-of-sample agreement is required for both non-hold verdicts. A candidate
 * that only wins on the rows it was chosen from has demonstrated nothing.
 */
function recommend({ rows, outOfSampleRows, sweep, current = CURRENT_BOX, minSample = 100, confirmSample = 200 }) {
  const currentStats = summarise(applyBox(rows, current));
  // Score the incumbent at the SAME confidence the sweep used, so the two
  // numbers being compared are the same statistic. Judging the incumbent at 95%
  // while candidates face a corrected level would rig the comparison against it.
  currentStats.yieldLoAdj = yieldLowerBound({
    profits: currentStats.profits,
    wins: currentStats.wins,
    avgOdds: currentStats.avgOdds,
    z: sweep.z ?? Z_95_TWO_SIDED,
  });
  const currentOos = outOfSampleRows ? summarise(applyBox(outOfSampleRows, current)) : null;

  const best = sweep.candidates[0] ?? null;

  if (currentStats.n < minSample && !best) {
    return {
      status: 'insufficient',
      current: { box: current, ...currentStats, outOfSample: currentOos },
      candidate: null,
      reason:
        `Only ${currentStats.n} settled bets in the current PRIME box and no swept band ` +
        `cleared the minimum sample. Nothing here can move a threshold yet.`,
      betsNeeded: currentStats.needForFivePoints,
    };
  }

  if (!best || sameBox(best.box, current)) {
    return {
      status: currentStats.n < minSample ? 'insufficient' : 'hold',
      current: { box: current, ...currentStats, outOfSample: currentOos },
      candidate: best,
      reason: best && sameBox(best.box, current)
        ? 'The current PRIME box is already the best band by adjusted lower-bound yield. Hold.'
        : 'No candidate band clears the current box on adjusted lower-bound yield. Hold.',
      betsNeeded: currentStats.needForFivePoints,
    };
  }

  const bestOos = outOfSampleRows ? summarise(applyBox(outOfSampleRows, best.box)) : null;
  const beatsCurrent = (best.yieldLoAdj ?? -Infinity) > (currentStats.yieldLoAdj ?? -Infinity);
  const positiveLo = (best.yieldLoAdj ?? -Infinity) > 0;
  const holdsOos = bestOos == null || bestOos.n === 0 ? false : (bestOos.yield ?? -Infinity) > 0;

  if (!beatsCurrent || !positiveLo || !holdsOos) {
    const why = [];
    if (!beatsCurrent) why.push('it does not beat the current box on adjusted lower-bound yield');
    if (!positiveLo) why.push('its adjusted lower bound is still below break-even');
    if (!holdsOos) {
      why.push(bestOos && bestOos.n
        ? `it does not hold up out-of-sample (${bestOos.n} bets, ${(bestOos.yield * 100).toFixed(1)}% yield)`
        : 'it has no out-of-sample bets to confirm it');
    }
    return {
      status: currentStats.n < minSample ? 'insufficient' : 'hold',
      current: { box: current, ...currentStats, outOfSample: currentOos },
      candidate: { ...best, outOfSample: bestOos },
      reason: `Best swept band (${fmtBox(best.box)}) is not actionable: ${why.join('; ')}. Hold.`,
      betsNeeded: currentStats.needForFivePoints,
    };
  }

  const confirmed = best.n >= confirmSample;
  return {
    status: confirmed ? 'shift' : 'advisory',
    current: { box: current, ...currentStats, outOfSample: currentOos },
    candidate: { ...best, outOfSample: bestOos },
    reason:
      `${fmtBox(best.box)} beats the current box on adjusted lower-bound yield ` +
      `(${((best.yieldLoAdj ?? 0) * 100).toFixed(1)}% vs ${((currentStats.yieldLoAdj ?? 0) * 100).toFixed(1)}%) ` +
      `and stays positive out-of-sample (${bestOos.n} bets, ${(bestOos.yield * 100).toFixed(1)}%). ` +
      (confirmed
        ? `Sample (${best.n}) clears the confirmation bar — the edit to lib/signalTier.js is justified.`
        : `Sample is ${best.n}, short of the ${confirmSample} needed to act. Watch it; do not move the box yet.`),
    betsNeeded: confirmed ? 0 : confirmSample - best.n,
  };
}

module.exports = {
  profitOf,
  isSettled,
  inBox,
  applyBox,
  mean,
  stdev,
  median,
  clampClv,
  CLV_LIMIT,
  wilson,
  mulberry32,
  bootstrapYield,
  sampleNeeded,
  normalQuantile,
  sidakAlpha,
  yieldLowerBound,
  summarise,
  edgeBandTable,
  oddsBandTable,
  sweepBoxes,
  recommend,
  fmtBox,
  sameBox,
  CURRENT_BOX,
  DEFAULT_EDGE_BANDS,
  DEFAULT_ODDS_BANDS,
  DEFAULT_SWEEP,
};
