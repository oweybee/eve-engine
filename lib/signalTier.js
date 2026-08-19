'use strict';

/**
 * Canonical signal-tier classifier — the single source of truth for how a
 * pre-match value signal is tiered across the whole engine (posting + the
 * performance summary) and mirrored by the frontend.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * TWO THINGS LIVE IN THIS FILE AND THEY ARE NOT THE SAME THING. READ THIS FIRST.
 *
 *   1. THE ELIGIBILITY LADDER — `classifyTier` / `categoryFor` below, written to
 *      `value_signals.signal_category`. It answers "may we suggest this, and do
 *      we track it", from the price and the EV edge. It is the older of the two
 *      and it is the one the performance record is keyed on.
 *
 *   2. THE CONVICTION LADDER — `LABELS` / `bandFor` at the foot of this file,
 *      written to `value_signals.mxs_band`. It answers "how strongly does this
 *      read", from the MaxEdgeScore and nothing else.
 *
 * Until 6 Aug 2026 the first one's words — Prime / Value / Longshot — were also
 * printed on the site as badges, next to badges from the second one, which says
 * PRIME / STRONG / WATCH / SLIGHT / TRACE / NIL. Two of the words were shared and neither meant
 * the same thing on both sides: a board row said PRIME because its price sat in
 * the profitable box, and a match card said PRIME because MXS >= 65. The
 * frontend unified on the SECOND ladder (lib/semantics.ts) and the first one
 * kept its job and lost its words.
 *
 * So: `signal_category` is an eligibility bucket the product never prints, and
 * `mxs_band` is what a reader sees. Do not re-point one at the other.
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
  // `input ?? {}` as well as the default, because a default parameter only
  // covers `undefined`: `classifyTier(null)` threw on the destructure, and the
  // callers most likely to pass null are the ones handling a row that came back
  // empty. Found while pinning this file's behaviour on 6 Aug 2026.
  const { odds, edge, detected_odds, detected_edge } = input ?? {};
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
 * The persisted `signal_category` for a row — THE BUCKET KEY, LOWER CASE.
 *
 * IT USED TO TITLE-CASE THEM, AND THAT WAS THE WHOLE PROBLEM. 'Prime' /
 * 'Value' / 'Longshot' are badge words, and the product prints badge words off
 * the CONVICTION ladder — PRIME / STRONG / WATCH / SLIGHT / TRACE / NIL. Two
 * vocabularies sharing a word while meaning different things is what the 6 Aug
 * 2026 unification was for, and the header above says this ladder "kept its job
 * and lost its words". It kept the job. It did not lose the words: the mapping
 * below existed for no reason other than to produce them, and they went on
 * being written to the database for another twelve days.
 *
 * They contradict the badge beside them, measurably. In the live ledger:
 *   signal_category='Prime'  — 133 rows, MES 31 to 84, only 13 on a backed rung
 *   signal_category='Value'  — 476 rows, and the site's TOP score of 99
 * So a row reading "Prime" could be a SLIGHT, and the strongest reading on the
 * platform was a "Value". Whichever a reader believed, one of them was lying.
 *
 * Below-floor rows (classifyTier → null) are stored as 'value', the lowest
 * visible bucket: they carry a positive edge worth surfacing as a tool even
 * though they never qualify as a suggested pick.
 *
 * @param {object|string|null} input  a signal row, an {odds,edge} pair, or a raw tier string
 * @returns {'prime'|'value'|'longshot'}
 */
function categoryFor(input) {
  const tier = typeof input === 'string' ? input : classifyTier(input).tier;
  if (tier === 'prime')    return 'prime';
  if (tier === 'longshot') return 'longshot';
  return 'value';
}

/* ── The conviction ladder — the words the product actually prints ────────── */

