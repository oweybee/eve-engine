/**
 * backfillTeamCrests.js — give every club we already hold its provider id and
 * its crest.
 *
 * WHY IT EXISTS. `planDay.js` now captures `{ id, logo }` off every team object
 * it ingests, so from here on a club picks up its crest the first time it plays.
 * That does nothing for the 1,561 rows already in the table, and nothing for a
 * club whose next fixture is a fortnight away. This walks the tracked leagues
 * once and fills them in.
 *
 * WHY IT IS CHEAP. `/teams?league={id}&season={year}` returns every club in a
 * competition in ONE response. The whole tracked set is ~40 requests — the same
 * shape, and the same argument, as `backfillSeasonFixtures.js`.
 *
 * ── THE MATCH IS ON NAME, AND THAT IS THE HARD PART ───────────────────────
 *
 * There is no shared key yet — filling one in is the point of the run. So the
 * API's names and ours are clustered together by `buildCanonicalMap` from
 * `lib/teamNames.js` — the SAME function `buildTeamAliases.js` uses, and the
 * one whose three passes (exact canonical key, unambiguous token prefix, then
 * fuzzy above a floor) were audited against production in August 2026 and
 * found to contain three false merges, which were then fixed. A fourth
 * hand-rolled matcher here would be a fourth thing to get wrong, and its
 * mistakes would be invisible: a club silently wearing another club's badge.
 *
 * The first draft of this script DID hand-roll one, and its own tests caught
 * it: `canonicalKey('Wolves')` is `wolverhampton` while
 * `canonicalKey('Wolverhampton Wanderers')` is `wolverhamptonwanderers`, which
 * do not match — the prefix pass is what folds them, and only
 * `buildCanonicalMap` runs it. Placeholder rows (`team_home_1490361`, the E3
 * defect) are excluded by that function rather than by us.
 *
 * ONE CLUB CAN OWN SEVERAL ROWS AND THEY ARE TREATED DIFFERENTLY. `teams.name`
 * is unique and each SPELLING is its own row by design, so "Wolves" and
 * "Wolverhampton Wanderers" are two rows for one club. Migration 109 makes
 * `external_id` UNIQUE, so only one of them may carry the id — but both should
 * show the crest, and both do. The id goes to the strongest match; the crest
 * goes to every row that resolved.
 *
 * WHAT IT REPORTS. Coverage over the whole table AND over the clubs actually
 * playing in the next seven days, which is the number the board is judged on —
 * plus every API club that matched nothing. That list is the alias table's
 * to-do and is the only output of this script that needs a human.
 *
 * Usage:
 *   node backfillTeamCrests.js --dry-run          # match and report, write nothing
 *   node backfillTeamCrests.js
 *   node backfillTeamCrests.js --season 2026
 *   node backfillTeamCrests.js --leagues epl,e1   # corpus keys, as elsewhere
 *   node backfillTeamCrests.js --floor 0.94       # tighten the fuzzy pass
 */
'use strict';

const https = require('https');
const { getClient } = require('./lib/supabaseClient');
const { trackedLeagues } = require('./lib/trackedLeagues');
const { buildCanonicalMap, isPlaceholder } = require('./lib/teamNames');
const { upsertTeamRows } = require('./planDay');

const API_KEY = process.env.API_FOOTBALL_KEY;
const CHUNK = 500;

const args = process.argv.slice(2);
const flag = (name, fb) => {
  const i = args.indexOf(name);
  return i !== -1 && args[i + 1] ? args[i + 1] : fb;
};
const DRY = args.includes('--dry-run');

/**
 * The request ceiling. Shares `DAILY_REQUEST_BUDGET` with `planDay.js` because
 * it shares the API-Football quota — a backfill that spent the day's budget
 * would stop the fixture ingest, which is the pipeline this decoration hangs
 * off. One request per league, so the default is never close to binding.
 */
const BUDGET = parseInt(process.env.DAILY_REQUEST_BUDGET || '200', 10);

/** API-Football season = the START year (2026 ⇒ 2026/27). Mirrors backfillSeasonFixtures. */
function currentSeasonYear(d = new Date()) {
  return d.getUTCMonth() + 1 >= 7 ? d.getUTCFullYear() : d.getUTCFullYear() - 1;
}

function httpGet(path) {
  return new Promise((resolve, reject) => {
    https.get({
      host: 'v3.football.api-sports.io', path,
      headers: { 'x-apisports-key': API_KEY },
    }, res => {
      let body = '';
      res.on('data', d => (body += d));
      res.on('end', () => {
        if (res.statusCode >= 400) {
          return reject(new Error(`API ${res.statusCode}: ${body.slice(0, 160)}`));
        }
        try { resolve(JSON.parse(body)); } catch (e) { reject(new Error(`bad JSON: ${e.message}`)); }
      });
    }).on('error', reject);
  });
}

