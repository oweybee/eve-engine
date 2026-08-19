'use strict';

/**
 * fitLeagueStrength.js — refit the per-league ELO offsets from `elo_corpus`.
 *
 * WHY THIS EXISTS. The offsets in `league_strength` were first produced by hand,
 * in scratch SQL tables that were then dropped. That is exactly the shape this
 * repo keeps warning about: a number in the database with no runnable thing that
 * makes it, so nobody can refit it, nobody can check it, and it silently ages.
 * `docs/LEAGUE_STRENGTH.md` §7 described the recipe in prose; this file IS the
 * recipe.
 *
 * IT REUSES THE PRODUCTION MATHS RATHER THAN MIRRORING IT. The ladder is replayed
 * with `lib/elo.js` updatePair — the same K=30 / homeAdv=80 / default=1500 that
 * `computeElo.js` uses — and the likelihood is evaluated through
 * `lib/eloProbs.js`, the same draw model every forecast goes through. The first
 * fit reimplemented both in plpgsql; two implementations of one formula agree
 * only while someone is watching.
 *
 * FITTED TO OUTCOMES, NEVER TO A PRICE. No market number is read anywhere in
 * this file, and none may be added. An offset fitted to reduce disagreement with
 * the market would make the model reproduce the price by construction.
 *
 * WHAT IT DOES
 *   1. Reads every deduplicated completed fixture from `elo_corpus`.
 *   2. Replays ELO chronologically, recording the PRE-MATCH rating pair and
 *      games played for each fixture (point-in-time — using a club's rating
 *      today to explain a match it played in 2023 is look-ahead bias).
 *   3. Keeps fixtures in a genuinely inter-league competition where both clubs'
 *      domestic league that season is known and they differ, and both clubs are
 *      past MIN_GAMES.
 *   4. Coordinate-ascends the offsets to maximise the multinomial 1X2
 *      log-likelihood, with the reference league pinned at 0.
 *   5. Standard errors from the profile likelihood at dLL = 0.5.
 *   6. Refits on UEFA ties alone as a robustness check.
 *   7. Writes `league_strength`, marking every league it could not identify as
 *      `not_estimable` so a stale row can never survive a refit as though it
 *      had been re-measured.
 *
 * Required: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY.
 * Usage:
 *   node fitLeagueStrength.js --dry-run     # fit and report, write nothing
 *   node fitLeagueStrength.js               # fit and write
 */

const { getClient } = require('./lib/supabaseClient');
const { ELO_DEFAULT, updatePair } = require('./lib/elo');
const { drawProb, loadEloParams, DEFAULTS } = require('./lib/eloProbs');
const { expectedHome } = require('./lib/elo');

const DRY_RUN = process.argv.includes('--dry-run');
const PAGE_SIZE = 1000;

/** Both clubs must be this mature for a fixture to identify an offset. */
const MIN_GAMES = 30;
/** Below this many observations a league is not identified and is not published. */
const MIN_OBS = 27;
/** Above this standard error the estimate is too loose to publish. */
const MAX_SE = 70;
/** The origin. Offsets are identified only up to a constant. */
const REFERENCE = { name: 'Premier League', country: 'England' };

const RESULT_CODE = { home: 'H', draw: 'D', away: 'A' };

/** Competitions whose entrants come from more than one league. */
const INTER_LEAGUE = new Set([
  'UEFA Champions League', 'UEFA Europa League', 'UEFA Europa Conference League',
  'League Cup',
]);
/** Countries that mark a competition as international rather than domestic. */
const NON_DOMESTIC_COUNTRIES = new Set(['World', 'International', 'Europe', 'Africa', 'South America']);

// ---------------------------------------------------------------------------
// pure
// ---------------------------------------------------------------------------

/**
 * API-Football seasons are labelled by their START YEAR and turn over in JULY,
 * not August. `backfillSeasonFixtures.currentSeasonYear` is the repo's existing
 * statement of that and this must agree with it.
 *
 * It did not. The first version read `getUTCMonth() >= 7`, which is
 * ZERO-INDEXED — August — so every July fixture was filed under the previous
 * season. July is the single busiest month in the UEFA calendar (1,038 fixtures
 * in the corpus, more than any other), so those ties were matched against the
 * clubs' OLD divisions. The verification run against production is what caught
 * it: the offsets came out 2 to 3 points adrift of the SQL fit across the board
 * and 8 points adrift on the Championship.
 */
function seasonOf(kickoffAt) {
  const d = new Date(kickoffAt);
  return d.getUTCMonth() + 1 >= 7 ? d.getUTCFullYear() : d.getUTCFullYear() - 1;
}

