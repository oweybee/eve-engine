'use strict';

/**
 * lib/marketAnchor.js — WHERE FAIR VALUE COMES FROM, AND THE ONLY PLACE A
 * SIGNAL IS SCORED.
 *
 * THE RULING THIS FILE ENFORCES (6 Aug 2026). The market sets fair value and
 * generates every signal. The model is display-only and holds a veto, never a
 * vote. Nothing in this module accepts a model probability as an input to a
 * price, an edge or a score — the veto is a separate argument that can only
 * turn a signal OFF (see lib/modelVeto.js), and it is applied after scoring so
 * that it cannot possibly move a number.
 *
 * WHAT IT REPLACES. computeValues.js prices against MARKET_CONSENSUS: the
 * average of ~15 books, de-vigged and shaved 2%. That panel is mostly the soft
 * books whose prices we are trying to beat, so the "consensus" drifts toward
 * the very prices being evaluated and the comparison loses its reference point.
 * Measured over 198 settled selections it returned -47.0% yield at -24.94% CLV
 * — not a weak signal, an INVERTED one. The de-vigged Pinnacle line scored
 * Brier 0.3051 against the market's own 0.3050: zero information added.
 *
 * WHY PINNACLE ALONE IS THE ANCHOR. It is the sharpest liquid book in the
 * panel, it moves on money rather than on liability, and it is the reference
 * every published closing-line-value study uses. The 6 Aug 2026 backtest
 * measured Shin-de-vigged Pinnacle against the soft books at +6.58% CLV on
 * flagged selections versus -3.52% on unflagged, with a monotone gradient in
 * edge size. That gradient is the finding this file productionises.
 *
 * WHY SHIN AND NOT PROPORTIONAL DE-VIG — see lib/devig.js. Short version:
 * proportional de-vig manufactures edge on outsiders, and the flagged-longshot
 * book it produced went 1 from 49 for -70%.
 *
 * THE SCORE AND THE BAND ARE COMPUTED HERE, TOGETHER, ONCE. `score()` returns
 * both. There is no path that derives a band from anything but a score, because
 * a band and a score that can be computed apart are a band and a score that
 * will eventually disagree.
 */

const { shinDevig, fairPrice } = require('./devig');

/**
 * Books a UK-facing subscriber can realistically hold an account with, and
 * whose price we are therefore willing to call "available". A signal is a claim
 * that the reader can get this price; a book they cannot open makes that claim
 * false.
 *
 * Pinnacle is deliberately absent: it is the ANCHOR. Taking a price from the
 * same book that defines fair value would compare a number with itself and
 * report the vig back as edge.
 */
const BETTABLE_BOOKS = Object.freeze([
  'bet365', 'williamhill', 'betvictor', 'unibet_uk', 'betfair_sb_uk',
  'paddypower', 'skybet', 'betano', '10bet', 'dafabet', 'sbo', 'marathonbet',
]);

/**
 * Never a source of best price, each for a different reason:
 *   pinnacle          — the anchor (above).
 *   best              — a SYNTHETIC row the ingest writes, already the max of
 *                       the panel. Counting it inflates the book count and
 *                       re-derives the best price from itself.
 *   apifootball_live  — an in-play feed, not a pre-match quote.
 *   1xbet / onexbet / superbet — not realistically holdable by the UK audience
 *                       this board is written for, and historically the source
 *                       of the widest and least attainable prices.
 *   the exchanges     — betfair_ex_*, smarkets, matchbook quote pre-commission
 *                       and the available stake is whatever happens to be
 *                       resting. Treating that as a takeable price overstates
 *                       both the price and the liquidity.
 */
const EXCLUDED_BOOKS = Object.freeze([
  'pinnacle', 'best', 'apifootball_live', '1xbet', 'onexbet', 'superbet',
  'betfair_ex_uk', 'betfair_ex_eu', 'smarkets', 'matchbook',
]);

const BETTABLE_SET = new Set(BETTABLE_BOOKS);
const EXCLUDED_SET = new Set(EXCLUDED_BOOKS);

// ── The gate ────────────────────────────────────────────────────────────────
// Every one must pass. A selection that fails any of them is not a signal, and
// a thing that is not a signal carries no score — `score` is null, not zero, so
// that a failed gate can never be sorted or filtered as though it were a weak
// signal.

