'use strict';

/**
 * lib/leagueStrength.js — put two ELO ratings on one scale, or refuse to.
 *
 * `team_elo` is a single pool, but ELO is zero-sum within a match: a set of
 * clubs that only ever plays itself conserves its own total and stays at the
 * 1500 default forever. Six tracked leagues have ZERO cross-league fixtures in
 * the whole history — MLS, Liga MX, J1, the Chinese Super League, the Russian
 * Premier League and Argentina — so an MLS club on 1620 and a Premier League
 * club on 1620 are not the same thing, and `eloProbs` would call that fixture
 * 50/50. Inside a pool the ratings are fine. Across pools they are not
 * comparable at all unless something reconciles them, and that something is
 * `league_strength` (migration 077) reaching this module through `team_scale`
 * (migration 078).
 *
 * THE OFFSET GOES ON THE RATING, NOT ON THE PROBABILITY.
 *
 *     adjusted = elo + theta
 *
 * and the adjusted pair then goes through `lib/eloProbs.js` unchanged — one
 * draw model over one rating scale, rather than a second correction applied
 * after the fact to a vector that was already wrong.
 *
 * ── THE COMPETITION IS THE LEAGUE ─────────────────────────────────────────
 *
 * `competitionIsDomesticLeague` is REQUIRED and it is the most important
 * argument here. If a fixture IS a Serie A match, then both clubs are Serie A
 * clubs that day and the offsets cancel — full stop, without consulting
 * anything.
 *
 * Reading a club's league from its history instead is wrong every August.
 * Inter v Monza is a Serie A fixture, but Monza last COMPLETED a season in
 * Serie B, so a history lookup calls the pair cross-league, the offsets fail to
 * cancel, and an ordinary domestic match is shifted by more than a hundred
 * rating points. That was 47 of the next thirty days' fixtures.
 *
 * So the flag is not a hint and there is no default for it. A caller that omits
 * it gets a refusal, because the alternative failure — silently shifting a
 * domestic forecast — is invisible and therefore worse.
 *
 * ── IT FAILS CLOSED, AND THAT IS THE VALUE ────────────────────────────────
 *
 * A club with no offset gets NO comparison, not a zero. Zero is a claim: it
 * says this club sits exactly on the Premier League scale. For an MLS club that
 * is wrong by around two hundred rating points and nobody would ever see it
 * happen, because a wrong probability looks exactly like a right one.
 * `adjustPair` returns null instead, the same way `scoreOf` withholds without a
 * de-vigged line and `previewLimit` returns 0 for a surface it has not heard of.
 *
 * A REFUSAL IS REPORTED, NOT SWALLOWED. `placement()` returns a structured
 * verdict — an adjusted pair, or an `unplaced` result carrying a machine code
 * and a reason that NAMES THE CLUB. A fixture that produces no forecast must be
 * distinguishable from a fixture nobody asked about; that is the rule behind
 * `value_signals.score_withheld_reason` and behind `/api/inplay` reporting
 * which of four causes made it empty. `fixture_placement` (migration 079) is
 * the same verdict computed in SQL for every upcoming fixture, so the reason is
 * queryable before any surface exists to draw it.
 *
 * TWO SOURCES, AND THEY ARE NOT INTERCHANGEABLE. `team_scale.source` is
 * `league` for a club in a league whose offset was FITTED, and `opponents` for
 * a club with no domestic league at all — one of the 314 that appear only in
 * European ties. The second is a DERIVED first-order estimate (the
 * meetings-weighted mean theta of the opponents it has actually played, because
 * what such a club inherits is its opponents' inflation, having no pool of its
 * own), so it is gated on `n_rated_opponents` and defaults to needing four.
 *
 * PARAMETERS ARE DATA. There is no compiled fallback table here on purpose.
 * `MODEL_SIGMA` is the cautionary tale — a hand-copy that disagreed with the
 * database twice in production and threw neither time. If the view has not been
 * loaded, every cross-league pair is refused.
 */

/** Statuses in `league_strength` whose `theta_elo` may be used. */
const USABLE = Object.freeze(new Set(['reference', 'fitted']));