/**
 * Every club in one competition. Surfaces `errors`, which API-Football returns
 * with HTTP 200 — a season the plan does not cover is an EMPTY response with an
 * error string, not a 4xx, and is otherwise indistinguishable from a league
 * that did not run.
 */
async function fetchLeagueTeams(leagueId, season, get = httpGet) {
  const json = await get(`/teams?league=${leagueId}&season=${season}`);
  const errors = json?.errors;
  const errText = Array.isArray(errors) ? errors.join('; ')
    : (errors && typeof errors === 'object' ? Object.values(errors).join('; ') : '');
  const rows = Array.isArray(json?.response) ? json.response : [];
  return {
    teams: rows.map(r => ({
      id: r?.team?.id,
      name: r?.team?.name,
      logo: r?.team?.logo,
    })).filter(t => t.id != null && t.name),
    error: errText || null,
  };
}

/**
 * Cluster the API's club names together with ours and report, per cluster,
 * which of our rows belong to which API club.
 *
 * PURE, so the matching is testable without the API or the database — which
 * matters more here than usual, because both ways this can fail are silent: an
 * unmatched club simply has no badge, and a WRONGLY matched one wears somebody
 * else's.
 *
 * @param {{name: string}[]} ourRows      rows from `teams`
 * @param {{id: number, name: string, logo: string|null, league: string}[]} apiTeams
 * @returns {{ matched: {api: object, rows: object[]}[], unmatched: object[] }}
 */
function clusterTeams(ourRows, apiTeams, floor = 0.92) {
  const input = [
    ...ourRows.map(r => ({ source: 'teams', name: r.name })),
    ...apiTeams.map(t => ({ source: 'api', name: t.name })),
  ];
  const { aliases } = buildCanonicalMap(input, { floor });

  // canonical_key -> the names on each side of it
  const keyOf = new Map();                       // `${source}|${name}` -> canonical_key
  for (const a of aliases) keyOf.set(`${a.source}|${a.name}`, a.canonical_key);

  const ourByKey = new Map();
  for (const r of ourRows) {
    const k = keyOf.get(`teams|${r.name}`);
    if (!k) continue;                            // placeholder, dropped by buildCanonicalMap
    if (!ourByKey.has(k)) ourByKey.set(k, []);
    ourByKey.get(k).push(r);
  }

  const matched = [];
  const unmatched = [];
  for (const t of apiTeams) {
    const k = keyOf.get(`api|${t.name}`);
    const rows = k ? ourByKey.get(k) : null;
    if (rows?.length) matched.push({ api: t, rows });
    else unmatched.push(t);
  }
  return { matched, unmatched };
}

async function readAllTeams(supabase) {
  // PostgREST caps a response at 1000 rows whatever .limit() says, and `teams`
  // holds more than that — an unpaged read loses the back of the alphabet and
  // presents as "no such club" rather than as an error.
  const out = [];
  for (let from = 0; ; from += CHUNK) {
    const { data, error } = await supabase
      .from('teams').select('id, name, crest_url, external_id')
      .order('name', { ascending: true })
      .range(from, from + CHUNK - 1);
    if (error) throw new Error(`read teams: ${error.message}`);
    out.push(...(data ?? []));
    if (!data || data.length < CHUNK) break;
  }
  return out;
}

/** Clubs playing in the next seven days — the denominator the board is judged on. */
async function readNextWeekTeamIds(supabase) {
  const now = new Date();
  const to = new Date(now.getTime() + 7 * 864e5);
  const ids = new Set();
  for (let from = 0; ; from += CHUNK) {
    const { data, error } = await supabase
      .from('matches').select('home_team_id, away_team_id')
      .gte('kickoff_at', now.toISOString())
      .lte('kickoff_at', to.toISOString())
      .range(from, from + CHUNK - 1);
    if (error) { console.warn(`[crests] next-7d read: ${error.message}`); return ids; }
    for (const m of data ?? []) { if (m.home_team_id) ids.add(m.home_team_id); if (m.away_team_id) ids.add(m.away_team_id); }
    if (!data || data.length < CHUNK) break;
  }
  return ids;
}

