'use strict';

/**
 * lib/leagueStrength.js — put two ELO ratings from different leagues on one
 * scale, or refuse to.
 *
 * `team_elo` is a single pool, but ELO is zero-sum within a match: a set of
 * clubs that only ever play each other conserves its own total and stays at the
 * 1500 default forever. Six tracked leagues have ZERO cross-league fixtures in
 * the whole history — MLS, Liga MX, J1, the Chinese Super League, the Russian
 * Premier League and Argentina — so an MLS club on 1620 and a Premier League
 * club on 1620 are not the same thing, and `eloProbs` would call that fixture
 * 50/50. Within a pool the ratings are fine. Across pools they are not
 * comparable at all unless something reconciles them, and `league_strength`
 * (migration 077) is that something.
 *
 * THE OFFSET GOES ON THE RATING, NOT ON THE PROBABILITY.
 *
 *     adjusted = elo + theta[league]
 *
 * and the adjusted pair then goes through `lib/eloProbs.js` unchanged. That
 * keeps one draw model over one rating scale, rather than a second correction
 * applied after the fact to a vector that was already wrong.
 *
 * IT FAILS CLOSED, AND THAT IS THE WHOLE VALUE. A league with no offset gets
 * NO comparison — not a zero. Zero is a claim: it says this league is exactly
 * Premier League strength. For MLS that claim is false by roughly 200 rating
 * points and nobody would ever see it happen, because a wrong probability looks
 * exactly like a right one. `adjustPair` returns null instead, and the caller
 * shows nothing, the same way `scoreOf` withholds without a de-vigged line and
 * `previewLimit` returns 0 for a surface it has not heard of.
 *
 * SAME-LEAGUE FIXTURES NEED NOTHING. The offsets cancel when both clubs are in
 * one league, so a domestic board is unaffected whatever the status says — a
 * league nobody can place against another is still perfectly ordered inside
 * itself. `adjustPair` short-circuits on that case and never consults the
 * table, which is why an MLS-vs-MLS fixture still scores.
 *
 * PARAMETERS ARE DATA. There is no compiled fallback table here on purpose.
 * `MODEL_SIGMA` is the cautionary tale — a hand-copy that disagreed with the
 * database twice in production and threw neither time. If the table has not
 * been loaded, every cross-league pair is refused.
 */

/** Statuses whose `theta_elo` may be used. Anything else is a refusal. */
const USABLE = Object.freeze(new Set(['reference', 'fitted']));

/**
 * Load the offsets. Returns a Map keyed by league id.
 *
 * Never throws: a failed read produces an EMPTY map, which refuses every
 * cross-league comparison rather than silently treating every league as equal.
 *
 * @param {import('@supabase/supabase-js').SupabaseClient} supabase
 * @returns {Promise<Map<string, {theta:number|null, status:string, se:number|null}>>}
 */
async function loadLeagueStrength(supabase, { model = 'ELO_LEAGUE_STRENGTH', version = 'v1' } = {}) {
  const { data, error } = await supabase
    .from('league_strength')
    .select('league_id, status, theta_elo, se_elo')
    .eq('model', model)
    .eq('version', version);

  if (error || !data?.length) {
    console.warn(`[leagueStrength] no offsets for ${model}/${version} `
      + `(${error?.message ?? 'no rows'}) — every cross-league pair will be refused`);
    return new Map();
  }
  return new Map(data.map(r => [r.league_id, {
    status: r.status,
    theta:  USABLE.has(r.status) && Number.isFinite(r.theta_elo) ? r.theta_elo : null,
    se:     Number.isFinite(r.se_elo) ? r.se_elo : null,
  }]));
}

/**
 * Whether two leagues sit on a common scale.
 * Same league is always true — the offsets cancel.
 */
function comparable(strength, leagueA, leagueB) {
  if (leagueA && leagueB && leagueA === leagueB) return true;
  const a = strength?.get?.(leagueA);
  const b = strength?.get?.(leagueB);
  return a?.theta != null && b?.theta != null;
}

/**
 * Adjust a pair of ratings onto one scale.
 *
 * @param {Map} strength      from loadLeagueStrength()
 * @param {{eloHome:number, leagueHome:string, eloAway:number, leagueAway:string}} pair
 * @returns {{eloHome:number, eloAway:number, crossLeague:boolean}|null}
 *   null when the two leagues cannot be placed against each other.
 */
function adjustPair(strength, { eloHome, leagueHome, eloAway, leagueAway }) {
  if (!Number.isFinite(eloHome) || !Number.isFinite(eloAway)) return null;

  // One league: the offsets cancel, so the table is not consulted at all.
  if (leagueHome && leagueAway && leagueHome === leagueAway) {
    return { eloHome, eloAway, crossLeague: false };
  }
  const h = strength?.get?.(leagueHome);
  const a = strength?.get?.(leagueAway);
  if (h?.theta == null || a?.theta == null) return null;

  return { eloHome: eloHome + h.theta, eloAway: eloAway + a.theta, crossLeague: true };
}

/**
 * Why a pair was refused, for a log line or a withheld-reason column. Returns
 * null when it was not refused.
 */
function refusalReason(strength, leagueHome, leagueAway) {
  if (leagueHome && leagueAway && leagueHome === leagueAway) return null;
  const bad = [];
  for (const [side, id] of [['home', leagueHome], ['away', leagueAway]]) {
    const r = strength?.get?.(id);
    if (!r) bad.push(`${side} league has no league_strength row`);
    else if (r.theta == null) bad.push(`${side} league is ${r.status}`);
  }
  return bad.length ? bad.join('; ') : null;
}

module.exports = { USABLE, loadLeagueStrength, comparable, adjustPair, refusalReason };