/**
 * The opponent-count gate lives in `team_scale.is_usable` (migration 079), not
 * here. This is the value that column uses, exported so a caller can SAY the
 * threshold in a message without deciding it.
 */
const MIN_RATED_OPPONENTS = 4;

/**
 * Load the per-club offsets from `team_scale`. Keyed by canonical club key
 * (lib/teamKey.js).
 *
 * Never throws: a failed read produces an EMPTY map, which refuses every
 * cross-league comparison rather than silently treating every club as equal.
 *
 * @param {import('@supabase/supabase-js').SupabaseClient} supabase
 * @returns {Promise<Map<string, {theta:number, source:string, nRatedOpponents:number|null}>>}
 */
async function loadTeamScale(supabase) {
  const { data, error } = await supabase
    .from('team_scale')
    .select('canonical_key, theta_elo, source, n_rated_opponents, is_usable, min_rated_opponents');

  if (error || !data?.length) {
    console.warn('[leagueStrength] team_scale unavailable '
      + `(${error?.message ?? 'no rows'}) — every cross-league pair will be refused`);
    return new Map();
  }
  const out = new Map();
  for (const r of data) {
    if (!Number.isFinite(r.theta_elo)) continue;
    out.set(r.canonical_key, {
      theta: r.theta_elo,
      source: r.source,
      nRatedOpponents: Number.isFinite(r.n_rated_opponents) ? r.n_rated_opponents : null,
      isUsable: r.is_usable === true,
      minRatedOpponents: Number.isFinite(r.min_rated_opponents) ? r.min_rated_opponents : null,
    });
  }
  return out;
}

/**
 * Load the fitted league table itself. Not needed to adjust a pair — that goes
 * through `team_scale` — but callers reporting WHY a league is unplaced want
 * the status.
 */
async function loadLeagueStrength(supabase, { model = 'ELO_LEAGUE_STRENGTH', version = 'v1' } = {}) {
  const { data, error } = await supabase
    .from('league_strength')
    .select('league_id, status, theta_elo, se_elo')
    .eq('model', model).eq('version', version);

  if (error || !data?.length) {
    console.warn(`[leagueStrength] no offsets for ${model}/${version} `
      + `(${error?.message ?? 'no rows'})`);
    return new Map();
  }
  return new Map(data.map(r => [r.league_id, {
    status: r.status,
    theta: USABLE.has(r.status) && Number.isFinite(r.theta_elo) ? r.theta_elo : null,
    se: Number.isFinite(r.se_elo) ? r.se_elo : null,
  }]));
}

/**
 * The offset for one club, or null if it cannot be placed.
 *
 * The gate is `team_scale.is_usable` — one definition, in SQL. `override` is
 * for tests and experiments and replaces it with a raw opponent count.
 */
function scaleFor(scale, key, override) {
  const r = scale?.get?.(key);
  if (!r || !Number.isFinite(r.theta)) return null;
  if (Number.isFinite(override)) {
    return (r.source !== 'opponents' || r.nRatedOpponents >= override) ? r : null;
  }
  return r.isUsable === false ? null : r;
}

/**
 * Adjust a pair of ratings onto one scale.
 *
 * @param {Map} scale from loadTeamScale()
 * @param {{eloHome:number, eloAway:number, competitionIsDomesticLeague:boolean,
 *          homeKey?:string, awayKey?:string, minRatedOpponents?:number}} pair
 * @returns {{eloHome:number, eloAway:number, crossLeague:boolean, basis:string}|null}
 *   null when the two clubs cannot be placed against each other.
 */
function adjustPair(scale, {
  eloHome, eloAway, competitionIsDomesticLeague,
  homeKey, awayKey, minRatedOpponents,
} = {}) {
  if (!Number.isFinite(eloHome) || !Number.isFinite(eloAway)) return null;

  // Required, and deliberately not defaulted — see the header.
  if (typeof competitionIsDomesticLeague !== 'boolean') return null;

  // A domestic league fixture: both clubs are in the competition's league
  // today, so the offsets cancel and nothing is looked up.
  if (competitionIsDomesticLeague) {
    return { eloHome, eloAway, crossLeague: false, basis: 'competition' };
  }

  const h = scaleFor(scale, homeKey, minRatedOpponents);
  const a = scaleFor(scale, awayKey, minRatedOpponents);
  if (!h || !a) return null;

  return {
    eloHome: eloHome + h.theta,
    eloAway: eloAway + a.theta,
    crossLeague: true,
    basis: h.source === 'league' && a.source === 'league' ? 'league' : 'opponents',
  };
}

