'use strict';

/**
 * lib/marketAnchorTotals.js — the Pinnacle-anchored method, on over/under.
 *
 * MARKET_ANCHORED_TOTALS IS A SEPARATE, UNPUBLISHED MODEL. It is the h2h rule
 * (computeValues.js `computeConsensus`) applied to a two-way market:
 *
 *     edge = pinnacleShinProb[side] * best_takeable_price[side] - 1
 *
 * and it is written under its OWN name because `publish` lives on the
 * architecture. Under 'MARKET_ANCHORED' these rows would inherit that model's
 * owner-granted publication the moment they were written. Its
 * `model_calibration` row says publish = false; `lib/publication.js` fails
 * closed on it besides. It goes to `paper_trades` and nowhere else until
 * `paper_trade_gate()` says PASS and the owner rules.
 *
 * THREE RULES, EACH A WAY TO MANUFACTURE AN EDGE THAT DOES NOT EXIST:
 *
 *   1. ONE LINE AT A TIME. Pinnacle's 2.5 de-vig is compared only with other
 *      books' 2.5 prices. A 2.5 over price set against a 2.75 fair line is a
 *      different bet, and interpolating between lines invents a fair price
 *      nobody quoted.
 *   2. HALF-GOAL LINES ONLY. A whole or quarter line can push, so its decimal
 *      price is not a win/lose bet and `p * odds - 1` is not its EV. Skipped,
 *      not approximated.
 *   3. A FRESH ANCHOR. Pinnacle's quote must have been seen inside the same
 *      hour the h2h price-paper log requires (migration 147); so must every
 *      soft-book quote counted. An hour-old poll of a book is not a price.
 *
 * THE FILTERS ARE THE h2h PAPER FILTERS, NOT THE PUBLISHED GATE. books >= 3,
 * best > fair, best < 5.0 — the rule migration 147 logs, on purpose: this
 * measures whether the RAW signal is real before anything is layered on it.
 * The 30% implausible-edge cap from computeValues.js is kept, because a 30%
 * edge on a total is a stale quote, not a finding.
 *
 * Every hit is SCORED with the same `scoreSignal` h2h uses — model side the
 * Shin-de-vigged Pinnacle probability, market side the Shin de-vig of the best
 * takeable over/under pair at the same line. A hit that cannot be scored is not
 * returned: no row is written without a score.
 *
 * Pure: no I/O, no clock unless one is passed. paperTradeTotals.js does the I/O.
 */

const { shinDevig } = require('./devig');
const { scoreSignal } = require('./maxedge');
const { TAKEABLE_BOOKS } = require('./marketAnchor');

const ARCHITECTURE = 'MARKET_ANCHORED_TOTALS';
const ANCHOR_BOOK = 'pinnacle';

/** The h2h paper filters (migration 147), applied per side. */
const MIN_BOOKS = 3;
const MAX_PRICE = 5.0;
/** computeValues.js MAX_PLAUSIBLE_EDGE — above it the input price is distrusted. */
const MAX_PLAUSIBLE_EDGE = 0.30;
/** A quote not re-confirmed inside this window is not a current price. */
const MAX_QUOTE_AGE_MS = 60 * 60_000;

const TAKEABLE = new Set(TAKEABLE_BOOKS);

function num(x) {
  if (x == null) return NaN;
  if (typeof x === 'string' && x.trim() === '') return NaN;
  const n = typeof x === 'number' ? x : Number(x);
  return Number.isFinite(n) ? n : NaN;
}

/** x.5 and nothing else. 2.25, 2.75 and 3.0 can push; 2.5 cannot. */
function isHalfGoalLine(line) {
  const l = num(line);
  if (!Number.isFinite(l) || l <= 0) return false;
  return Math.abs((l * 2) % 2 - 1) < 1e-9;
}

function isFresh(q, nowMs) {
  const t = Date.parse(q?.confirmed_at ?? '');
  return Number.isFinite(t) && nowMs - t <= MAX_QUOTE_AGE_MS && t <= nowMs + 60_000;
}

