/**
 * EVE / Max Edge — Quant metrics library
 *
 * Pure, side-effect-free functions used by computeValues.js to derive the
 * professional-grade signals layered on top of the raw Dixon-Coles edge:
 *   - bookmaker consensus statistics       (Feature #3)
 *   - 0–100 model confidence score + tier  (Feature #2)
 *   - 0–100 proprietary Max Edge Score      (Feature #5)
 *   - expected-value profit per stake       (Feature #4)
 *
 * Everything here is deterministic on the odds + model probabilities already in
 * hand. Inputs that depend on accruing history (historical model accuracy, line
 * stability, CLV) are passed in as parameters with neutral defaults so the
 * scores degrade gracefully until the snapshot dataset exists.
 */

'use strict';

const OUTCOMES = ['home', 'draw', 'away'];

const clamp = (x, lo, hi) => Math.max(lo, Math.min(hi, x));

function median(arr) {
  if (!arr.length) return null;
  const s = [...arr].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

function mean(arr) {
  return arr.length ? arr.reduce((s, x) => s + x, 0) / arr.length : null;
}

// ---------------------------------------------------------------------------
// Feature #3 — Bookmaker consensus
// ---------------------------------------------------------------------------

/**
 * Builds per-outcome consensus statistics from soft-book rows.
 * @param {Array} softRows  [{ bookmaker, home_odds, draw_odds, away_odds }]
 * @param {Object} model    { home, draw, away } model probabilities (0–1)
 * @returns {Object} { home, draw, away } each: { median, mean, best, worst,
 *   count, consensusProb, consensusEdge, booksBelowFair, booksTotal,
 *   topBook, topBookPct } — or null for an outcome with no prices.
 */
function consensusStats(softRows, model) {
  const cols = { home: [], draw: [], away: [] };
  for (const r of softRows) {
    const vals = {
      home: parseFloat(r.home_odds),
      draw: parseFloat(r.draw_odds),
      away: parseFloat(r.away_odds),
    };
    for (const o of OUTCOMES) {
      if (Number.isFinite(vals[o]) && vals[o] > 1) {
        cols[o].push({ book: r.bookmaker, odds: vals[o] });
      }
    }
  }

  const per = {};
  const med = {};
  for (const o of OUTCOMES) {
    const odds = cols[o].map(x => x.odds);
    if (!odds.length) { per[o] = null; continue; }
    med[o] = median(odds);
    per[o] = {
      median: med[o],
      mean:   mean(odds),
      best:   Math.max(...odds),
      worst:  Math.min(...odds),
      count:  odds.length,
    };
  }

  // De-vig the median prices → consensus probability per outcome.
  const impl = o => (med[o] ? 1 / med[o] : 0);
  const totalImpl = impl('home') + impl('draw') + impl('away');

  for (const o of OUTCOMES) {
    if (!per[o]) continue;
    per[o].consensusProb = totalImpl > 0 ? impl(o) / totalImpl : null;
    per[o].consensusEdge =
      per[o].consensusProb != null ? model[o] - per[o].consensusProb : null;

    // A book "prices below fair value" when its implied prob < model prob,
    // i.e. its odds are LONGER than fair odds — that's value for us.
    const fairOdds = model[o] > 0 ? 1 / model[o] : Infinity;
    per[o].booksTotal = cols[o].length;
    per[o].booksBelowFair = cols[o].filter(x => x.odds > fairOdds).length;

    // The single book most above consensus median (the best price to take).
    let topBook = null, topPct = -Infinity;
    for (const x of cols[o]) {
      const pct = ((x.odds - per[o].median) / per[o].median) * 100;
      if (pct > topPct) { topPct = pct; topBook = x.book; }
    }
    per[o].topBook = topBook;
    per[o].topBookPct = Number.isFinite(topPct) ? topPct : 0;
  }

  return per;
}

/** Coefficient of variation of an outcome's odds (dispersion across books). */
function dispersion(softRows, outcome) {
  const odds = softRows
    .map(r => parseFloat(r[`${outcome}_odds`]))
    .filter(v => Number.isFinite(v) && v > 1);
  if (odds.length < 2) return 0;
  const m = mean(odds);
  const variance = odds.reduce((s, x) => s + (x - m) ** 2, 0) / odds.length;
  return m > 0 ? Math.sqrt(variance) / m : 0;
}

// ---------------------------------------------------------------------------
// Feature #2 — Confidence score (0–100) + tier
// ---------------------------------------------------------------------------

/**
 * @param {Object} i
 *   edgePct            best-outcome edge as decimal (0.05 = 5pp)
 *   marketAgreement    0–1, how closely the model agrees with the sharp/exchange
 *   liquidity          0–1 proxy (book coverage + exchange presence)
 *   consensusTightness 0–1, tighter soft pricing = higher
 *   histAccuracy       0–1, model hit-rate over history (neutral 0.5 until data)
 *   lineStability      0–1, how stable the line is (neutral 0.5 until snapshots)
 */
function confidenceScore(i) {
  const w = { edge: 0.30, agreement: 0.20, liquidity: 0.15, tightness: 0.15, hist: 0.10, stability: 0.10 };
  const edgeScore = clamp((i.edgePct ?? 0) / 0.10, 0, 1); // 10pp edge saturates
  const raw =
    w.edge      * edgeScore +
    w.agreement * clamp(i.marketAgreement ?? 0.6, 0, 1) +
    w.liquidity * clamp(i.liquidity ?? 0, 0, 1) +
    w.tightness * clamp(i.consensusTightness ?? 0.5, 0, 1) +
    w.hist      * clamp(i.histAccuracy ?? 0.5, 0, 1) +
    w.stability * clamp(i.lineStability ?? 0.5, 0, 1);
  return clamp(Math.round(raw * 100), 0, 100);
}

function confidenceTier(score) {
  if (score >= 80) return 'ELITE';
  if (score >= 60) return 'HIGH';
  if (score >= 40) return 'MEDIUM';
  return 'LOW';
}

// ---------------------------------------------------------------------------
// Feature #5 — Max Edge Score (0–100)
// ---------------------------------------------------------------------------

/**
 * @param {Object} i
 *   edgePct                best-outcome edge (decimal)
 *   confidence             0–100 confidence score
 *   consensusDisagreement  0–1, how far the best price sits above consensus
 *   liquidity              0–1 proxy
 *   clv                    0–1 historical CLV strength (neutral 0.5 until data)
 */
function maxEdgeScore(i) {
  const edgeScore = clamp((i.edgePct ?? 0) / 0.10, 0, 1);
  // Each contribution = weight × normalised input × 100, rounded. The score is
  // the SUM of the rounded contributions, so the breakdown always adds up
  // exactly — no hidden magic numbers (Feature requirement #5).
  const breakdown = {
    edge:       Math.round(0.35 * edgeScore * 100),
    confidence: Math.round(0.25 * clamp((i.confidence ?? 0) / 100, 0, 1) * 100),
    consensus:  Math.round(0.20 * clamp(i.consensusDisagreement ?? 0, 0, 1) * 100),
    liquidity:  Math.round(0.10 * clamp(i.liquidity ?? 0, 0, 1) * 100),
    clv:        Math.round(0.10 * clamp(i.clv ?? 0.5, 0, 1) * 100),
  };
  const score = clamp(
    breakdown.edge + breakdown.confidence + breakdown.consensus + breakdown.liquidity + breakdown.clv,
    0, 100
  );
  return { score, breakdown };
}

// ---------------------------------------------------------------------------
// Feature #4 — Expected value per stake
// ---------------------------------------------------------------------------

/**
 * Expected profit (not return) for a winning-or-losing single bet.
 * EV per £1 = p·odds − 1. Profit for stake S = S · (p·odds − 1).
 */
function evForStakes(modelProb, odds, stakes = [10, 50, 100]) {
  const evPerUnit = (modelProb != null && odds > 1) ? modelProb * odds - 1 : null;
  const profits = {};
  for (const s of stakes) profits[s] = evPerUnit != null ? +(s * evPerUnit).toFixed(2) : null;
  return { evPerUnit: evPerUnit != null ? +evPerUnit.toFixed(4) : null, profits };
}

// ---------------------------------------------------------------------------
// Signal tiers + Ruby (premium signal layer)
//
// Philosophy: High Value + High Probability = Exceptional Opportunity.
// A big edge on a 15%-probability longshot is NOT what we alert on. Ruby is the
// intersection of value and model confidence, and is deliberately scarce.
// ---------------------------------------------------------------------------

const RUBY     = { edge: 0.08, prob: 0.60, valueScore: 8.0 };
const STRONG   = { edge: 0.05, prob: 0.55 };
const STANDARD = { edge: 0.03 };

// ---------------------------------------------------------------------------
// Signal categorization — sweet-spot detection + outlier downgrade
//
// Parallel to the RUBY/STRONG/STANDARD tier system. Operates on edge magnitude
// and model probability to label each outcome for front-end display:
//   Prime         — edge in sweet spot AND model prob ≥ 15% → high priority, green
//   Longshot Edge — edge in sweet spot AND model prob <  15% → deprioritised, orange
//   Standard      — edge outside sweet spot (too thin or anomalously wide)
//
// Sweet spot is 5–25pp. Below 5pp the signal is routine and carries no badge.
// Above 25pp the market is likely stale, illiquid, or a data error — not
// actionable. The 15% model-probability floor filters genuine outsiders: even a
// large edge on a 10%-chance outcome is a statistically volatile bet whose EV
// is noise in a small sample.
// ---------------------------------------------------------------------------

/** Model probability floor below which a sweet-spot signal is demoted to Longshot Edge. */
const OUTSIDER_PROB_THRESHOLD = 0.15; // ≈ 6.50 / +550 decimal/American implied

const SWEET_SPOT_MIN = 0.05; // 5pp — minimum edge to leave Standard
const SWEET_SPOT_MAX = 0.25; // 25pp — ceiling above which the market is suspect

/**
 * @typedef {Object} SignalCategory
 * @property {'Prime'|'Longshot Edge'|'Standard'} tier
 * @property {'green'|'orange'|null}              badgeColor
 * @property {'high'|'low'|'none'}                displayPriority
 */

/**
 * Categorises a single outcome signal into Prime, Longshot Edge, or Standard.
 *
 * The `marketOdds` parameter is accepted for API symmetry and future use
 * (e.g. market-implied vs model-implied probability comparison) but the
 * current implementation keys solely on `modelProbability` for the outsider
 * check — we apply our own model's view of the outcome, not the market's.
 *
 * @param {number} modelProbability - Model win probability for this outcome (0–1)
 * @param {number} marketOdds       - Best available soft-book decimal odds (> 1)
 * @param {number} calculatedEdge   - Edge over soft-implied probability (decimal)
 * @returns {SignalCategory}
 */
function categorizeSignal(modelProbability, marketOdds, calculatedEdge) {
  const isSweetSpot = calculatedEdge >= SWEET_SPOT_MIN && calculatedEdge <= SWEET_SPOT_MAX;

  if (isSweetSpot) {
    if (modelProbability < OUTSIDER_PROB_THRESHOLD) {
      return { tier: 'Longshot Edge', badgeColor: 'orange', displayPriority: 'low' };
    }
    return { tier: 'Prime', badgeColor: 'green', displayPriority: 'high' };
  }

  return { tier: 'Standard', badgeColor: null, displayPriority: 'none' };
}

/**
 * Value Score on a 0–10 scale = edge(pp) × modelProb / 0.6, capped at 10.
 * Calibrated so the Ruby boundary (edge 8pp at 60% prob) scores exactly 8.0,
 * rewarding outcomes that pair a real edge with a genuinely likely result.
 */
function valueScore(edge, modelProb) {
  if (edge == null || modelProb == null) return 0;
  return +clamp((edge * 100) * modelProb / 0.6, 0, 10).toFixed(2);
}

/** True only when value AND probability AND composite all clear the Ruby bar. */
function isRuby(edge, modelProb, vScore) {
  return edge >= RUBY.edge && modelProb >= RUBY.prob && vScore >= RUBY.valueScore;
}

/** Per-outcome signal tier: 'RUBY' | 'STRONG' | 'STANDARD' | null. */
function signalTier(edge, modelProb, vScore) {
  if (edge == null || modelProb == null) return null;
  if (isRuby(edge, modelProb, vScore)) return 'RUBY';
  if (edge >= STRONG.edge && modelProb >= STRONG.prob) return 'STRONG';
  if (edge >= STANDARD.edge) return 'STANDARD';
  return null;
}

const TIER_RANK = { RUBY: 3, STRONG: 2, STANDARD: 1 };
/** Highest tier across a set of per-outcome tiers (or null). */
function bestTier(tiers) {
  let best = null, bestRank = 0;
  for (const t of tiers) {
    const r = TIER_RANK[t] ?? 0;
    if (r > bestRank) { bestRank = r; best = t; }
  }
  return best;
}

module.exports = {
  consensusStats,
  dispersion,
  confidenceScore,
  confidenceTier,
  maxEdgeScore,
  evForStakes,
  valueScore,
  isRuby,
  signalTier,
  bestTier,
  categorizeSignal,
  clamp,
  RUBY_CRITERIA:         RUBY,
  OUTSIDER_PROB_THRESHOLD,
  SWEET_SPOT_MIN,
  SWEET_SPOT_MAX,
};
