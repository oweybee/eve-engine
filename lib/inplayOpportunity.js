'use strict';

/**
 * lib/inplayOpportunity.js — whether a priced live selection is an OPPORTUNITY.
 *
 * A positive edge is not an opportunity. The win-probability stage already
 * asked "does our number beat the price"; this module asks the two questions
 * that come before it and that the stage was not asking at all:
 *
 *   1. can the model RESOLVE a probability here, or is the gap inside its own
 *      error?
 *   2. is the CLOCK the model is pricing against the real one?
 *
 * Both are refusals. Neither moves a number, neither invents a score, and
 * nothing here reads possession, shots or xG — those are being recorded into
 * `inplay_momentum` (migration 111) and will stay unpriced until they have been
 * fitted and measured. This file is where that model will land when it has.
 *
 * ── WHY THE CERTAINTY CAP EXISTS, MEASURED ───────────────────────────────────
 *
 * Replayed over `inplay_market_series` — every tick on a COMPLETED match, taken
 * exactly as the signal path would take it (a backable price under 3.00, minute
 * under 88, claimed EV between 2% and 20%), clustered to one observation per
 * match so a long game is not counted forty times:
 *
 *     cut     above the cut                    below the cut
 *             n   claimed  realised    z       n   claimed  realised    z
 *     0.80    84   90.51%   84.52%   -1.87    143   56.88%   52.10%   -1.15
 *     0.85    65   93.05%   81.54%   -3.65    159   59.85%   57.39%   -0.63
 *     0.90    46   95.49%   84.78%   -3.50    178   62.94%   59.69%   -0.90
 *     0.95    27   97.74%   85.19%   -4.39    192   65.81%   62.11%   -1.08
 *     0.97    18   98.72%   77.78%   -7.91    198   66.83%   63.51%   -0.99
 *
 * The model is CALIBRATED below every cut (|z| under 1.2 in all five rows) and
 * significantly OVERCONFIDENT above 0.85. 0.85 is therefore not a taste: it is
 * the lowest cut at which the miss above it clears |z| >= 2, and it is where
 * the remainder below it is best calibrated (z -0.63, the closest to zero on
 * the table). At 0.80 the miss is -1.87 and does not clear the bar.
 *
 * The unfiltered reliability curve says the same thing with far more rows —
 * 119 ticks over 92 matches at p >= 0.97 realise 92.4%, and the 94 ticks over
 * 67 matches where the model returns EXACTLY 1.0000 realise 84.0%. A model
 * that says "certain" and is wrong one time in six is not measuring anything
 * at that end of its range; past there the "edge" is the bookmaker's margin
 * wearing a probability's clothes.
 *
 * AND IT ANSWERS THE PRICE COMPLAINT WITHOUT A PRICE FLOOR. 1/0.85 is 1.176,
 * so with the 2% EV floor already in place nothing under about 1.20 can now
 * reach the channel — Viking at 1.090 (3-1, model 0.9683) and the 1.10 shot
 * that prompted this are both refused. A LOWER BOUND ON THE ODDS was tried and
 * measured in lib/inplay and does not work: "under 2.00 the model claims 0.80x
 * the market... adding the floor would cut fires 258 -> 164 and the rejects
 * only 175 -> 172 — all cost, no correction." The price is the symptom. The
 * model's resolution is the cause, and that is what this cuts on.
 *
 * ── WHY THE CLOCK GUARD EXISTS, MEASURED ─────────────────────────────────────
 *
 * `liveWinProb` prices the remaining goals as Poisson(lambda x time left), and
 * time left is computed from the FEED's minute. Time remaining is most of the
 * model, so a stale clock is not a rounding error — it is the model believing
 * there is another half-hour of football to come when the match is over.
 *
 * That is not hypothetical. Over the 560 completed matches in the series, 75
 * ticks across 25 of them were priced more than 110 minutes after kickoff with
 * the feed still reading under 88 minutes.
 *
 * The disagreement is measured as EXCESS — wall-clock elapsed, minus the feed's
 * minute, minus the half-time break once the second half has started. Over
 * 4,311 completed-match ticks:
 *
 *     excess > 10 min   22.34%      <- ordinary second-half stoppage
 *     excess > 15 min   11.34%
 *     excess > 20 min    3.20%      <- the cap
 *     excess > 25 min    1.32%
 *     maximum           61.7 min
 *
 * 20 minutes of unexplained lag is already generous: it is on TOP of the
 * fifteen the break is given, so a second-half tick may run 35 minutes behind
 * the wall clock before it is refused. It catches 48 of the 75 frozen-clock
 * ticks above. The other 27 are matches that KICKED OFF LATE, where the feed's
 * minute is right and `kickoff_at` is wrong — and there the model is pricing
 * correctly, so refusing them would be the guard doing harm.
 *
 * The negative side has NEVER FIRED and is a ratchet: the minimum excess ever
 * observed is -0.8 minutes, so a clock running AHEAD of the wall by more than
 * five is impossible and means one of the two timestamps is wrong.
 *
 * ── FAIL-OPEN AND FAIL-CLOSED, PER GUARD ────────────────────────────────────
 *
 * The certainty cap fails CLOSED: a probability that cannot be read is not a
 * probability we may claim an edge against.
 *
 * The clock guard fails OPEN when there is no kickoff to measure against, and
 * says so. A null `kickoff_at` makes the disagreement uncomputable, not large;
 * refusing every such fixture would lose real signals to a missing column, and
 * the minute cap in computeInplayValues still bounds those rows.
 */