/**
 * Hits for ONE fixture.
 *
 * @param {Array<{bookmaker:string, market:string, market_line:number,
 *                home_odds:number, away_odds:number, confirmed_at:string}>} quotes
 *        `odds_latest` rows. On a totals row home_odds is OVER, away_odds UNDER.
 * @param {{now?: number}} opts
 * @returns {Array<object>} one entry per qualifying (line, side), scored
 */
function evaluateFixture(quotes, { now = Date.now() } = {}) {
  const byLine = new Map();
  for (const q of quotes ?? []) {
    if ((q?.market ?? '') !== 'totals') continue;
    if (!isHalfGoalLine(q.market_line)) continue;
    if (!isFresh(q, now)) continue;
    const key = num(q.market_line);
    if (!byLine.has(key)) byLine.set(key, []);
    byLine.get(key).push(q);
  }

  const hits = [];
  for (const [line, rows] of byLine) {
    const pin = rows.find(r => r.bookmaker === ANCHOR_BOOK);
    if (!pin) continue;
    const anchor = shinDevig([pin.home_odds, pin.away_odds]);
    // An arbitrage-shaped anchor is a mispulled leg, never a real price.
    if (!anchor.probs || anchor.arbitrage) continue;
    const fair = { over: anchor.probs[0], under: anchor.probs[1] };

    // One price per takeable book per side, at THIS line.
    const sides = { over: new Map(), under: new Map() };
    for (const r of rows) {
      if (!TAKEABLE.has(r.bookmaker)) continue;
      const o = num(r.home_odds), u = num(r.away_odds);
      if (o > 1 && o < 1000) sides.over.set(r.bookmaker, Math.max(o, sides.over.get(r.bookmaker) ?? 0));
      if (u > 1 && u < 1000) sides.under.set(r.bookmaker, Math.max(u, sides.under.get(r.bookmaker) ?? 0));
    }
    const best = {};
    for (const s of ['over', 'under']) {
      let price = 0, book = null, sum = 0;
      for (const [b, p] of sides[s]) {
        sum += p;
        if (p > price || (p === price && b < book)) { price = p; book = b; }
      }
      best[s] = { price, book, books: sides[s].size, avg: sides[s].size ? sum / sides[s].size : null };
    }

    // The market side of the score: the takeable panel's own best pair,
    // margin removed. No pair, no score — and no row.
    const panel = best.over.books && best.under.books
      ? shinDevig([best.over.price, best.under.price]) : { probs: null };
    const marketProb = panel.probs ? { over: panel.probs[0], under: panel.probs[1] } : null;

    for (const side of ['over', 'under']) {
      const b = best[side];
      const p = fair[side];
      if (b.books < MIN_BOOKS) continue;
      if (!(b.price > 1 / p)) continue;              // best price > fair
      if (!(b.price < MAX_PRICE)) continue;
      const edge = Math.round((p * b.price - 1) * 1e6) / 1e6;
      if (edge > MAX_PLAUSIBLE_EDGE) continue;
      if (!marketProb) continue;

      const scored = scoreSignal({
        detected_odds: b.price,
        detected_edge: edge,
        model_prob: p,
        market_prob: marketProb[side],
        model_architecture: ARCHITECTURE,
      });
      if (scored.mxs == null) continue;              // never a row without a score

      hits.push({
        market: 'totals',
        market_line: line,
        selection: side,
        price: b.price,
        book: b.book,
        books_quoting: b.books,
        price_avg: Math.round(b.avg * 1e4) / 1e4,
        fair_odds: Math.round((1 / p) * 1e4) / 1e4,
        anchor_odds: { over: num(pin.home_odds), under: num(pin.away_odds) },
        anchor_confirmed_at: pin.confirmed_at,
        edge,
        ...scored,
      });
    }
  }
  return hits;
}

module.exports = {
  evaluateFixture,
  isHalfGoalLine,
  ARCHITECTURE,
  ANCHOR_BOOK,
  THRESHOLDS: { MIN_BOOKS, MAX_PRICE, MAX_PLAUSIBLE_EDGE, MAX_QUOTE_AGE_MS },
};