/**
 * Replay the ladder chronologically, returning the pre-match state of every
 * fixture. Pure: takes rows, returns rows.
 *
 * @param {Array<{id,kickoff_at,result,home_key,away_key}>} matches chronological
 * @returns {Map<string, {hElo:number,aElo:number,hGames:number,aGames:number}>}
 */
function replayPrematch(matches) {
  const ladder = new Map();
  const out = new Map();
  const get = (k) => {
    let r = ladder.get(k);
    if (!r) { r = { elo: ELO_DEFAULT, games: 0 }; ladder.set(k, r); }
    return r;
  };
  for (const m of matches) {
    const code = RESULT_CODE[m.result];
    if (!code || !m.home_key || !m.away_key) continue;
    const h = get(m.home_key), a = get(m.away_key);
    out.set(m.id, { hElo: h.elo, aElo: a.elo, hGames: h.games, aGames: a.games });
    const next = updatePair(h.elo, a.elo, code);
    h.elo = next.home; a.elo = next.away;
    h.games += 1; a.games += 1;
  }
  return out;
}

/**
 * Each club's domestic league per season, by modal appearance. Cups and
 * international competitions do not confer league membership.
 */
function leagueBySeason(matches, competitions) {
  const tally = new Map(); // `${key}|${season}` -> Map(leagueId -> count)
  for (const m of matches) {
    const comp = competitions.get(m.league_id);
    if (!comp || !comp.isDomestic) continue;
    const season = seasonOf(m.kickoff_at);
    for (const k of [m.home_key, m.away_key]) {
      const id = `${k}|${season}`;
      let byLeague = tally.get(id);
      if (!byLeague) { byLeague = new Map(); tally.set(id, byLeague); }
      byLeague.set(m.league_id, (byLeague.get(m.league_id) ?? 0) + 1);
    }
  }
  const out = new Map();
  for (const [id, byLeague] of tally) {
    let best = null, bestN = -1;
    for (const [lg, n] of byLeague) if (n > bestN) { best = lg; bestN = n; }
    out.set(id, best);
  }
  return out;
}

/** The multinomial 1X2 log-likelihood of a set of observations under `theta`. */
function logLikelihood(observations, theta, params) {
  let ll = 0;
  for (const o of observations) {
    const d = o.base + (theta.get(o.homeLeague) ?? 0) - (theta.get(o.awayLeague) ?? 0);
    // expectedHome takes ratings; `base` already carries homeAdv, so feed the
    // gap directly against a zero away rating to reuse the same curve.
    const E = expectedHome(d, 0, 0);
    const pD = drawProb(d, E, params);
    const p = o.result === 'home' ? E - pD / 2
            : o.result === 'draw' ? pD
            : 1 - E - pD / 2;
    ll += Math.log(Math.max(p, 1e-12));
  }
  return ll;
}

/**
 * Coordinate ascent with a golden-section line search per league.
 * Pure and deterministic. Returns a Map of leagueId -> theta.
 */
function fitOffsets(observations, leagueIds, pinnedLeagueId, params, {
  sweeps = 40, bracket = 500, iterations = 18, tolerance = 1e-4,
} = {}) {
  const GR = 0.6180339887;
  const theta = new Map(leagueIds.map(id => [id, 0]));
  let prev = logLikelihood(observations, theta, params);

  for (let s = 0; s < sweeps; s++) {
    for (const id of leagueIds) {
      if (id === pinnedLeagueId) continue;
      let lo = -bracket, hi = bracket;
      for (let i = 0; i < iterations; i++) {
        const m1 = hi - GR * (hi - lo), m2 = lo + GR * (hi - lo);
        theta.set(id, m1); const l1 = logLikelihood(observations, theta, params);
        theta.set(id, m2); const l2 = logLikelihood(observations, theta, params);
        if (l1 > l2) hi = m2; else lo = m1;
      }
      theta.set(id, (lo + hi) / 2);
    }
    const cur = logLikelihood(observations, theta, params);
    if (Math.abs(cur - prev) < tolerance) break;
    prev = cur;
  }
  return theta;
}

/**
 * Profile-likelihood interval: how far `leagueId` can move before the
 * log-likelihood falls by 0.5, everything else held at the optimum.
 */
function profileInterval(observations, theta, leagueId, params, { reach = 700, iterations = 16 } = {}) {
  const mle = theta.get(leagueId);
  const target = logLikelihood(observations, theta, params) - 0.5;
  const edge = (direction) => {
    let a = mle, b = mle + direction * reach;
    for (let i = 0; i < iterations; i++) {
      const mid = (a + b) / 2;
      theta.set(leagueId, mid);
      if (logLikelihood(observations, theta, params) > target) a = mid; else b = mid;
    }
    theta.set(leagueId, mle);
    return (a + b) / 2;
  };
  const hi = edge(+1), lo = edge(-1);
  return { lo, hi, se: (hi - lo) / 2 };
}