/** Below 2% the "edge" is inside the noise of a single price tick. */
const MIN_EDGE = 0.02;
/** Under 30% fair probability, the favourite-longshot bias dominates and the
 *  measured record is uniformly bad regardless of edge. */
const MIN_FAIR_PROB = 0.30;
/** The same fact expressed as a price ceiling. Both are checked: they agree in
 *  the middle and disagree at the boundary, where a fat edge on a 30% shot can
 *  push the takeable price past 4.50. */
const MAX_BEST_PRICE = 4.50;
/** Below six bettable books quoting, the "best price" is a thin sample and is
 *  usually one stale line rather than a real outlier. */
const MIN_BOOKS = 6;

// ── MES weights ─────────────────────────────────────────────────────────────
// One axis, 0-100, three components that sum to it.

/** A. Price quality — the edge itself, linear to a ceiling of 8%. */
const W_PRICE = 50;
const EDGE_CEILING = 0.08;
/** B. Likelihood — fair probability, ramped across the gated range [0.30, 0.75]. */
const W_LIKELIHOOD = 35;
const PROB_FLOOR = 0.30;
const PROB_SPAN = 0.45;
/** C. Confidence — how much the price itself can be trusted. UNVALIDATED: it
 *  was held constant through every backtest, so its weight is real but its
 *  discrimination is unproven. See CONFIDENCE_IS_UNVALIDATED below. */
const W_CONFIDENCE = 15;

/**
 * Component C was held at this value throughout all backtesting, which is why
 * its contribution is a constant offset in every historical figure quoted for
 * this system. Backtests that wish to reproduce those figures must pass
 * `confidence: HELD_CONSTANT_CONFIDENCE` rather than compute C.
 */
const HELD_CONSTANT_CONFIDENCE = 1;

/**
 * Component C is implemented (`confidence()` below) but its weight has never
 * been shown to improve band separation, because it was pinned for every
 * measurement that produced the thresholds. Treat a C-driven band change as
 * unproven until scripts/backtestConfidence.js says otherwise.
 */
const CONFIDENCE_IS_UNVALIDATED = true;

// ── Bands ───────────────────────────────────────────────────────────────────
const PRIME_MIN = 65;
const STRONG_MIN = 50;

/**
 * The band for a score. A PURE FUNCTION OF THE SCORE — it takes nothing else,
 * so there is no input that can make a band and its score disagree. Below
 * STRONG_MIN a selection is tracked but not published.
 *
 * @param {number|null} s
 * @returns {'PRIME'|'STRONG'|'TRACKED'|null}
 */
function bandFor(s) {
  if (s == null || !Number.isFinite(s)) return null;
  if (s >= PRIME_MIN) return 'PRIME';
  if (s >= STRONG_MIN) return 'STRONG';
  return 'TRACKED';
}

/** Is this band shown to a subscriber as a backed selection? */
function isPublishedBand(band) {
  return band === 'PRIME' || band === 'STRONG';
}

const clamp01 = x => (x < 0 ? 0 : x > 1 ? 1 : x);

/**
 * Coerce a numeric field. Not `Number(x)` — `Number(null)` is 0, and a zero
 * standing in for "absent" is the shape `no-restricted-syntax` bans in the
 * frontend and that has shipped here five times.
 */
function num(x) {
  if (x == null) return NaN;
  if (typeof x === 'string' && x.trim() === '') return NaN;
  const n = typeof x === 'number' ? x : Number(x);
  return Number.isFinite(n) ? n : NaN;
}

/**
 * Fair probabilities for a market from PINNACLE's prices alone, Shin-de-vigged.
 *
 * @param {Record<string, number|string>} pricesBySelection e.g. {home: 2.1, draw: 3.4, away: 3.6}
 * @param {string[]} order the selection keys, in the order they form the market
 * @returns {{fair: Record<string, number>, fairPrices: Record<string, number>,
 *            overround: number, z: number, arbitrage: boolean, reason: string|null}}
 */
function fairFromAnchor(pricesBySelection, order) {
  const odds = order.map(k => pricesBySelection?.[k]);
  const r = shinDevig(odds);
  if (r.probs === null) {
    return { fair: null, fairPrices: null, overround: r.overround, z: 0, arbitrage: false, reason: r.reason };
  }
  const fair = {};
  const fairPrices = {};
  order.forEach((k, i) => {
    fair[k] = r.probs[i];
    fairPrices[k] = fairPrice(r.probs[i]);
  });
  return { fair, fairPrices, overround: r.overround, z: r.z, arbitrage: r.arbitrage, reason: null };
}

