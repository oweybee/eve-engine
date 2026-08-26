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
// THE FLOOR IS 5%, AND THE BAND IT CLOSES IS THE REASON.
//
// Inside the price box, over 163 settled fixtures, everything below 5% returns
// -11.88% at clustered z -1.51. Broken out: 3.0-3.9% is -3.67%, and 4.0-4.9%
// is -19.36% and has been negative in EVERY period since June (-9.6 / -56.4 /
// -19.8). This is not a band that is merely unproven; it is the one cohort on
// the board that has consistently lost money.
//
// It was 3% from 22 Aug 2026 until now, lowered then to match `f(edge)`'s
// plateau. The plateau moves WITH it — `EDGE_EFFICIENCY.rampTo` reads this
// constant — so the two cannot drift apart by editing one of them.
const PRIME_EDGE_MIN  = 0.05;
const PRIME_EDGE_MAX  = 0.07; // exclusive — the band is 5.00% to 6.99%

// THE SECOND BACKED BAND. 7.0-9.9% returns +18.45% over 44 fixtures (z 0.91) —
// positive, and worth backing, but NOT the same thing as the band above:
// its no-vig CLV is -2.02% against PRIME's +0.86%, and on a 30-day window 60%
// of its net units come from a single fixture. Backed, one rung down, and
// never promotable into PRIME however it scores.
const EDGE_EDGE_MIN   = 0.07;
const EDGE_EDGE_MAX   = 0.10; // exclusive — 10%+ is miscalibration

const LONGSHOT_ODDS   = 3.00;

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

  const inPriceBox = o >= PRIME_ODDS_MIN && o < PRIME_ODDS_MAX;

  if (inPriceBox && e >= PRIME_EDGE_MIN && e < PRIME_EDGE_MAX) {
    return { tier: 'prime', suggested: true, tracked: true, notable: false };
  }

  // SUGGESTED BUT NOT TRACKED, and the asymmetry is deliberate (owner, 26 Aug).
  //
  // `suggested` means WE BROADCAST IT. `tracked` means IT FEEDS THE HEADLINE
  // RECORD. EDGE is the first rung where those come apart: it goes to the
  // channel like a PRIME does, and it is settled and measured like one, but the
  // published record covers PRIME alone.
  //
  // WHAT THIS COSTS AND WHAT PAYS FOR IT. A record that omits picks we
  // broadcast is "we count our best band" unless it is disclosed every time it
  // is quoted. `performance_band.headline_scope_note` carries that disclosure
  // FROM THE DATABASE so a frontend edit cannot drop it, and the EDGE tab is
  // styled to the same weight as PRIME. If EDGE ever stops being shown that
  // prominently, flip this back to `tracked: true` rather than keeping the
  // flattering number.
  //
  // EDGE performance is NOT lost by this flag: `performance_band` computes
  // straight off value_signals by edge band and never reads `tracked`.
  if (inPriceBox && e >= EDGE_EDGE_MIN && e < EDGE_EDGE_MAX) {
    return { tier: 'edge', suggested: true, tracked: false, notable: false };
  }

  if (o >= LONGSHOT_ODDS) {
    // `notable` now points at the SAME band the product backs at short prices,
    // so "the best of the longshots" means the band with the measured edge
    // rather than a range chosen separately.
    const notable = e >= PRIME_EDGE_MIN && e < EDGE_EDGE_MAX;
    return { tier: 'longshot', suggested: false, tracked: false, notable };
  }

  return { tier: 'value', suggested: false, tracked: false, notable: false };
}

/** Convenience: true only for the Prime tier. */
function isPrime(row) {
  return classifyTier(row).tier === 'prime';
}

