'use strict';

/**
 * lib/momentum.js — the live match state, recorded so it can one day be scored.
 *
 * WHY THIS EXISTS AS A CORPUS AND NOT AS A MODEL. The obvious thing to do with
 * possession and shots is to move the goal expectation with them. There is no
 * measurement in this repo for what a possession share is worth in goals, and
 * there CANNOT be one from the data as it stood: `match_stats` is upserted on
 * (fixture_id, team_side), so it holds exactly ONE overwritten snapshot per
 * fixture — 2,276 rows across 1,138 fixtures, never more than one per side.
 * No record of what any match looked like at minute 60 exists anywhere.
 *
 * So a momentum model could not be fitted, and could not be measured, and
 * anything shipped today would be numbers somebody made up wearing the clothes
 * of evidence — which is the failure `model_calibration`, the publication gate
 * and `trg_score_needs_measured_sigma` all exist to prevent.
 *
 * `inplay_momentum` is therefore accumulated FIRST. Once it carries a few weeks
 * of ticks, each row can be joined to what actually happened after it, and the
 * question "does dominance predict the next goal, beyond the scoreline" becomes
 * a measurement. Until then NOTHING here moves a price.
 *
 * THE ONE EXCEPTION IS A SENDING-OFF, and it lives in lib/inplayState.js
 * because it IS measured — x0.6178 / x1.6018 over 10,215 matches in
 * `match_results`, which records red cards for completed games and so needed no
 * new corpus.
 *
 * FIELD NAMES ARE THE FEED'S, VERIFIED AGAINST IT. Counted over every stat
 * API-Football has sent us:
 *
 *     Corner Kicks 1950/1978    Shots on Goal 1962    Ball Possession 1962
 *     Total Shots  1814         Shots insidebox 1810  Goalkeeper Saves 1798
 *     Red Cards     436/1978    expected_goals  1156/1966   <- 59%, PARTIAL
 *
 * xG IS ABSENT ON FOUR ROWS IN TEN and that is a property of the competition,
 * not of the match — so it must never be defaulted. A model fitted on xG that
 * silently reads 0 where the feed is quiet would learn which leagues report xG.
 */

/** Exact API-Football stat names. Wrong string ⇒ silent null, so they are pinned. */
const STAT = Object.freeze({
  shots:   'Total Shots',
  sot:     'Shots on Goal',
  inside:  'Shots insidebox',
  corners: 'Corner Kicks',
  poss:    'Ball Possession',
  xg:      'expected_goals',
  saves:   'Goalkeeper Saves',
  reds:    'Red Cards',
});

/**
 * A NULL VALUE MEANS "NONE" FOR RED CARDS AND "UNKNOWN" FOR EVERYTHING ELSE,
 * and that split is measured rather than assumed.
 *
 * The feed sends `{ type: 'expected_goals', value: null }` on 41% of rows, and
 * the obvious reading — no chances yet — is wrong. Those rows average **12.9
 * shots**, and 777 of 1,120 have shots ON TARGET. A side that has had thirteen
 * attempts does not have an xG of zero; the competition simply is not tracked.
 * Writing 0 there would teach a model which leagues report xG.
 *
 * Red Cards is the opposite and is the one exception: a value appears on 436 of
 * 1,978 rows, which is about the rate at which matches actually produce one, so
 * null there is a genuine none. lib/inplayState reads it the same way, which is
 * what lets the measured sending-off adjustment fire at all.
 */
const NULL_MEANS_ZERO = Object.freeze(new Set(['Red Cards']));

/**
 * One statistic out of the feed's array.
 *
 * @param {Array} stats
 * @param {string} type - exact API-Football name
 * @returns {number|null} null ⇒ unknown, never a substituted zero
 */
