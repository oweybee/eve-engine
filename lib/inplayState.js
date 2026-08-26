'use strict';

/**
 * lib/inplayState.js — live match STATE, and the only place it is allowed to
 * move the goal expectation the in-play stages price against.
 *
 * WHY IT EXISTS. `liveWinProb` takes (λ_home, λ_away, goals, minute) and nothing
 * else, and λ is FROZEN: inverted from the pre-match de-vigged 1X2 at
 * inplay_baseline capture time and never revised. So the model reads the
 * scoreline and the clock and is blind to the match. Meanwhile
 * `fetchLiveStats.js` has been writing 18 statistics per side into
 * `match_stats` every ~90 seconds, and NOTHING in the signal path read them —
 * the frontend drew possession and shots on the match page beside a
 * probability that had never seen either.
 *
 * WHAT IT DOES *NOT* DO, DELIBERATELY. Possession, shots, shots on target and
 * corners are NOT turned into a λ adjustment here. There is no measurement in
 * this repo for what a possession share is worth in goals, and inventing one
 * would be a second unmeasured model priced as though it were evidence — the
 * failure `model_calibration` and the publication gate both exist to prevent.
 * They are read, logged and carried so a reader and the model finally look at
 * the same object; they change no number.
 *
 * ONE THING DOES MOVE λ, BECAUSE IT IS MEASURED: A SENDING-OFF.
 *
 * Measured over `match_results`, 10,215 matches carrying exactly one red card
 * and a half-time score, against 64,294 with none. Second-half goals only
 * (FT − HT), each cohort compared with the SAME-half-time-margin baseline so a
 * side that was already chasing is not counted as evidence:
 *
 *     ten-man side     0.4973 observed / 0.8050 expected   = x0.6178
 *     eleven-man side  1.0604 observed / 0.6620 expected   = x1.6018
 *
 * Stable across game state, which is what says it is the card and not the
 * scoreline: the ten-man multiplier reads 0.544 / 0.624 / 0.655 for a side
 * ahead / level / behind at the break, and the eleven-man 1.747 / 1.604 / 1.517.
 *
 * AND IT IS A FLOOR, NOT A POINT ESTIMATE. `match_results` carries HR/AR for the
 * WHOLE match with no minute, so a card shown in the 89th counts identically to
 * one in the 20th and dilutes the average toward 1. The true effect from the
 * moment of the card is therefore LARGER than these numbers. Using them
 * unrounded is the conservative direction; do not "round toward no effect"
 * again on top of that, and do not inflate them to guess at the undiluted
 * value either — re-measure with event timings if this ever needs to be exact.
 */

/**
 * Multipliers applied to the frozen λ when the sides are uneven. Measured — see
 * the header. Overridable so a re-fit does not need a code change, but the
 * DEFAULT is the measurement and that is what ships.
 */
const RED_CARD_LAMBDA = {
  short: parseFloat(process.env.INPLAY_RED_CARD_SHORT_MULT || '0.6178'),
  full:  parseFloat(process.env.INPLAY_RED_CARD_FULL_MULT  || '1.6018'),
};

/**
 * Largest man-advantage this will price. The measurement is a ONE-card
 * differential; |differential| >= 2 occurs in 553 of the 75,875 matches that
 * report cards at all (2 cards 537, 3 cards 15, 4 cards 1) and is not
 * separately measured, so a bigger differential is priced AS ONE CARD rather
 * than compounding a multiplier past its evidence. Fails toward the smaller
 * adjustment on purpose.
 */
const MAX_PRICED_DIFFERENTIAL = 1;

/**
 * Coerce to a finite number, or null.
 *
 * `Number(null)` IS 0 AND 0 IS FINITE, so `Number.isFinite(Number(x))` files a
 * null lambda as a real zero — and a zero lambda is a team that cannot score,
 * which the Poisson grid will happily price. This repo has shipped that exact
 * shape five times and bans it in the frontend with a lint rule; there is no
 * such rule here, so the guard is explicit. Caught by this module's own test
 * before it ran anywhere.
 */
function num(v) {
  if (v == null || v === '') return null;
  const n = typeof v === 'string' ? parseFloat(v) : Number(v);
  return Number.isFinite(n) ? n : null;
}

/**
 * Read one statistic out of an API-Football `match_stats.stats` array.
 * The payload is `[{ type: 'Red Cards', value: 1|null }, …]` and `value` is
 * NULL rather than 0 for "none so far" on most feeds — `Number(null)` is 0,
 * which is the right answer here but for the wrong reason, so it is explicit.
 *
 * @param {Array<{type?:string, value?:any}>} stats
 * @param {string} type - exact API-Football stat name
 * @returns {number|null} the value, or null when absent/unparseable
 */
