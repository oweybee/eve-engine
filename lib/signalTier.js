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
 *     edge 4–10%: 56.5% strike, +6.5% ROI. That is the DIAMOND box — the only
 *     tier we highly suggest and the only tier that counts toward performance.
 *
 * Tiers:
 *   'diamond'  — suggested + tracked. odds ∈ [1.40, 3.00), edge ∈ [4%, 10%).
 *   'value'    — shown for visibility only, never tracked. Short odds, passes
 *                the floor, but outside the Diamond box (thin or over-fat edge).
 *   'longshot' — shown for visibility only, never a signal, never tracked.
 *                odds ≥ 3.00. `notable` flags the 6–10% edge sub-band so the
 *                best-of-the-longshots stand out without being suggested.
 *   null       — below the visibility floor (edge < 2%); not shown at all.
 */

const VALUE_MIN_EDGE   = 0.02; // below this an edge is noise — hide entirely
const DIAMOND_ODDS_MIN = 1.40;
const DIAMOND_ODDS_MAX = 3.00; // exclusive — 3.00 and up is a longshot
const DIAMOND_EDGE_MIN = 0.04;
const DIAMOND_EDGE_MAX = 0.10; // exclusive — 10%+ is miscalibration
const LONGSHOT_ODDS    = 3.00;
const NOTABLE_EDGE_MIN = 0.06;
const NOTABLE_EDGE_MAX = 0.10;

/**
 * Accepts either a plain `{odds, edge}` pair or a raw value_signals row
 * carrying `detected_odds` / `detected_edge` — so callers can pass a signal
 * object directly.
 *
 * @param {{odds?:number|string, edge?:number|string, detected_odds?:number|string, detected_edge?:number|string}} input
 * @returns {{tier:'diamond'|'value'|'longshot'|null, suggested:boolean, tracked:boolean, notable:boolean}}
 */
function classifyTier(input = {}) {
  const { odds, edge, detected_odds, detected_edge } = input;
  const o = Number(odds ?? detected_odds);
  const e = Number(edge ?? detected_edge);
  const none = { tier: null, suggested: false, tracked: false, notable: false };
  if (!Number.isFinite(o) || !Number.isFinite(e)) return none;
  if (e < VALUE_MIN_EDGE) return none;

  if (o >= DIAMOND_ODDS_MIN && o < DIAMOND_ODDS_MAX &&
      e >= DIAMOND_EDGE_MIN && e < DIAMOND_EDGE_MAX) {
    return { tier: 'diamond', suggested: true, tracked: true, notable: false };
  }

  if (o >= LONGSHOT_ODDS) {
    const notable = e >= NOTABLE_EDGE_MIN && e < NOTABLE_EDGE_MAX;
    return { tier: 'longshot', suggested: false, tracked: false, notable };
  }

  return { tier: 'value', suggested: false, tracked: false, notable: false };
}

/** Convenience: true only for the Diamond tier (suggested + tracked). */
function isDiamond(row) {
  return classifyTier(row).tier === 'diamond';
}

module.exports = {
  classifyTier,
  isDiamond,
  THRESHOLDS: {
    VALUE_MIN_EDGE,
    DIAMOND_ODDS_MIN, DIAMOND_ODDS_MAX,
    DIAMOND_EDGE_MIN, DIAMOND_EDGE_MAX,
    LONGSHOT_ODDS,
    NOTABLE_EDGE_MIN, NOTABLE_EDGE_MAX,
  },
};
