'use strict';

/**
 * Canonical signal-tier classifier — the single source of truth for how a
 * pre-match value signal is tiered across the whole engine (posting + the
 * performance summary) and mirrored by the frontend.
 *
 * Derived purely from the two facts already on every value_signals row —
 * detected_odds and detected_edge (EV) — so it can be applied at detection
 * time, at post time, and retroactively over historical rows with identical
 * results. It deliberately does NOT peek at the outcome: a tier is a filter
 * you can evaluate before kickoff, never a label assigned after the result.
 *
 * The bands come straight from the Jun 15 – Jul 3 back-test of the settled
 * book (see the performance recap):
 *
 *   • Every settled bet at odds ≥ 3.00 lost — 0 wins from 21. Longshots are
 *     shown for visibility but are never a suggested signal and never tracked.
 *   • Edges below 4% are noise (mostly longshots) and edges at/above 10% are
 *     model miscalibration — both tails bled heavily.
 *   • The only profitable cell in the whole matrix was odds 1.40–3.00 AND
 *     edge 4–10%: 56.5% strike, +6.5% ROI. That is the PRIME box — the only
 *     tier we highly suggest and the only tier that counts toward performance.
 *
 * Tiers (the conviction ladder):
 *   'prime'    — suggested + tracked. odds ∈ [1.40, 3.00), edge ∈ [4%, 10%).
 *   'value'    — shown for visibility only, never tracked. Short odds, passes
 *                the floor, but outside the Prime box (thin or over-fat edge).
 *   'longshot' — shown for visibility only, never a signal, never tracked.
 *                odds ≥ 3.00. `notable` flags the 6–10% edge sub-band so the
 *                best-of-the-longshots stand out without being suggested.
 *   null       — below the visibility floor (edge < 2%); not shown at all.
 *
 * A price-move (a re-detection at a shifted price) is an orthogonal event, not
 * a rung on this ladder — it is carried by the `is_mover` boolean on the row.
 */

const VALUE_MIN_EDGE  = 0.02; // below this an edge is noise — hide entirely
const PRIME_ODDS_MIN  = 1.40;
const PRIME_ODDS_MAX  = 3.00; // exclusive — 3.00 and up is a longshot
const PRIME_EDGE_MIN  = 0.04;
const PRIME_EDGE_MAX  = 0.10; // exclusive — 10%+ is miscalibration
const LONGSHOT_ODDS   = 3.00;
const NOTABLE_EDGE_MIN = 0.06;
const NOTABLE_EDGE_MAX = 0.10;

/**
 * Accepts either a plain `{odds, edge}` pair or a raw value_signals row
 * carrying `detected_odds` / `detected_edge` — so callers can pass a signal
 * object directly.
 *
 * @param {{odds?:number|string, edge?:number|string, detected_odds?:number|string, detected_edge?:number|string}} input
 * @returns {{tier:'prime'|'value'|'longshot'|null, suggested:boolean, tracked:boolean, notable:boolean}}
 */
function classifyTier(input = {}) {
  const { odds, edge, detected_odds, detected_edge } = input;
  const o = Number(odds ?? detected_odds);
  const e = Number(edge ?? detected_edge);
  const none = { tier: null, suggested: false, tracked: false, notable: false };
  if (!Number.isFinite(o) || !Number.isFinite(e)) return none;
  if (e < VALUE_MIN_EDGE) return none;

  if (o >= PRIME_ODDS_MIN && o < PRIME_ODDS_MAX &&
      e >= PRIME_EDGE_MIN && e < PRIME_EDGE_MAX) {
    return { tier: 'prime', suggested: true, tracked: true, notable: false };
  }

  if (o >= LONGSHOT_ODDS) {
    const notable = e >= NOTABLE_EDGE_MIN && e < NOTABLE_EDGE_MAX;
    return { tier: 'longshot', suggested: false, tracked: false, notable };
  }

  return { tier: 'value', suggested: false, tracked: false, notable: false };
}

/** Convenience: true only for the Prime tier (suggested + tracked). */
function isPrime(row) {
  return classifyTier(row).tier === 'prime';
}

/**
 * The persisted `signal_category` label for a row — the capitalised conviction
 * tier. Below-floor rows (classifyTier → null) are stored as 'Value', the
 * lowest visible rung, since they carry a positive edge worth surfacing as a
 * tool even though they never qualify as a suggested Prime pick.
 *
 * @param {object|string|null} input  a signal row, an {odds,edge} pair, or a raw tier string
 * @returns {'Prime'|'Value'|'Longshot'}
 */
function categoryFor(input) {
  const tier = typeof input === 'string' ? input : classifyTier(input).tier;
  if (tier === 'prime')    return 'Prime';
  if (tier === 'longshot') return 'Longshot';
  return 'Value';
}

/**
 * Conflict key — signals sharing this key are mutually exclusive: they are the
 * same match, same market and same line, so betting more than one is a wash
 * (a "Portugal home win" + "Portugal away win" guarantee one win + one loss).
 */
function conflictKey(r) {
  return `${r.match_id}|${r.market ?? 'h2h'}|${r.market_line ?? ''}`;
}

/**
 * Collapse mutually-exclusive signals to ONE per (match, market, line) — the
 * highest-edge outcome, i.e. the pick we would actually suggest. Prevents
 * opposing outcomes on the same match from cancelling each other out in the
 * broadcast feed and, critically, in the tracked performance figures.
 */
function dedupeConflicts(rows) {
  const best = new Map();
  for (const r of rows) {
    const k = conflictKey(r);
    const cur = best.get(k);
    if (!cur || Number(r.detected_edge) > Number(cur.detected_edge)) best.set(k, r);
  }
  return [...best.values()];
}

module.exports = {
  classifyTier,
  isPrime,
  categoryFor,
  conflictKey,
  dedupeConflicts,
  THRESHOLDS: {
    VALUE_MIN_EDGE,
    PRIME_ODDS_MIN, PRIME_ODDS_MAX,
    PRIME_EDGE_MIN, PRIME_EDGE_MAX,
    LONGSHOT_ODDS,
    NOTABLE_EDGE_MIN, NOTABLE_EDGE_MAX,
  },
};