function statValue(stats, type) {
  if (!Array.isArray(stats)) return null;
  for (const e of stats) {
    if (e?.type !== type) continue;
    const raw = e.value;
    if (raw == null) return 0;                       // reported, none yet
    const n = typeof raw === 'string' ? parseFloat(raw) : Number(raw);
    return Number.isFinite(n) ? n : null;
  }
  return null;                                       // not reported at all
}

/**
 * Live state for one match from its two `match_stats` rows. Every field is
 * null when the feed did not report it, NEVER zero: "no red cards yet" and
 * "this feed does not send red cards" must not be the same value, because the
 * first is a fact about the match and the second is a fact about us.
 *
 * @param {{stats?:Array}|null} homeRow
 * @param {{stats?:Array}|null} awayRow
 * @returns {{redHome:number|null, redAway:number|null, possessionHome:number|null,
 *            shotsHome:number|null, shotsAway:number|null,
 *            shotsOnHome:number|null, shotsOnAway:number|null}}
 */
function liveState(homeRow, awayRow) {
  const pct = v => (v == null ? null : v);
  return {
    redHome:        statValue(homeRow?.stats, 'Red Cards'),
    redAway:        statValue(awayRow?.stats, 'Red Cards'),
    possessionHome: pct(statValue(homeRow?.stats, 'Ball Possession')),
    shotsHome:      statValue(homeRow?.stats, 'Total Shots'),
    shotsAway:      statValue(awayRow?.stats, 'Total Shots'),
    shotsOnHome:    statValue(homeRow?.stats, 'Shots on Goal'),
    shotsOnAway:    statValue(awayRow?.stats, 'Shots on Goal'),
  };
}

/**
 * Adjust the frozen goal expectations for a man advantage.
 *
 * FAILS CLOSED IN BOTH DIRECTIONS. A missing stats row, an unreported Red Cards
 * field or an even count all return the λ pair UNCHANGED — the behaviour before
 * this module existed — so a feed that stops sending cards degrades to the old
 * model rather than to a wrong one.
 *
 * @param {{lambdaHome:number, lambdaAway:number}} lambda
 * @param {{redHome:number|null, redAway:number|null}} state
 * @returns {{lambdaHome:number, lambdaAway:number, differential:number, applied:boolean}}
 */
function adjustLambdaForCards({ lambdaHome, lambdaAway }, state) {
  const lh = num(lambdaHome);
  const la = num(lambdaAway);
  const unchanged = { lambdaHome: lh, lambdaAway: la, differential: 0, applied: false };
  if (lh == null || la == null) return unchanged;

  const rh = state?.redHome;
  const ra = state?.redAway;
  if (!Number.isFinite(rh) || !Number.isFinite(ra)) return unchanged;   // not reported

  const raw = rh - ra;
  if (raw === 0) return unchanged;

  // Clamp to the measured one-card case, keeping the sign.
  const d = Math.sign(raw) * Math.min(Math.abs(raw), MAX_PRICED_DIFFERENTIAL);
  const homeIsShort = d > 0;

  return {
    lambdaHome:   homeIsShort ? lh * RED_CARD_LAMBDA.short : lh * RED_CARD_LAMBDA.full,
    lambdaAway:   homeIsShort ? la * RED_CARD_LAMBDA.full  : la * RED_CARD_LAMBDA.short,
    differential: raw,
    applied:      true,
  };
}

/** One-line summary for the run log — the state the model actually priced. */
function describeState(state, adj) {
  if (!state) return 'no live stats';
  const bits = [];
  if (Number.isFinite(state.redHome) || Number.isFinite(state.redAway)) {
    bits.push(`reds ${state.redHome ?? '?'}-${state.redAway ?? '?'}`);
  }
  if (Number.isFinite(state.shotsHome)) bits.push(`shots ${state.shotsHome}-${state.shotsAway ?? '?'}`);
  if (Number.isFinite(state.possessionHome)) bits.push(`poss ${state.possessionHome}%`);
  if (adj?.applied) bits.push(`lambda adjusted for a ${Math.abs(adj.differential)}-card advantage`);
  return bits.length ? bits.join(' · ') : 'no live stats';
}

module.exports = {
  RED_CARD_LAMBDA,
  num,
  MAX_PRICED_DIFFERENTIAL,
  statValue,
  liveState,
  adjustLambdaForCards,
  describeState,
};
