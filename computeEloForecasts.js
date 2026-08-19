'use strict';

/**
 * computeEloForecasts.js — write one ELO 1X2 forecast per upcoming fixture, or
 * a named refusal.
 *
 * WHY THE ENGINE WRITES THIS AND THE BROWSER DOES NOT COMPUTE IT. /api/match-card
 * needs a live 1X2 forecast and has never had one — its `model` block has read
 * `available: false` since it was built, correctly, because production
 * DIXON_COLES inverts the market's own de-vigged price and printing that as a
 * forecast is a fabrication. The ELO ladder is a real forecast: built from
 * results alone, with a draw model fitted to realised outcomes and no market
 * number anywhere in it.
 *
 * The alternative was to compute the vector inside the Next route. That would
 * put a THIRD copy of the draw model in the product — SQL, this repo, the
 * browser — with nothing keeping them equal, which is the failure the MODEL_SIGMA
 * hand-copy caused twice in production without either copy throwing. E4 settled
 * the shape on 6 Aug: the engine scores, the surface reads.
 *
 * IT WITHHOLDS RATHER THAN GUESSES, AND SAYS WHOSE FAULT IT IS. Three things can
 * stop a forecast, and they are different facts:
 *   • a club has no rating at all (never appeared in the corpus);
 *   • a club has no place on the cross-league scale, or is placed by too few
 *     rated opponents (migrations 077-079);
 *   • the two ratings are on different scales and cannot be compared.
 * `placement()` in lib/leagueStrength names which club and why, and that reason
 * is stored on the row. A fixture with no forecast and a fixture nobody asked
 * about must never look the same from outside.
 *
 * IT NEVER DEFAULTS A RATING. `eloProbs` returns null for a missing side rather
 * than substituting 1500 — a defaulted rating is the ABSENCE of a forecast
 * wearing a number, and it would be scored as though it were a read.
 *
 * A DOMESTIC FIXTURE NEEDS NO OFFSET. Both clubs are in the same league, so the
 * two offsets cancel exactly; `fixture_placement` files it as basis
 * 'competition' and the raw ratings are used. That is not an approximation — it
 * is the identity, and it is why 8,999 of the 9,101 placeable fixtures need the
 * scale not at all.
 *
 * Required: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY.
 * Usage: node computeEloForecasts.js [--dry-run] [--limit=N]
 */

const { getClient } = require('./lib/supabaseClient');
const { eloProbs, loadEloParams } = require('./lib/eloProbs');
const { loadTeamScale, placement } = require('./lib/leagueStrength');

const DRY_RUN = process.argv.includes('--dry-run');
const LIMIT = (() => {
  const arg = process.argv.find(a => a.startsWith('--limit='));
  const n = arg ? Number(arg.split('=')[1]) : NaN;
  return Number.isFinite(n) && n > 0 ? n : null;
})();

const PAGE_SIZE = 1000;
const UPSERT_CHUNK = 500;

/** Every upcoming fixture with its placement verdict and canonical keys. */
async function fetchPlacements(supabase) {
  const out = [];
  for (let from = 0; ; from += PAGE_SIZE) {
    const { data, error } = await supabase
      .from('fixture_placement')
      .select('match_id, kickoff_at, home_name, away_name, '
            + 'competition_is_domestic_league, status, basis, unplaced_reason, '
            + 'home_key, away_key')
      .order('kickoff_at', { ascending: true })
      .range(from, from + PAGE_SIZE - 1);
    // Never swallowed. supabase-js RESOLVES with { error }, so an unchecked
    // await here writes a full table of refusals and reports success.
    if (error) throw new Error(`fixture_placement read failed: ${error.message}`);
    if (!data?.length) break;
    out.push(...data);
    if (data.length < PAGE_SIZE) break;
    if (LIMIT && out.length >= LIMIT) break;
  }
  return LIMIT ? out.slice(0, LIMIT) : out;
}

/**
 * Canonical club key -> rating.
 *
 * `team_elo.team_name` already holds the key (computeElo writes it from
 * `elo_corpus`), so no second normalisation runs here — one spelling, resolved
 * once, in SQL.
 *
 * `elo` IS `numeric`, AND POSTGREST SENDS NUMERIC AS A JSON STRING. That is not
 * a quirk to route around, it is the trap: `Number.isFinite("1627.3")` is
 * false, so a finiteness check on the raw field drops EVERY rating, the map
 * comes back empty, all 9,101 fixtures are withheld as `no_rating`, and the run
 * reports success. Coerce first, then check — the `lib/num` rule from the
 * frontend, which exists because `Number(null)` is 0 and the family shipped
 * five times.
 */
async function fetchRatings(supabase) {
  const out = new Map();
  let seen = 0;
  for (let from = 0; ; from += PAGE_SIZE) {
    const { data, error } = await supabase
      .from('team_elo')
      .select('team_name, elo, games')
      .range(from, from + PAGE_SIZE - 1);
    if (error) throw new Error(`team_elo read failed: ${error.message}`);
    if (!data?.length) break;
    seen += data.length;
    for (const r of data) {
      const elo = numberOrNull(r.elo);
      if (elo != null) out.set(r.team_name, { elo, games: numberOrNull(r.games) ?? 0 });
    }
    if (data.length < PAGE_SIZE) break;
  }
  // Loud, not silent. Rows arrived and none survived means the coercion is
  // wrong, and the symptom downstream is a table of confident-looking refusals.
  if (seen > 0 && out.size === 0) {
    throw new Error(`team_elo returned ${seen} rows and not one carried a usable rating `
      + '— the elo column is not being read as a number');
  }
  return out;
}