// ---------------------------------------------------------------------------
// io
// ---------------------------------------------------------------------------

async function fetchAll(supabase, table, columns, order) {
  const all = [];
  for (let from = 0; ; from += PAGE_SIZE) {
    let q = supabase.from(table).select(columns);
    for (const o of order ?? []) q = q.order(o, { ascending: true });
    const { data, error } = await q.range(from, from + PAGE_SIZE - 1);
    if (error) throw new Error(`${table}: ${error.message}`);
    all.push(...(data ?? []));
    if (!data || data.length < PAGE_SIZE) break;
  }
  return all;
}

async function run() {
  console.log(`\n[fit] ${new Date().toISOString()}${DRY_RUN ? ' [DRY RUN]' : ''}`);
  const supabase = getClient();

  const leagues = await fetchAll(supabase, 'leagues', 'id, name, country');
  const competitions = new Map(leagues.map(l => [l.id, {
    name: l.name, country: l.country,
    isDomestic: !NON_DOMESTIC_COUNTRIES.has(l.country) && l.name !== 'League Cup',
    isInterLeague: INTER_LEAGUE.has(l.name),
  }]));
  const reference = leagues.find(l => l.name === REFERENCE.name && l.country === REFERENCE.country);
  if (!reference) throw new Error(`reference league ${REFERENCE.name}/${REFERENCE.country} not found`);

  const matches = await fetchAll(supabase, 'elo_corpus',
    'id, kickoff_at, result, league_id, home_key, away_key', ['kickoff_at', 'id']);
  console.log(`[fit] ${matches.length} deduplicated completed fixture(s)`);

  const params = await loadEloParams(supabase);
  console.log(`[fit] draw model: drawAtParity=${params.drawAtParity} drawSpread=${params.drawSpread} homeAdv=${params.homeAdv}`);

  const prematch = replayPrematch(matches);
  const bySeason = leagueBySeason(matches, competitions);

  const observations = [];
  for (const m of matches) {
    const comp = competitions.get(m.league_id);
    if (!comp?.isInterLeague) continue;             // only a genuinely inter-league competition
    const season = seasonOf(m.kickoff_at);
    const hl = bySeason.get(`${m.home_key}|${season}`);
    const al = bySeason.get(`${m.away_key}|${season}`);
    if (!hl || !al || hl === al) continue;
    const pm = prematch.get(m.id);
    if (!pm || Math.min(pm.hGames, pm.aGames) < MIN_GAMES) continue;
    observations.push({
      homeLeague: hl, awayLeague: al, result: m.result,
      base: pm.hElo + params.homeAdv - pm.aElo,
      isUefa: comp.name.startsWith('UEFA'),
    });
  }
  console.log(`[fit] ${observations.length} cross-league observation(s), both clubs past ${MIN_GAMES} games`);

  const leagueIds = [...new Set(observations.flatMap(o => [o.homeLeague, o.awayLeague]))];
  const zero = new Map(leagueIds.map(id => [id, 0]));
  const llZero = logLikelihood(observations, zero, params);
  const theta = fitOffsets(observations, leagueIds, reference.id, params);
  const llFit = logLikelihood(observations, theta, params);
  console.log(`[fit] log-likelihood ${llZero.toFixed(2)} -> ${llFit.toFixed(2)} `
    + `(2dLL = ${(2 * (llFit - llZero)).toFixed(1)} on ${leagueIds.length - 1} df)`);

  // Robustness: the same fit with the League Cup dropped.
  const uefaOnly = observations.filter(o => o.isUefa);
  const uefaLeagueIds = [...new Set(uefaOnly.flatMap(o => [o.homeLeague, o.awayLeague]))];
  const thetaUefa = fitOffsets(uefaOnly, uefaLeagueIds, reference.id, params);
  const uefaObs = new Map();
  for (const o of uefaOnly) {
    uefaObs.set(o.homeLeague, (uefaObs.get(o.homeLeague) ?? 0) + 1);
    uefaObs.set(o.awayLeague, (uefaObs.get(o.awayLeague) ?? 0) + 1);
  }

  const nObs = new Map(), nCup = new Map();
  for (const o of observations) {
    for (const lg of [o.homeLeague, o.awayLeague]) {
      nObs.set(lg, (nObs.get(lg) ?? 0) + 1);
      if (!o.isUefa) nCup.set(lg, (nCup.get(lg) ?? 0) + 1);
    }
  }

  const rows = [];
  for (const l of leagues) {
    if (!competitions.get(l.id)?.isDomestic) continue;
    const n = nObs.get(l.id) ?? 0;
    if (n === 0) {
      rows.push({ league_id: l.id, status: 'not_estimable', n_obs: 0,
        notes: 'closed pool: no completed fixture against a club from another league' });
      continue;
    }
    const { lo, hi, se } = profileInterval(observations, theta, l.id, params);
    const identified = n >= MIN_OBS && se <= MAX_SE;
    if (!identified) {
      rows.push({ league_id: l.id, status: 'not_estimable', n_obs: n,
        notes: `only ${n} cross-league observation(s), profile se ${se.toFixed(0)} — not identified` });
      continue;
    }
    const uefaN = uefaObs.get(l.id) ?? 0;
    const cupN = nCup.get(l.id) ?? 0;
    rows.push({
      league_id: l.id,
      status: l.id === reference.id ? 'reference' : 'fitted',
      theta_elo: round1(l.id === reference.id ? 0 : theta.get(l.id)),
      se_elo: round1(se), ci_lo: round1(lo), ci_hi: round1(hi), n_obs: n,
      identified_by: uefaN >= 20 && cupN >= 20 ? 'mixed' : uefaN >= 20 ? 'uefa' : 'league_cup',
      theta_uefa_only: uefaN >= 20 ? round1(thetaUefa.get(l.id) ?? 0) : null,
      notes: null,
    });
  }

  const usable = rows.filter(r => r.status === 'fitted' || r.status === 'reference');
  console.log(`[fit] ${usable.length} league(s) placed, ${rows.length - usable.length} not estimable`);
  for (const r of usable.sort((a, b) => (b.theta_elo ?? 0) - (a.theta_elo ?? 0))) {
    const l = leagues.find(x => x.id === r.league_id);
    console.log(`       ${String(r.theta_elo).padStart(7)} +-${String(r.se_elo).padStart(5)} `
      + `n=${String(r.n_obs).padStart(4)} ${r.identified_by.padEnd(10)} ${l.name} (${l.country})`);
  }

  // DRIFT. A refit that moves a league by more than its own standard error is
  // either real news or a broken corpus, and both are worth a line in the log
  // rather than a silent overwrite. This is the check that would have caught the
  // cross-country false merges — they showed up first as Liga MX coming out
  // STRONGER than the Premier League, not as a bad club rating.
  const { data: previous } = await supabase
    .from('league_strength').select('league_id, theta_elo, status');
  const before = new Map((previous ?? []).map(r => [r.league_id, r]));
  let drifted = 0;
  for (const r of rows) {
    const old = before.get(r.league_id);
    if (!old || old.theta_elo == null || r.theta_elo == null) {
      if (old && old.status !== r.status) {
        console.log(`[fit] STATUS ${leagueLabel(leagues, r.league_id)}: ${old.status} -> ${r.status}`);
      }
      continue;
    }
    const move = Math.abs(r.theta_elo - old.theta_elo);
    if (move > (r.se_elo ?? Infinity)) {
      drifted++;
      console.warn(`[fit] DRIFT ${leagueLabel(leagues, r.league_id)}: `
        + `${old.theta_elo} -> ${r.theta_elo} (moved ${move.toFixed(1)}, se ${r.se_elo})`);
    }
  }
  if (drifted) console.warn(`[fit] ${drifted} league(s) moved by more than one standard error — check the corpus before trusting this`);

  if (DRY_RUN) { console.log('[fit] dry run — nothing written'); return; }

  const method = 'maximum likelihood of the realised 1X2 outcome over cross-league fixtures in '
    + 'UEFA competitions and the League Cup; point-in-time pre-match ratings replayed over '
    + 'elo_corpus; coordinate ascent, Premier League (England) pinned at 0; se from the profile '
    + 'likelihood at dLL = 0.5; produced by fitLeagueStrength.js';

  const { error } = await supabase.from('league_strength').upsert(
    rows.map(r => ({
      league_id: r.league_id, status: r.status,
      theta_elo: r.theta_elo ?? null, se_elo: r.se_elo ?? null,
      ci_lo: r.ci_lo ?? null, ci_hi: r.ci_hi ?? null,
      n_obs: r.n_obs, identified_by: r.identified_by ?? null,
      theta_uefa_only: r.theta_uefa_only ?? null,
      method, notes: r.notes, fitted_at: new Date().toISOString(),
    })), { onConflict: 'league_id' });
  if (error) throw new Error(`league_strength upsert: ${error.message}`);
  console.log(`[fit] wrote ${rows.length} row(s)`);
}

const round1 = (x) => Math.round(x * 10) / 10;
const leagueLabel = (leagues, id) => {
  const l = leagues.find(x => x.id === id);
  return l ? `${l.name} (${l.country})` : id;
};

if (require.main === module) {
  run().catch(err => { console.error('[fit] fatal:', err.message); process.exit(1); });
}

module.exports = {
  MIN_GAMES, MIN_OBS, MAX_SE, REFERENCE, INTER_LEAGUE,
  seasonOf, replayPrematch, leagueBySeason, logLikelihood, fitOffsets, profileInterval,
};