/**
 * THE FOUR RUNGS, and the ONLY place their strings are written in this repo.
 *
 * Migration 048's `maxedge_band()` comment says "keep the label strings in sync
 * with LABELS in lib/signalTier.js", which was an instruction to a constant that
 * did not exist yet. It does now, and the three copies — this, the SQL function,
 * and `maxedgeBand()` in eve-frontend/lib/maxedge.ts — are the same four words
 * in the same order at the same cutoffs.
 *
 * Only PRIME is backed. The other three are deliberately neutral: calling a
 * reading "Strong" when you have declined to back it reads as a recommendation
 * you did not make, which is the failure the eligibility ladder's own words had.
 */
const LABELS = Object.freeze(['PRIME', 'STRONG', 'WATCH', 'SLIGHT', 'TRACE', 'NIL']);

/**
 * Score cutoffs, strongest first — and NOT ONE of them is a round number
 * somebody liked. maxedge_score() reads 100·(1 − 0.35^z) with z the gap in
 * error bars, so inverting it puts every cutoff on a round multiple of σ:
 *
 *     2.00σ → 87.75 → 88   PRIME
 *     1.00σ → 65.00 → 65   STRONG   ← the selection boundary, by construction
 *     0.50σ → 40.84 → 41   WATCH
 *     0.25σ → 23.08 → 23   SLIGHT
 *     0.10σ →  9.97 → 10   TRACE
 *
 * Keep in step with eve-frontend/lib/maxedge.ts BAND_MIN and maxedge_band() in
 * the database. All three are the same table; a fourth copy is how a band and a
 * score drift apart.
 */
const BAND_MIN = Object.freeze({
  PRIME: 88, STRONG: 65, WATCH: 41, SLIGHT: 23, TRACE: 10, NIL: 0,
});

/**
 * The rung for a MaxEdgeScore. Mirrors `maxedge_band(integer)` in migration 048.
 *
 * Returns null for a score that does not exist — never NIL. A null MXS means
 * we could not score the row (no measured sigma, or coverage below the floor),
 * and that is a different statement from "we scored it and found nothing". The
 * frontend renders the first as an absent badge and the second as ◇ NIL.
 *
 * @param {number|string|null|undefined} mxs
 * @returns {'PRIME'|'STRONG'|'WATCH'|'SLIGHT'|'TRACE'|'NIL'|null}
 */
function bandFor(mxs) {
  const n = Number(mxs);
  if (mxs === null || mxs === undefined || mxs === '' || !Number.isFinite(n)) return null;
  if (n >= BAND_MIN.PRIME)  return 'PRIME';
  if (n >= BAND_MIN.STRONG) return 'STRONG';
  if (n >= BAND_MIN.WATCH)  return 'WATCH';
  if (n >= BAND_MIN.SLIGHT) return 'SLIGHT';
  if (n >= BAND_MIN.TRACE)  return 'TRACE';
  return 'NIL';
}

/** True only for the backed rung. The engine's equivalent of `isPrime`, on the
 *  other ladder — and the reason both exist is that they can disagree, which is
 *  a fact about the row rather than a bug. */
function isBacked(mxs) {
  // TWO rungs are backed since the six-rung re-cut — PRIME at 2σ and STRONG at
  // 1σ — so this reads the cutoff rather than the top word. `=== 'PRIME'` here
  // would have silently stopped backing everything between 65 and 87, which is
  // most of what the engine actually selects.
  const band = bandFor(mxs);
  return band !== null && BAND_MIN[band] >= BAND_MIN.STRONG;
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
  // The conviction ladder — see the note at the head of this file on why these
  // are a separate pair of exports from the four above.
  LABELS,
  BAND_MIN,
  bandFor,
  isBacked,
  THRESHOLDS: {
    VALUE_MIN_EDGE,
    PRIME_ODDS_MIN, PRIME_ODDS_MAX,
    PRIME_EDGE_MIN, PRIME_EDGE_MAX,
    LONGSHOT_ODDS,
    NOTABLE_EDGE_MIN, NOTABLE_EDGE_MAX,
  },
};