function statValue(stats, type) {
  if (!Array.isArray(stats)) return null;
  for (const e of stats) {
    if (e?.type !== type) continue;
    const raw = e.value;
    if (raw == null) return NULL_MEANS_ZERO.has(type) ? 0 : null;
    const n = typeof raw === 'string' ? parseFloat(raw) : Number(raw);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

/**
 * The newest of the two sides' fetch stamps — the OBSERVATION's own clock.
 *
 * `captured_at` is ours, the tick that wrote the row; this is the feed's, and
 * it is what separates a new observation from a re-read of one already
 * recorded. fetchLiveStats gates each fixture behind 90 seconds while the loop
 * passes every 60, so without it the corpus fills with consecutive identical
 * rows and a fit over it counts one observation twice.
 *
 * The two sides are written by one upsert and normally share a stamp; the max
 * is taken because a partial write must date the row by what it actually
 * contains, not by the half that is stale.
 */
function statsFetchedAt(homeRow, awayRow) {
  const stamps = [homeRow?.fetched_at, awayRow?.fetched_at]
    .map(v => (v ? Date.parse(v) : NaN))
    .filter(Number.isFinite);
  return stamps.length ? new Date(Math.max(...stamps)).toISOString() : null;
}

/**
 * A momentum row for one match from its two `match_stats` rows.
 *
 * Every field is null where the feed was silent. `Number(null)` is 0 and 0 is
 * finite, so a coercion here would write a real zero into the corpus for a
 * competition that reports nothing — see lib/inplayState.num for the same trap
 * costing a lambda.
 *
 * @param {{id:string, minute?:number, goals_home?:number, goals_away?:number}} match
 * @param {{stats?:Array, fetched_at?:string}|null} homeRow
 * @param {{stats?:Array, fetched_at?:string}|null} awayRow
 * @returns {object|null} an inplay_momentum row, or null with no stats at all
 */
function momentumRow(match, homeRow, awayRow, now = new Date()) {
  if (!homeRow && !awayRow) return null;
  const h = k => statValue(homeRow?.stats, STAT[k]);
  const a = k => statValue(awayRow?.stats, STAT[k]);
  return {
    match_id:         match.id,
    captured_at:      now.toISOString(),
    stats_fetched_at: statsFetchedAt(homeRow, awayRow),
    minute:       Number.isFinite(match.minute) ? match.minute : null,
    goals_home:   match.goals_home ?? null,
    goals_away:   match.goals_away ?? null,
    shots_home:   h('shots'),   shots_away:   a('shots'),
    sot_home:     h('sot'),     sot_away:     a('sot'),
    inside_home:  h('inside'),  inside_away:  a('inside'),
    corners_home: h('corners'), corners_away: a('corners'),
    poss_home:    h('poss'),    poss_away:    a('poss'),
    xg_home:      h('xg'),      xg_away:      a('xg'),
    saves_home:   h('saves'),   saves_away:   a('saves'),
    reds_home:    h('reds'),    reds_away:    a('reds'),
  };
}

/**
 * A one-line reading of who is on top, FOR THE RUN LOG ONLY.
 *
 * It is a description, never an input: nothing downstream may branch on it, and
 * the moment something does, that thing needs its own measurement. It exists so
 * a reader of the log can see what the engine saw at the moment it priced.
 */
function describeMomentum(row) {
  if (!row) return 'no live stats';
  const bits = [];
  const pair = (label, hv, av) =>
    (Number.isFinite(hv) || Number.isFinite(av)) &&
    bits.push(`${label} ${hv ?? '?'}-${av ?? '?'}`);
  pair('shots', row.shots_home, row.shots_away);
  pair('sot', row.sot_home, row.sot_away);
  if (Number.isFinite(row.poss_home)) bits.push(`poss ${row.poss_home}%`);
  if (Number.isFinite(row.xg_home) || Number.isFinite(row.xg_away)) {
    bits.push(`xg ${row.xg_home ?? '?'}-${row.xg_away ?? '?'}`);
  }
  pair('reds', row.reds_home, row.reds_away);
  return bits.length ? bits.join(' · ') : 'no live stats';
}

module.exports = { STAT, NULL_MEANS_ZERO, statValue, statsFetchedAt, momentumRow, describeMomentum };