/**
 * The certainty cap. Above it the model has no resolution left, so an edge is
 * not distinguishable from the margin. Derived above; env-overridable so it can
 * be moved without a deploy, like every other in-play throttle.
 */
const INPLAY_MAX_MODEL_PROB = parseFloat(process.env.INPLAY_MAX_MODEL_PROB || '0.85');

/** Minutes of unexplained lag tolerated before a tick is refused. */
const INPLAY_MAX_CLOCK_EXCESS_MIN = parseFloat(process.env.INPLAY_MAX_CLOCK_EXCESS_MIN || '20');

/** Minutes the feed's clock may run AHEAD of the wall clock. Never observed. */
const INPLAY_MAX_CLOCK_AHEAD_MIN = parseFloat(process.env.INPLAY_MAX_CLOCK_AHEAD_MIN || '5');

/** The half-time break, allowed for once the second half has started. */
const HALF_TIME_BREAK_MIN = parseFloat(process.env.INPLAY_HALF_TIME_BREAK_MIN || '15');

/** The minute at which the second half begins, for the break allowance. */
const SECOND_HALF_FROM = 46;

/**
 * Is this probability one the model can actually resolve?
 *
 * Fails CLOSED: a non-finite or absent probability is refused, so a missing
 * model number is never read as a modest one. `Number(null)` is 0 and 0 is
 * finite, which is exactly how that coercion gets written — see
 * lib/inplayState.num for the same trap costing a lambda.
 *
 * @param {number} pModel
 * @param {number} [cap]
 * @returns {boolean}
 */
function isResolvableProbability(pModel, cap = INPLAY_MAX_MODEL_PROB) {
  if (pModel == null || pModel === '') return false;
  const p = typeof pModel === 'string' ? parseFloat(pModel) : Number(pModel);
  if (!Number.isFinite(p)) return false;
  return p > 0 && p <= cap;
}

/**
 * How far the feed's clock has drifted from the wall clock, beyond what the
 * half-time break explains. Positive means the feed is BEHIND.
 *
 * @param {{minute:number, kickoffAt:string|Date|null}} args
 * @param {Date} [now]
 * @returns {number|null} minutes of unexplained lag, or null when uncomputable
 */
function clockExcessMinutes({ minute, kickoffAt }, now = new Date()) {
  // `Number(null)` is 0 and 0 is finite, so a bare coercion reads an ABSENT
  // minute as kickoff and reports the whole elapsed time as lag — turning
  // "we do not know the clock" into "the clock is stale". Caught by test.
  if (minute == null || minute === '') return null;
  const m = typeof minute === 'string' ? parseFloat(minute) : Number(minute);
  if (!Number.isFinite(m)) return null;
  const ko = kickoffAt instanceof Date ? kickoffAt.getTime() : Date.parse(kickoffAt ?? '');
  if (!Number.isFinite(ko)) return null;
  const elapsed = (now.getTime() - ko) / 60_000;
  const allowance = m >= SECOND_HALF_FROM ? HALF_TIME_BREAK_MIN : 0;
  return elapsed - m - allowance;
}

/**
 * Is the clock the model is about to price against believable?
 *
 * @returns {{ok:boolean, excess:number|null, reason:string|null}}
 *   `ok` is true when the clock is usable OR unmeasurable — the two are
 *   distinguished by `reason`, which is 'clock_unknown' in the second case, so
 *   a log can tell "checked and fine" from "could not check".
 */
function clockIsBelievable(args, now = new Date(), opts = {}) {
  const maxBehind = opts.maxExcess ?? INPLAY_MAX_CLOCK_EXCESS_MIN;
  const maxAhead  = opts.maxAhead ?? INPLAY_MAX_CLOCK_AHEAD_MIN;
  const excess = clockExcessMinutes(args, now);
  if (excess == null) return { ok: true, excess: null, reason: 'clock_unknown' };
  if (excess > maxBehind) return { ok: false, excess, reason: 'clock_stale' };
  if (excess < -maxAhead) return { ok: false, excess, reason: 'clock_ahead' };
  return { ok: true, excess, reason: null };
}

/**
 * The whole verdict for one priced selection, as one call.
 *
 * Returns a REASON rather than a boolean so the run log can name which guard
 * declined a tick. "Returns nothing" and "cannot return anything" being one
 * state is the failure this repo keeps paying for.
 *
 * @returns {{ok:boolean, reason:string|null, excess:number|null}}
 */
function opportunityVerdict({ pModel, minute, kickoffAt }, now = new Date(), opts = {}) {
  if (!isResolvableProbability(pModel, opts.maxModelProb ?? INPLAY_MAX_MODEL_PROB)) {
    return { ok: false, reason: 'model_saturated', excess: null };
  }
  const clock = clockIsBelievable({ minute, kickoffAt }, now, opts);
  if (!clock.ok) return { ok: false, reason: clock.reason, excess: clock.excess };
  return { ok: true, reason: clock.reason, excess: clock.excess };
}

module.exports = {
  INPLAY_MAX_MODEL_PROB,
  INPLAY_MAX_CLOCK_EXCESS_MIN,
  INPLAY_MAX_CLOCK_AHEAD_MIN,
  HALF_TIME_BREAK_MIN,
  SECOND_HALF_FROM,
  isResolvableProbability,
  clockExcessMinutes,
  clockIsBelievable,
  opportunityVerdict,
};