/** Whether a pair can be placed at all. Mirrors adjustPair exactly. */
function comparable(scale, { competitionIsDomesticLeague, homeKey, awayKey,
                             minRatedOpponents } = {}) {
  if (typeof competitionIsDomesticLeague !== 'boolean') return false;
  if (competitionIsDomesticLeague) return true;
  return !!scaleFor(scale, homeKey, minRatedOpponents)
      && !!scaleFor(scale, awayKey, minRatedOpponents);
}

/**
 * The full verdict: an adjusted pair, or an explicit UNPLACED result carrying a
 * machine code and a reason naming the club.
 *
 * This is the function a surface should call. `adjustPair` is the thin wrapper
 * for callers that only want the numbers, and it returns null so that no caller
 * can read a rating off a refusal by accident.
 *
 * @returns {{placed:true, eloHome:number, eloAway:number, crossLeague:boolean, basis:string}
 *          |{placed:false, code:string, reason:string, sides:Array}}
 */
function placement(scale, args = {}) {
  const { competitionIsDomesticLeague, homeKey, awayKey, minRatedOpponents } = args;

  if (typeof competitionIsDomesticLeague !== 'boolean') {
    return {
      placed: false,
      code: 'no_competition_context',
      reason: 'competitionIsDomesticLeague was not supplied, so it is not known '
            + 'whether the two clubs are in the same league',
      sides: [],
    };
  }

  const adjusted = adjustPair(scale, args);
  if (adjusted) return { placed: true, ...adjusted };

  if (!Number.isFinite(args.eloHome) || !Number.isFinite(args.eloAway)) {
    return {
      placed: false,
      code: 'no_rating',
      reason: 'at least one club has no ELO rating',
      sides: [
        ...(Number.isFinite(args.eloHome) ? [] : [{ side: 'home', code: 'no_rating' }]),
        ...(Number.isFinite(args.eloAway) ? [] : [{ side: 'away', code: 'no_rating' }]),
      ],
    };
  }

  const sides = [];
  for (const [side, key] of [['home', homeKey], ['away', awayKey]]) {
    const r = scale?.get?.(key);
    if (!r || !Number.isFinite(r.theta)) {
      sides.push({
        side, key, code: 'club_unplaced',
        reason: 'has no place on the ELO scale — no domestic league in the '
              + 'corpus and no rated opponent',
      });
    } else if (!scaleFor(scale, key, minRatedOpponents)) {
      const need = Number.isFinite(minRatedOpponents)
        ? minRatedOpponents : (r.minRatedOpponents ?? MIN_RATED_OPPONENTS);
      sides.push({
        side, key, code: 'club_thinly_placed', nRatedOpponents: r.nRatedOpponents,
        reason: `is placed only by ${r.nRatedOpponents} rated opponent(s), `
              + `under the ${need} required`,
      });
    }
  }
  return {
    placed: false,
    code: sides.some(s => s.code === 'club_unplaced') ? 'club_unplaced' : 'club_thinly_placed',
    reason: sides.map(s => `${s.side} club ${s.reason}`).join('; '),
    sides,
  };
}

/**
 * Why a pair was refused, as a plain string. Null when it was not refused.
 * Thin wrapper over placement() so the two can never disagree.
 */
function refusalReason(scale, { competitionIsDomesticLeague, homeKey, awayKey,
                                minRatedOpponents } = {}) {
  const v = placement(scale, {
    competitionIsDomesticLeague, homeKey, awayKey, minRatedOpponents,
    // placement() checks the ratings too; supply sentinels so this reports only
    // on placement, which is what callers asking for a reason want.
    eloHome: 1500, eloAway: 1500,
  });
  return v.placed ? null : v.reason;
}

module.exports = {
  USABLE, MIN_RATED_OPPONENTS,
  loadTeamScale, loadLeagueStrength, scaleFor,
  comparable, adjustPair, placement, refusalReason,
};