/** A finite number or null. Not `Number(x)` bare: `Number(null)` is 0, and a 0
 *  rating is a 1500-point disagreement rather than a missing one. Mirrors the
 *  helper in lib/eloProbs.js. */
function numberOrNull(x) {
  if (x == null || x === '') return null;
  const n = typeof x === 'number' ? x : Number(x);
  return Number.isFinite(n) ? n : null;
}

/**
 * One fixture's row, forecast or refusal.
 *
 * Exported for the tests, which drive it from fixtures rather than a database —
 * every branch here is a decision about what MAY be said, and those are the
 * branches worth pinning.
 */
function forecastRow(fixture, { ratings, scale, params }) {
  const base = {
    match_id: fixture.match_id,
    model: 'ELO',
    version: 'v1',
    computed_at: new Date().toISOString(),
    p_home: null, p_draw: null, p_away: null,
    elo_home: null, elo_away: null,
    theta_home: null, theta_away: null,
    cross_league: null, basis: null,
    withheld_code: null, withheld_reason: null,
  };

  const withheld = (code, reason) => ({ ...base, status: 'withheld', withheld_code: code, withheld_reason: reason });

  // The SQL verdict is honoured, not re-derived. `fixture_placement` already
  // owns "can these two be compared", and asking the question twice is how two
  // answers appear.
  if (fixture.status === 'unplaced') {
    return withheld('unplaced', fixture.unplaced_reason
      ?? 'the two clubs cannot be put on one rating scale');
  }

  const home = ratings.get(fixture.home_key);
  const away = ratings.get(fixture.away_key);
  if (!home || !away) {
    const missing = [
      ...(home ? [] : [fixture.home_name]),
      ...(away ? [] : [fixture.away_name]),
    ];
    return withheld('no_rating',
      `${missing.join(' and ')} ${missing.length > 1 ? 'have' : 'has'} no ELO rating — `
      + 'no completed fixture in the corpus');
  }

  // placement() applies the offsets and refuses on its own terms. Its numbers
  // are the ones scored, so a refusal here can never be worked around by
  // reading the raw ratings instead.
  const verdict = placement(scale, {
    competitionIsDomesticLeague: fixture.competition_is_domestic_league === true,
    homeKey: fixture.home_key,
    awayKey: fixture.away_key,
    eloHome: home.elo,
    eloAway: away.elo,
  });
  if (!verdict.placed) return withheld(verdict.code, verdict.reason);

  const probs = eloProbs(verdict.eloHome, verdict.eloAway, params);
  // eloProbs guards its own contract and returns null if the vector escapes
  // (0,1). A null here is a real refusal, not a shrug.
  if (!probs) {
    return withheld('vector_not_a_probability',
      'the rating gap produced a vector outside (0,1), so it is not a probability');
  }

  return {
    ...base,
    status: 'forecast',
    p_home: probs.pHome,
    p_draw: probs.pDraw,
    p_away: probs.pAway,
    elo_home: verdict.eloHome,
    elo_away: verdict.eloAway,
    theta_home: verdict.eloHome - home.elo,
    theta_away: verdict.eloAway - away.elo,
    cross_league: verdict.crossLeague === true,
    basis: verdict.basis ?? fixture.basis ?? null,
  };
}

async function main() {
  const supabase = getClient();

  const [params, scale, ratings, placements] = await Promise.all([
    loadEloParams(supabase),
    loadTeamScale(supabase),
    fetchRatings(supabase),
    fetchPlacements(supabase),
  ]);

  // An empty scale refuses every cross-league pair (loadTeamScale says so and
  // warns). That is a degraded run, not a broken one, so it is reported rather
  // than aborted — a domestic board still gets its forecasts.
  console.log(`[eloForecasts] ${placements.length} upcoming fixtures · `
    + `${ratings.size} rated clubs · ${scale.size} placed clubs`);

  const rows = placements.map(f => forecastRow(f, { ratings, scale, params }));

  const tally = rows.reduce((acc, r) => {
    const k = r.status === 'forecast' ? 'forecast' : `withheld:${r.withheld_code}`;
    acc[k] = (acc[k] ?? 0) + 1;
    return acc;
  }, {});
  for (const [k, n] of Object.entries(tally).sort((a, b) => b[1] - a[1])) {
    console.log(`  ${k.padEnd(32)} ${n}`);
  }

  if (DRY_RUN) {
    console.log('[eloForecasts] dry run — nothing written');
    return;
  }

  for (let i = 0; i < rows.length; i += UPSERT_CHUNK) {
    const chunk = rows.slice(i, i + UPSERT_CHUNK);
    const { error } = await supabase
      .from('elo_forecasts')
      .upsert(chunk, { onConflict: 'match_id' });
    if (error) throw new Error(`elo_forecasts upsert failed: ${error.message}`);
  }
  console.log(`[eloForecasts] wrote ${rows.length} rows`);
}

module.exports = { forecastRow };

if (require.main === module) {
  main().catch(err => {
    console.error('[eloForecasts]', err.message);
    process.exit(1);
  });
}