async function main() {
  if (!API_KEY) { console.error('[crests] API_FOOTBALL_KEY is not set'); process.exit(1); }

  const season = parseInt(flag('--season', String(currentSeasonYear())), 10);
  const floor = parseFloat(flag('--floor', '0.92'));
  const only = (flag('--leagues', '') || '').split(',').map(s => s.trim()).filter(Boolean);
  let leagues = trackedLeagues();
  if (only.length) leagues = leagues.filter(l => only.includes(l.corpusKey ?? l.name));

  const supabase = getClient();
  const ourTeams = await readAllTeams(supabase);
  const usable = ourTeams.filter(t => !isPlaceholder(t.name));
  console.log(`[crests] season ${season} · ${leagues.length} league(s) · ${ourTeams.length} team rows ` +
              `(${usable.length} non-placeholder)${DRY ? ' · DRY RUN' : ''}`);

  // ── 1. Collect every club the API knows, across the tracked set ──────────
  // The clustering is done ONCE over both name lists rather than per league,
  // because `buildCanonicalMap`'s prefix and fuzzy passes compare a name
  // against every other name it has been given — feeding it one league at a
  // time would hide exactly the cross-source spellings this exists to join.
  const apiTeams = [];
  const seenApiId = new Set();
  let calls = 0;
  for (const league of leagues) {
    if (calls >= BUDGET) { console.warn(`[crests] request budget ${BUDGET} reached — stopping early`); break; }
    let res;
    try { res = await fetchLeagueTeams(league.id, season); calls++; }
    catch (e) { console.warn(`[crests] ${league.name} (${league.country}): ${e.message}`); calls++; continue; }
    if (res.error) console.warn(`[crests] ${league.name} (${league.country}): API says "${res.error}"`);
    if (!res.teams.length) { console.warn(`[crests] ${league.name} (${league.country}): 0 teams returned`); continue; }
    for (const t of res.teams) {
      // A club can appear in two competitions (a league and a cup). Its id and
      // logo are the same in both, so the first sighting is enough.
      if (seenApiId.has(t.id)) continue;
      seenApiId.add(t.id);
      apiTeams.push({ ...t, league: `${league.name} (${league.country})` });
    }
  }

  // ── 2. Cluster, once ────────────────────────────────────────────────────
  const { matched, unmatched } = clusterTeams(usable, apiTeams, floor);

  const crestByName = new Map();
  const idByName = new Map();
  const claimedIds = new Set(ourTeams.filter(t => t.external_id).map(t => t.external_id));
  let noLogo = 0;

  for (const { api, rows } of matched) {
    if (!api.logo) noLogo++;

    // THE CREST GOES TO EVERY SPELLING. Two rows for one club must not draw two
    // different badges, and nothing about `crest_url` is unique.
    if (api.logo) for (const r of rows) crestByName.set(r.name, api.logo);

    // THE ID GOES TO ONE ROW ONLY — migration 109 makes it unique. An id already
    // standing in the table is left where it is rather than moved.
    const key = String(api.id);
    if (!claimedIds.has(key)) {
      const canonicalRow = rows.find(r => r.name === api.name) ?? rows[0];
      idByName.set(canonicalRow.name, key);
      claimedIds.add(key);
    }
  }

  // Build the payload the same way planDay does: a key present is a column
  // written, a key absent is a column left alone. Never send an explicit null.
  const names = new Set([...crestByName.keys(), ...idByName.keys()]);
  const rows = [];
  for (const name of names) {
    const row = { name };
    const crest = crestByName.get(name);
    const ext = idByName.get(name);
    if (crest) row.crest_url = crest;
    if (ext) row.external_id = ext;
    // `short_name` is deliberately absent: this script is not the authority on
    // it and sending one would overwrite whatever planDay computed.
    rows.push(row);
  }

  if (DRY) {
    console.log(`[crests] DRY RUN — would write ${rows.length} row(s): ` +
                `${crestByName.size} crest(s), ${idByName.size} external_id(s)`);
  } else if (rows.length) {
    const written = new Map();
    await upsertTeamRows(supabase, rows, written);
    console.log(`[crests] wrote ${rows.length} row(s): ${crestByName.size} crest(s), ${idByName.size} external_id(s)`);
  }

  // ── Coverage, measured from the database rather than from what we just sent ─
  const after = DRY ? ourTeams : await readAllTeams(supabase);
  const withCrest = after.filter(t => t.crest_url).length;
  const nextWeek = await readNextWeekTeamIds(supabase);
  const nextWeekRows = after.filter(t => nextWeek.has(t.id));
  const nextWeekWith = nextWeekRows.filter(t => t.crest_url).length;
  const pct = (n, d) => (d ? `${((n / d) * 100).toFixed(1)}%` : 'n/a');

  console.log('');
  console.log(`[crests] ${calls} request(s) · ${apiTeams.length} API club(s) · ${matched.length} matched · ${noLogo} matched but had no logo`);
  console.log(`[crests] COVERAGE  whole table     ${withCrest} / ${after.length}  (${pct(withCrest, after.length)})`);
  console.log(`[crests] COVERAGE  next 7 days     ${nextWeekWith} / ${nextWeekRows.length}  (${pct(nextWeekWith, nextWeekRows.length)})  <- the acceptance number`);

  if (unmatched.length) {
    console.log('');
    console.log(`[crests] ${unmatched.length} API club(s) matched NOTHING — this list is the alias table's to-do:`);
    for (const u of unmatched.map(t => `${t.name} — ${t.league}`).sort()) console.log(`           ${u}`);
  } else {
    console.log('[crests] every API club resolved to a row.');
  }
}

if (require.main === module) {
  main().catch(e => { console.error(`[crests] ${e.stack || e.message}`); process.exit(1); });
}

module.exports = { clusterTeams, fetchLeagueTeams, currentSeasonYear };