/**
 * Best takeable price for one selection across bettable books, and how many
 * bettable books quoted it.
 *
 * `quotes` is a list of {bookmaker, odds}. Rows from excluded books are dropped
 * before both the max and the count, so `booksQuoting` is the number of books
 * whose price actually competed for best — the number the gate is about.
 *
 * @returns {{price: number|null, book: string|null, booksQuoting: number, prices: Array<{book:string,odds:number}>}}
 */
function bestBettablePrice(quotes) {
  const seen = new Map();   // one price per book — the latest, by caller's ordering
  for (const q of quotes ?? []) {
    const book = q?.bookmaker;
    if (!book || EXCLUDED_SET.has(book) || !BETTABLE_SET.has(book)) continue;
    const o = num(q.odds);
    if (!(o > 1)) continue;
    // Keep the best price this book offers if it appears more than once.
    const prev = seen.get(book);
    if (prev === undefined || o > prev) seen.set(book, o);
  }
  const prices = [...seen.entries()].map(([book, odds]) => ({ book, odds }));
  if (!prices.length) return { price: null, book: null, booksQuoting: 0, prices };
  let best = prices[0];
  for (const p of prices) if (p.odds > best.odds) best = p;
  return { price: best.odds, book: best.book, booksQuoting: prices.length, prices };
}

/**
 * Component C, 0-1. Three equally weighted signals of how much the quoted
 * price can be trusted:
 *
 *   books      more bettable books quoting means the best price is a genuine
 *              outlier rather than the only line on the board. 6 → 0, 12+ → 1.
 *   timing     a price far from kickoff has more time to move against you and
 *              is quoted into a thinner market. >72h → 0, ≤6h → 1.
 *   stability  how far the ANCHOR's fair probability has travelled since it
 *              opened. A market that has moved a long way is a market still
 *              finding its level, and the edge measured against it is less
 *              likely to survive to the close. 0 drift → 1, ≥5pp → 0.
 *
 * Every term degrades to the neutral-but-unhelpful end when its input is
 * absent, so a missing field lowers confidence rather than inventing it.
 *
 * @param {{booksQuoting?:number, hoursToKickoff?:number, fairProbDriftSinceOpen?:number}} x
 */
function confidence({ booksQuoting, hoursToKickoff, fairProbDriftSinceOpen } = {}) {
  const b = num(booksQuoting);
  const h = num(hoursToKickoff);
  const d = num(fairProbDriftSinceOpen);

  const booksTerm = Number.isFinite(b) ? clamp01((b - MIN_BOOKS) / 6) : 0;
  const timingTerm = Number.isFinite(h) ? 1 - clamp01((h - 6) / 66) : 0;
  const stabilityTerm = Number.isFinite(d) ? 1 - clamp01(Math.abs(d) / 0.05) : 0;

  return (booksTerm + timingTerm + stabilityTerm) / 3;
}

/**
 * Does this selection pass the gate? Returns every failure, not the first —
 * "why is the board empty" is a question that gets asked, and one reason at a
 * time is a slow way to answer it.
 *
 * `vetoed` is the ONLY model-derived input anywhere in this module, it is a
 * boolean, and it can only ever add a failure. There is no value of it that
 * makes a selection pass that would otherwise fail.
 */
function gate({ edge, fairProb, bestPrice, booksQuoting, vetoed = false }) {
  const failures = [];
  const e = num(edge), p = num(fairProb), o = num(bestPrice), b = num(booksQuoting);

  if (!Number.isFinite(e) || e < MIN_EDGE) failures.push('edge');
  if (!Number.isFinite(p) || p < MIN_FAIR_PROB) failures.push('fair_prob');
  if (!Number.isFinite(o) || o > MAX_BEST_PRICE) failures.push('best_price');
  if (!Number.isFinite(b) || b < MIN_BOOKS) failures.push('books');
  if (vetoed) failures.push('model_veto');

  return { pass: failures.length === 0, failures };
}

