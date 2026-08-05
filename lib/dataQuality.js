/**
 * lib/dataQuality.js — the hard predicate upstream of scoring (§2.6).
 *
 * WHY THIS DID NOT EXIST AND SHOULD HAVE. `odds_drift_pct` runs 38–785% weekly
 * and `is_volatile` fires on 20–40% of signals, and until now NEITHER blocked
 * publication — they were recorded and ignored. So every "edge" published so far
 * was partly a measurement of data freshness rather than of price. The June 2026
 * week that looked extraordinary had 785% average odds drift and −56% weekly CLV
 * underneath it: an edge computed against a stale or thin price is not an edge,
 * it is a timestamp.
 *
 * A candidate must clear ALL of these before it is scored, let alone published.
 * Failing is not an error — it is the correct outcome for a price we do not
 * trust, and the reason is returned so a run can report what it dropped and why
 * rather than reporting a quiet day.
 *
 * ON THE FOURTH CHECK IN THE BRIEF. §2.6 asks for "maximum drift between capture
 * and use". A true drift check compares the price we captured against the price
 * that is live at the moment we act, and the engine cannot do that here: it has
 * one snapshot, not two. Rather than name something else `drift` — which is the
 * exact bug this whole audit was about, a column named after what it was meant
 * to hold — this module checks the two things it CAN measure honestly (age, and
 * dispersion across books) and leaves drift to a caller that has a second quote.
 * `dispersionPct` is named for what it is.
 */
'use strict';

const DEFAULTS = {
  /** Books quoting the market at all. Below this the consensus is not a consensus. */
  minBooksInMarket: 3,
  /** Books quoting THIS selection. One book's price is that book's opinion, not a market. */
  minBooksOnSelection: 2,
  /** How old the captured price may be when it is used, in minutes. */
  maxPriceAgeMinutes: 15,
  /**
   * How far the BEST price may sit above the mean across books, as a percentage.
   * A price far off the pack is either a palpable error or a book that has not
   * moved yet; both are edges against a number nobody will actually lay.
   */
  maxDispersionPct: 25,
};

/** Mean of the finite values of an {bookName: price} map. */
function meanPrice(allOdds) {
  const v = Object.values(allOdds ?? {}).map(Number).filter(n => Number.isFinite(n) && n > 1);
  return v.length ? v.reduce((a, b) => a + b, 0) / v.length : null;
}

/** How many books quoted this selection. */
function bookCount(allOdds) {
  return Object.values(allOdds ?? {}).map(Number).filter(n => Number.isFinite(n) && n > 1).length;
}

/**
 * Best price against the mean across books, as a percentage above it. Null when
 * fewer than two books priced the selection, because a single price has no pack
 * to be off.
 */
function dispersionPct(bestOdds, allOdds) {
  const n = bookCount(allOdds);
  if (n < 2) return null;
  const mean = meanPrice(allOdds);
  if (mean == null || !(bestOdds > 1)) return null;
  return ((bestOdds - mean) / mean) * 100;
}

/**
 * Does this candidate's price data deserve to be scored?
 *
 * @param {object} c
 * @param {number} c.bestOdds        the price we would publish
 * @param {object} c.allOdds         {bookName: price} for THIS selection
 * @param {number} c.booksInMarket   books quoting the market as a whole
 * @param {string|Date|null} c.oddsFetchedAt  when the price was captured
 * @param {Date} [c.now]
 * @param {object} [opts]            overrides for the thresholds above
 * @returns {{ok: boolean, reason: string|null, booksOnSelection: number,
 *            ageMinutes: number|null, dispersionPct: number|null}}
 */
function checkQuality(c, opts = {}) {
  const cfg = { ...DEFAULTS, ...opts };
  const now = c.now instanceof Date ? c.now : new Date();

  const booksOnSelection = bookCount(c.allOdds);
  const capturedMs = c.oddsFetchedAt ? new Date(c.oddsFetchedAt).getTime() : NaN;
  const ageMinutes = Number.isFinite(capturedMs) ? (now.getTime() - capturedMs) / 60_000 : null;
  const disp = dispersionPct(Number(c.bestOdds), c.allOdds);

  const out = { ok: false, reason: null, booksOnSelection, ageMinutes, dispersionPct: disp };

  if (!(Number(c.bestOdds) > 1)) {
    out.reason = 'no usable price';
    return out;
  }
  if (Number(c.booksInMarket ?? 0) < cfg.minBooksInMarket) {
    out.reason = `only ${c.booksInMarket ?? 0} book(s) quoting the market, need ${cfg.minBooksInMarket}`;
    return out;
  }
  if (booksOnSelection < cfg.minBooksOnSelection) {
    out.reason = `selection priced at ${booksOnSelection} book(s), need ${cfg.minBooksOnSelection}`;
    return out;
  }
  // An unknown capture time is a FAILURE, not a pass. A price we cannot date is
  // a price we cannot trust, and defaulting it to fresh is the fallback habit
  // that produced the whole audit.
  if (ageMinutes == null) {
    out.reason = 'price has no capture timestamp';
    return out;
  }
  if (ageMinutes > cfg.maxPriceAgeMinutes) {
    out.reason = `price is ${ageMinutes.toFixed(0)}m old, limit ${cfg.maxPriceAgeMinutes}m`;
    return out;
  }
  if (disp != null && disp > cfg.maxDispersionPct) {
    out.reason = `best price sits ${disp.toFixed(0)}% above the mean across ${booksOnSelection} books, limit ${cfg.maxDispersionPct}%`;
    return out;
  }

  out.ok = true;
  return out;
}

/** Env-configurable thresholds, so a threshold change needs no deploy. */
function thresholdsFromEnv(env = process.env) {
  const n = (k, fb) => {
    const v = parseFloat(env[k] ?? '');
    return Number.isFinite(v) ? v : fb;
  };
  return {
    minBooksInMarket:    n('DQ_MIN_BOOKS_IN_MARKET',    DEFAULTS.minBooksInMarket),
    minBooksOnSelection: n('DQ_MIN_BOOKS_ON_SELECTION', DEFAULTS.minBooksOnSelection),
    maxPriceAgeMinutes:  n('DQ_MAX_PRICE_AGE_MINUTES',  DEFAULTS.maxPriceAgeMinutes),
    maxDispersionPct:    n('DQ_MAX_DISPERSION_PCT',     DEFAULTS.maxDispersionPct),
  };
}

module.exports = { DEFAULTS, checkQuality, thresholdsFromEnv, bookCount, meanPrice, dispersionPct };
