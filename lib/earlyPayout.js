'use strict';

/**
 * Bookmaker "2 goals ahead" early payout (a.k.a. 2UP / Two Up).
 *
 * Most UK bookmakers pay a MATCH-RESULT WIN SINGLE as a winner the instant the
 * backed team goes two goals clear — the bet is settled there and then and the
 * final score no longer matters. So a signal that grades as a LOSS on the final
 * scoreline (backed team pegged back to a draw, or beaten) is still a real-money
 * WIN if that team ever led by two.
 *
 * We track this as a SEPARATE fact rather than overwriting the graded result:
 *   - `result` stays the honest model outcome (Egypt lost → the model was wrong)
 *   - `early_payout` records whether the bookmaker's 2UP rule paid it out anyway
 * The performance summary then reports BOTH a true line and an early-payout
 * ADJUSTED line, so model accuracy and realised returns are never conflated.
 *
 * This module is pure and API-agnostic: callers hand it a normalised goal
 * timeline (or a half-time score as a fallback) and a market/selection. The
 * API-Football adapter that produces the timeline lives in lib/apiFootballEvents.js.
 */

// Two-goal lead is the near-universal trigger ("2 Up"). Kept as a named
// constant so a future rule change (or a per-bookmaker override) is one edit.
const TWO_UP = 2;

/**
 * Only 1X2 match-result WIN singles qualify for 2UP. A draw selection has no
 * "goes 2 up" state that helps it, and secondary markets (BTTS, totals, corners,
 * cards) have no early-payout equivalent at any mainstream bookmaker.
 *
 * @param {string} market  e.g. 'h2h' | '1x2' | 'btts' | 'totals'
 * @param {string} outcome e.g. 'home' | 'away' | 'draw' | 'over' | 'btts_yes'
 * @returns {boolean}
 */
function marketQualifies(market, outcome) {
  const mk = (market ?? 'h2h').toLowerCase();
  const oc = (outcome ?? '').toLowerCase();
  const isMatchResult = mk === 'h2h' || mk === '1x2' || mk === 'match_odds';
  return isMatchResult && (oc === 'home' || oc === 'away');
}

/**
 * Replays an ordered goal timeline into the maximum lead each side ever held.
 * Own goals must already be attributed to the side they benefit (the adapter's
 * job) — this function just tallies `team` in order.
 *
 * @param {Array<{team:'home'|'away'}>} goals ordered by minute
 * @returns {{home:number, away:number}} greatest goals-ahead each side reached
 */
function maxLeads(goals) {
  let h = 0, a = 0, maxH = 0, maxA = 0;
  for (const g of goals ?? []) {
    const t = (g?.team ?? '').toLowerCase();
    if (t === 'home') h += 1;
    else if (t === 'away') a += 1;
    else continue; // ignore malformed entries rather than corrupt the tally
    if (h - a > maxH) maxH = h - a;
    if (a - h > maxA) maxA = a - h;
  }
  return { home: maxH, away: maxA };
}

/**
 * Did the backed side reach a two-goal lead at any point?
 * Prefers the full goal timeline; falls back to the half-time score when that's
 * all we have. Returns false when neither is usable — 2UP is never assumed, so a
 * missing timeline can only ever UNDER-count early payouts, never invent one.
 *
 * @param {string} outcome 'home' | 'away'
 * @param {{goals?:Array, halftime?:{home:number,away:number}}} evidence
 * @returns {boolean}
 */
function ledByTwo(outcome, { goals, halftime } = {}) {
  const oc = (outcome ?? '').toLowerCase();
  if (oc !== 'home' && oc !== 'away') return false;

  if (Array.isArray(goals) && goals.length) {
    return maxLeads(goals)[oc] >= TWO_UP;
  }
  if (halftime && halftime.home != null && halftime.away != null) {
    const lead = oc === 'home'
      ? halftime.home - halftime.away
      : halftime.away - halftime.home;
    return lead >= TWO_UP;
  }
  return false;
}

/**
 * Whether a bet earned an early payout: an eligible market/selection AND the
 * backed side led by two at some point. Independent of the final result — a 2UP
 * bet that ALSO wins on the day is harmless (a win either way); the flag only
 * changes the numbers when the final result would otherwise be a loss.
 *
 * @param {{market:string, outcome:string, goals?:Array, halftime?:object}} bet
 * @returns {boolean}
 */
function isEarlyPayout({ market, outcome, goals, halftime }) {
  if (!marketQualifies(market, outcome)) return false;
  return ledByTwo(outcome, { goals, halftime });
}

module.exports = { TWO_UP, marketQualifies, maxLeads, ledByTwo, isEarlyPayout };