/** True for either backed band — the predicate most callers actually want. */
function isSuggested(row) {
  return classifyTier(row).suggested === true;
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
  if (tier === 'edge')     return 'edge';
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
 * and `maxedgeBand()` in eve-frontend/lib/maxedge.ts — are the same five words
 * in the same order at the same cutoffs.
 *
 * Only PRIME is backed. The other four are deliberately neutral: calling a
 * reading "Strong" when you have declined to back it reads as a recommendation
 * you did not make, which is the failure the eligibility ladder's own words had
 * — and it is why STRONG was retired on 21 Aug rather than moved down a rung.
 */
// EDGE sits between PRIME and WATCH and is the only rung on this list that is
// NOT a score band — it is a BOX rung, which is why it has no BAND_MIN entry.
const LABELS = Object.freeze(['PRIME', 'EDGE', 'WATCH', 'SLIGHT', 'TRACE', 'NIL']);

/**
 * Score cutoffs, strongest first — and NOT ONE of them is a round number
 * somebody liked. maxedge_score() reads 100·(1 − 0.35^z) with z the gap in
 * error bars, so inverting it puts every cutoff on a round multiple of σ:
 *
 *     1.00σ → 65.00 → 65   PRIME    ← the selection boundary, by construction
 *     0.50σ → 40.84 → 41   WATCH
 *     0.25σ → 23.08 → 23   SLIGHT
 *     0.10σ →  9.97 → 10   TRACE
 *
 * THE 2σ RUNG IS RETIRED (21 Aug 2026, owner ruling, migration 089). It was 88,
 * it was a round multiple of σ like the rest, and NOT ONE ROW ON THE DE-VIGGED
 * BASIS EVER REACHED IT — max 83 over 300 rows. Both publishing architectures
 * are bounded far below it: MARKET_ANCHORED's widest gap ever measured is
 * 4.58pp and DIXON_COLES's is 5.09pp, against the 6.06pp 2σ requires at their
 * σ of 0.0300. The top rung named a band nothing occupies while the word the
 * product publishes sat one rung down.
 *
 * NO CUTOFF MOVED. The dead boundary was removed and the top WORD came down to
 * the top band that exists. STRONG is retired rather than re-pointed at 41,
 * because a strength word over a reading we decline to back is the 5 Aug ruling
 * — and the settled record agrees: the 0.5σ band is -6.22% over 96 fixtures.
 *
 * Keep in step with eve-frontend/lib/maxedge.ts BAND_MIN and maxedge_band() in
 * the database. All three are the same table; a fourth copy is how a band and a
 * score drift apart.
 */
// THESE ARE NO LONGER ROUND MULTIPLES OF SIGMA, AND THAT IS THE POINT.
// The old cutoffs inverted 100·(1 − 0.35^z) so every line sat on a whole error
// bar. That was the right discipline while the SCORE was the selector. It is
// not any more — `rungFor` selects, and these lines now do one job: say how
// well a row must read to keep the rung its box earned. 60 is chosen, not
// derived, and is documented as chosen.
//
// WHY 60 AND NOT 65. Against the current book, 12 of 25 in-box PRIME rows clear
// 60 and would wear the word; at 65 that falls to a handful. 60 also keeps the
// range open to 99 on purpose — a top rung with no headroom is the mistake the
// retired 2σ rung made pointing the other way.
const BAND_MIN = Object.freeze({
  PRIME: 60, WATCH: 41, SLIGHT: 23, TRACE: 10, NIL: 0,
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
 * @returns {'PRIME'|'WATCH'|'SLIGHT'|'TRACE'|'NIL'|null}
 */
function bandFor(mxs) {
  const n = Number(mxs);
  if (mxs === null || mxs === undefined || mxs === '' || !Number.isFinite(n)) return null;
  if (n >= BAND_MIN.PRIME)  return 'PRIME';
  if (n >= BAND_MIN.WATCH)  return 'WATCH';
  if (n >= BAND_MIN.SLIGHT) return 'SLIGHT';
  if (n >= BAND_MIN.TRACE)  return 'TRACE';
  return 'NIL';
}

/**
 * Cap a SCORE band at WATCH.
 *
 * NOT `[band, 'WATCH'].sort()[0]`, and not SQL's `least(band, 'WATCH')` — text
 * comparison is alphabetical and 'PRIME' sorts BEFORE 'WATCH', so the obvious
 * spelling of this silently lets an out-of-box row keep the top word. The SQL
 * mirror had exactly that bug for the length of one draft.
 */
function capAtWatch(band) {
  return band === 'PRIME' ? 'WATCH' : band;
}

/**
 * THE WORD THE PRODUCT PRINTS. Mirrors `signal_rung()` in migration 102 and
 * `rungFor()` in eve-frontend/lib/maxedge.ts.
 *
 * The box picks the rung; the score can only demote. A row cannot be promoted
 * into a backed rung by scoring well outside the box, and a row inside the box
 * that reads badly drops rather than keeping a word it has not earned.
 *
 * A null mxs returns null, never 'NIL' — "we could not score it" and "we scored
 * it and found nothing" are different statements and the frontend draws them
 * differently.
 */
function rungFor(row = {}) {
  const { odds, edge, detected_odds, detected_edge, mxs } = row ?? {};
  const o = Number(odds ?? detected_odds);
  const e = Number(edge ?? detected_edge);
  const s = Number(mxs);
  if (mxs === null || mxs === undefined || !Number.isFinite(s)) return null;
  if (!Number.isFinite(o) || !Number.isFinite(e)) return null;

  const band = bandFor(s);
  const tier = classifyTier({ odds: o, edge: e }).tier;

  if (tier === 'prime') {
    if (s >= BAND_MIN.PRIME) return 'PRIME';
    if (s >= BAND_MIN.WATCH) return 'EDGE';
    return band;
  }
  if (tier === 'edge') {
    return s >= BAND_MIN.WATCH ? 'EDGE' : band;
  }
  return capAtWatch(band);
}

/**
 * True only for a backed rung — now a property of the ROW, not of the score.
 *
 * IT TAKES A ROW NOW AND IT USED TO TAKE A NUMBER. Every caller had to move.
 * A bare number reaching `rungFor` destructures to undefined odds and edge,
 * returns null, and this returns false — so nothing throws and the broadcast
 * channel simply goes quiet. That is the failure mode to watch for if a call
 * site was missed; it does not announce itself.
 */
function isBacked(row) {
  const rung = rungFor(row);
  return rung === 'PRIME' || rung === 'EDGE';
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
  isSuggested,
  categoryFor,
  conflictKey,
  dedupeConflicts,
  // The conviction ladder — see the note at the head of this file on why these
  // are a separate pair of exports from the four above.
  LABELS,
  BAND_MIN,
  bandFor,
  capAtWatch,
  rungFor,
  isBacked,
  THRESHOLDS: {
    VALUE_MIN_EDGE,
    PRIME_ODDS_MIN, PRIME_ODDS_MAX,
    PRIME_EDGE_MIN, PRIME_EDGE_MAX,
    EDGE_EDGE_MIN, EDGE_EDGE_MAX,
    LONGSHOT_ODDS,
  },
};