/**
 * MES and its band, computed together, from MARKET INPUTS ONLY.
 *
 * @param {{edge:number, fairProb:number, confidence?:number}} x
 *        `confidence` is component C's 0-1 input. Pass
 *        HELD_CONSTANT_CONFIDENCE to reproduce backtested figures.
 * @returns {{score:number, band:string, components:{A:number,B:number,C:number}}}
 */
function score({ edge, fairProb, confidence: c = HELD_CONSTANT_CONFIDENCE }) {
  const e = num(edge), p = num(fairProb);
  const cc = Number.isFinite(num(c)) ? clamp01(num(c)) : 0;

  const A = W_PRICE * clamp01(e / EDGE_CEILING);
  const B = W_LIKELIHOOD * clamp01((p - PROB_FLOOR) / PROB_SPAN);
  const C = W_CONFIDENCE * cc;

  const raw = A + B + C;
  const s = Math.round(raw);
  // One computation, one return: the band is derived from the score that is
  // returned alongside it, so the two cannot be produced separately and drift.
  return { score: s, band: bandFor(s), components: { A, B, C } };
}

/**
 * The whole path for ONE selection: fair value, best price, edge, gate, score.
 *
 * Ordering matters and is deliberate. The score is computed from `edge` and
 * `fairProb`, both of which come from the anchor and the bettable panel. The
 * veto is consulted only inside `gate()`. So a vetoed selection is a selection
 * whose score exists and is simply not published — the model cannot change the
 * number, only whether anyone sees it.
 *
 * A selection that fails the gate returns `score: null` and `band: null`. Not
 * zero: a zero sorts and filters like a real score.
 *
 * @param {object} x
 * @param {number} x.fairProb        Shin-de-vigged anchor probability
 * @param {number} x.bestPrice       best price among bettable books
 * @param {string} [x.bestBook]
 * @param {number} x.booksQuoting
 * @param {number} [x.hoursToKickoff]
 * @param {number} [x.fairProbDriftSinceOpen]
 * @param {boolean} [x.vetoed]       from lib/modelVeto.js — suppression only
 * @param {number} [x.confidenceOverride] pass HELD_CONSTANT_CONFIDENCE in backtests
 */
function evaluate({
  fairProb, bestPrice, bestBook = null, booksQuoting,
  hoursToKickoff, fairProbDriftSinceOpen,
  vetoed = false, confidenceOverride,
}) {
  const p = num(fairProb);
  const o = num(bestPrice);
  const edge = (Number.isFinite(p) && Number.isFinite(o) && o > 1)
    ? p * o - 1
    : null;

  const c = confidenceOverride !== undefined
    ? confidenceOverride
    : confidence({ booksQuoting, hoursToKickoff, fairProbDriftSinceOpen });

  const g = gate({ edge, fairProb: p, bestPrice: o, booksQuoting, vetoed });
  const scored = score({ edge, fairProb: p, confidence: c });

  return {
    fairProb: Number.isFinite(p) ? p : null,
    fairPrice: fairPrice(p),
    bestPrice: Number.isFinite(o) ? o : null,
    bestBook,
    booksQuoting: Number.isFinite(num(booksQuoting)) ? num(booksQuoting) : 0,
    edge,
    vetoed: !!vetoed,
    passes: g.pass,
    failures: g.failures,
    // A signal only carries a score. Everything else is a row we keep for
    // measurement and never present as a backed selection.
    score: g.pass ? scored.score : null,
    band: g.pass ? scored.band : null,
    components: scored.components,
    // Kept for the tracked-but-unpublished set, so band separation can be
    // measured over selections the gate rejected.
    shadowScore: scored.score,
    shadowBand: scored.band,
    confidence: c,
  };
}

module.exports = {
  fairFromAnchor,
  bestBettablePrice,
  confidence,
  gate,
  score,
  bandFor,
  isPublishedBand,
  evaluate,
  BETTABLE_BOOKS,
  EXCLUDED_BOOKS,
  HELD_CONSTANT_CONFIDENCE,
  CONFIDENCE_IS_UNVALIDATED,
  THRESHOLDS: {
    MIN_EDGE, MIN_FAIR_PROB, MAX_BEST_PRICE, MIN_BOOKS,
    W_PRICE, EDGE_CEILING, W_LIKELIHOOD, PROB_FLOOR, PROB_SPAN, W_CONFIDENCE,
    PRIME_MIN, STRONG_MIN,
  },
};
