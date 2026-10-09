'use strict';

/**
 * fetchStandings.js — the governing body's own league table, per league-season.
 *
 *   GET /standings?league={apiLeagueId}&season={year}   → the whole table
 *
 * ONE CALL PER LEAGUE-SEASON, which is why this is affordable: 48 leagues in
 * `leagues`, so a full refresh is 48 requests against a daily budget that
 * `fetchTeamStats` alone spends ~11 per team on. A table moves once a matchday,
 * so the default refresh is twice a day.
 *
 * ── IT IS STORED, NEVER DERIVED ───────────────────────────────────────────
 *
 * `/competitions/[slug]` refused to draw a table for a year and the refusal was
 * right: a table derived from `matches` in the browser cannot know about points
 * deductions, expunged records, play-off groupings or a mid-season
 * reorganisation, because none of those is a match. It would have looked
 * authoritative and disagreed with the official table. So the number comes from
 * the vendor who has the governing body's version, and `position` is the
 * vendor's rank — never re-derived here by sorting on points, which would
 * reintroduce exactly the tie-break guessing this avoids.
 *
 * ── A TABLE WITH HOLES IN IT IS WORSE THAN NO TABLE ───────────────────────
 *
 * Measured 9 Oct 2026: 781 of 1,561 rows in `teams` carry an `external_id`. A
 * standings row keyed on our `team_id` would therefore drop about half the
 * clubs in a country, and a reader cannot tell a table with rows missing from a
 * correct one — they would just believe it. So the row carries the VENDOR'S
 * name and id as the key, and `team_id` is a nullable convenience: it is what
 * lets a fixture card say "10th v 2nd", and the table renders whole without it.
 *
 * ── AND A COMPETITION IS NOT ALWAYS ONE LADDER ────────────────────────────
 *
 * `/standings` returns an ARRAY of tables: a group phase comes back as four,
 * and "3rd" means nothing without saying 3rd of what. Each inner table keeps
 * its own `group_label`, so a page can draw four tables or pick the one a club
 * is in. A single-table competition stores null and reads as one ladder.
 *
 * Required env: API_FOOTBALL_KEY, SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY
 * Usage:
 *   node fetchStandings.js                      # current season, every league
 *   node fetchStandings.js --season 2025
 *   node fetchStandings.js --league 39 --dry-run
 */

const https         = require('https');
const { getClient } = require('./lib/supabaseClient');
const { beginWatchdog } = require('./lib/watchdog');
const apiQuota      = require('./lib/apiFootballQuota');

const API_FOOTBALL_KEY = process.env.API_FOOTBALL_KEY;
const API_HOST         = 'v3.football.api-sports.io';

const args = process.argv.slice(2);
const arg = (name, fb = null) => {
  const i = args.indexOf(name);
  return i !== -1 && args[i + 1] ? args[i + 1] : fb;
};
const DRY_RUN = args.includes('--dry-run');

/**
 * Wall-clock budget, seconds. MUST stay under the workflow step's
 * `timeout-minutes`: being killed is not the same as stopping, and a killed
 * run prints no summary, which is indistinguishable from a quiet slate.
 */
const BUDGET_SECONDS = parseFloat(process.env.STANDINGS_BUDGET_SECONDS || '100');
/** Courtesy gap between calls, the same one every other ingest here uses. */
const SLEEP_MS = parseInt(process.env.STANDINGS_SLEEP_MS || '120', 10);

/** API-Football season = the START year (2026 ⇒ 2026/27). Same rule as backfillSeasonFixtures. */
function currentSeasonYear(d = new Date()) {
  return d.getUTCMonth() + 1 >= 7 ? d.getUTCFullYear() : d.getUTCFullYear() - 1;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ── HTTP ─────────────────────────────────────────────────────────────────────
function httpGet(path) {
  if (!API_FOOTBALL_KEY) throw new Error('API_FOOTBALL_KEY not set');
  return new Promise((resolve, reject) => {
    https.request({ method: 'GET', hostname: API_HOST, path,
      headers: { 'x-apisports-key': API_FOOTBALL_KEY } },
      (res) => {
        let body = '';
        res.on('data', (c) => { body += c; });
        res.on('end', () => {
          // The vendor reports the day's counter on every response, and calling
          // its /status endpoint spends one against the counter it reports, so
          // the reading is taken from a call we were making anyway.
          apiQuota.report(res.headers);
          if (res.statusCode !== 200) {
            return reject(new Error(`HTTP ${res.statusCode}: ${body.slice(0, 200)}`));
          }
          try { resolve(JSON.parse(body)); } catch (e) { reject(new Error(`JSON parse: ${e.message}`)); }
        });
      }).on('error', reject).end();
  });
}

// ── Pure parsing (unit-tested) ───────────────────────────────────────────────

/**
 * Every row of every table in one `/standings` response.
 *
 * THE VENDOR'S SHAPE: `response[0].league.standings` is an ARRAY OF ARRAYS —
 * one inner array per group. A single-table competition is one inner array, so
 * there is no special case here, only a null `group_label` for it.
 *
 * A ROW WITHOUT A RANK, AN ID OR A NAME IS DROPPED. Those three are the
 * primary key and the thing a reader reads; a row missing any of them cannot
 * be stored or drawn, and inventing a position for it would put a club in a
 * place the governing body did not.
 */
function parseStandings(payload) {
  const league = payload?.response?.[0]?.league;
  const tables = league?.standings;
  if (!Array.isArray(tables)) return [];

  const out = [];
  for (const table of tables) {
    if (!Array.isArray(table)) continue;
    for (const row of table) {
      const apiTeamId = positiveIntOrNull(row?.team?.id);
      const name = row?.team?.name;
      const position = positiveIntOrNull(row?.rank);
      if (apiTeamId == null) continue;
      if (!name || !String(name).trim()) continue;
      if (position == null) continue;

      const all = row?.all ?? {};
      out.push({
        api_team_id: apiTeamId,
        team_name: String(name).trim(),
        crest_url: row?.team?.logo ?? null,
        // ONE GROUP NAME PER INNER TABLE and it comes off the ROW, because the
        // vendor puts it there rather than on the array. Null where the group
        // is just the competition's own name, which is how a single-table
        // competition comes back: "Premier League" is not a group.
        group_label: groupLabelFor(row?.group, league?.name),
        position,
        played: intOr0(all.played),
        won: intOr0(all.win),
        drawn: intOr0(all.draw),
        lost: intOr0(all.lose),
        goals_for: intOr0(all?.goals?.for),
        goals_against: intOr0(all?.goals?.against),
        points: intOr0(row?.points),
        form: row?.form ? String(row.form).trim() : null,
      });
    }
  }
  return out;
}

/**
 * The group a row belongs to, or null for a single-ladder competition.
 *
 * The vendor labels a plain league's only table with the COMPETITION'S OWN
 * NAME — `group: "Premier League"` — which is not a group and would print
 * "3rd in Premier League group" over a table already headed Premier League.
 * A real group reads "Group A" or "Championship Round", so the competition's
 * own name is treated as absence.
 */
function groupLabelFor(group, leagueName) {
  const g = group == null ? '' : String(group).trim();
  if (!g) return null;
  if (leagueName && g.toLowerCase() === String(leagueName).trim().toLowerCase()) return null;
  return g;
}

function intOr0(v) {
  if (v == null || v === '') return 0;
  const n = Number(v);
  return Number.isFinite(n) ? Math.trunc(n) : 0;
}

/**
 * A positive whole number, or null.
 *
 * `Number.isFinite(Number(x))` IS NOT THIS TEST, and the difference dropped a
 * test on first run: `Number(null)` is 0 and `Number('')` is 0, both finite,
 * so a row with a null rank and a null team id sailed through a finite check
 * and would have been stored at position 0 under club 0 — colliding with
 * every other such row on the primary key, and printing "0th" on a card.
 *
 * Zero is rejected on its own terms too: there is no 0th in a league table,
 * and no club is id 0.
 */
function positiveIntOrNull(v) {
  if (v == null || v === '') return null;
  const n = Number(v);
  if (!Number.isFinite(n)) return null;
  const i = Math.trunc(n);
  return i > 0 ? i : null;
}

/**
 * The rows to write, with our own `team_id` filled in where we know the club.
 *
 * NULL IS A FIRST-CLASS ANSWER HERE. Only half our `teams` rows carry an
 * external id, so most tables will have holes in this column on the first run
 * and the table still renders whole from `team_name`. Matching on NAME instead
 * would be the one thing worse than a null: `buildTeamAliases` exists because
 * club names do not match across feeds, and a wrong join puts another club's
 * league position on a fixture card.
 */
function withTeamIds(rows, byExternalId) {
  return rows.map((r) => ({
    ...r,
    team_id: byExternalId.get(String(r.api_team_id)) ?? null,
  }));
}

// ── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  const season = parseInt(arg('--season', String(currentSeasonYear())), 10);
  const onlyLeague = arg('--league', null);

  const summary = { leagues: 0, tables: 0, rows: 0, resolved: 0, empty: [], failed: [] };
  const dog = beginWatchdog('fetchStandings', {
    onTerminate: ({ stage }) => {
      console.error(`[standings] partial: ${summary.rows} row(s) across `
        + `${summary.leagues} league(s) written before the kill at "${stage}". `
        + 'Each league is committed on its own, so what is written is whole.');
    },
  });

  try {
    if (!API_FOOTBALL_KEY) {
      console.log('[standings] API_FOOTBALL_KEY not set — skipping');
      return;
    }
    const supabase = getClient();

    const { data: leagues, error: lErr } = await supabase
      .from('leagues').select('id, name, external_id').order('name');
    if (lErr) throw new Error(`leagues read: ${lErr.message}`);

    // THE EXTERNAL ID IS THE VENDOR'S LEAGUE ID. A league without one cannot
    // be asked for and is named in the summary rather than skipped silently.
    const targets = (leagues ?? []).filter((l) => {
      if (!/^\d+$/.test(String(l.external_id ?? ''))) return false;
      return onlyLeague == null || String(l.external_id) === String(onlyLeague);
    });
    const unusable = (leagues ?? []).filter((l) => !/^\d+$/.test(String(l.external_id ?? '')));

    // ONE READ FOR THE WHOLE RUN. 1,561 teams is a small table and resolving
    // per league would be 48 reads of the same thing.
    const { data: teams, error: tErr } = await supabase
      .from('teams').select('id, external_id').not('external_id', 'is', null);
    if (tErr) throw new Error(`teams read: ${tErr.message}`);
    const byExternalId = new Map((teams ?? []).map((t) => [String(t.external_id), t.id]));

    console.log(`[standings] season ${season}, ${targets.length} league(s), `
      + `${byExternalId.size} club(s) resolvable`);

    const startedAt = Date.now();
    for (const league of targets) {
      if ((Date.now() - startedAt) / 1000 > BUDGET_SECONDS) {
        console.log(`[standings] stopping on budget after ${summary.leagues} league(s) — `
          + 'the rest keep their previous table rather than being emptied');
        break;
      }
      dog.stage(`league ${league.name}`);

      let rows;
      try {
        const payload = await httpGet(`/standings?league=${league.external_id}&season=${season}`);
        rows = parseStandings(payload);
      } catch (e) {
        // A LEAGUE THAT FAILS KEEPS ITS LAST TABLE. One bad response is not a
        // reason to leave a competition page blank.
        summary.failed.push(`${league.name}: ${e.message}`);
        await sleep(SLEEP_MS);
        continue;
      }

      if (rows.length === 0) {
        // EMPTY IS A REAL ANSWER, not a failure: a competition between seasons
        // and one the subscription does not cover both come back with nothing.
        // Either way the stored table is left alone, because deleting it would
        // turn "we did not get told" into "there is no table".
        summary.empty.push(league.name);
        await sleep(SLEEP_MS);
        continue;
      }

      const toWrite = withTeamIds(rows, byExternalId).map((r) => ({
        ...r, league_id: league.id, season, updated_at: new Date().toISOString(),
      }));
      const groups = new Set(toWrite.map((r) => r.group_label ?? ''));

      if (!DRY_RUN) {
        // ── DELETE THEN INSERT, PER LEAGUE-SEASON ───────────────────────
        // An upsert alone leaves a club that has LEFT the table behind: a
        // relegated side, a club expunged mid-season, or a group stage that
        // has narrowed. That stale row keeps a position number, so the table
        // would show 21 teams in a 20-team league with two clubs claiming the
        // same place. The pair is not in a transaction — the Supabase client
        // has no way to ask for one — so the window between them draws an
        // empty table rather than a wrong one, which is the right way round.
        const { error: dErr } = await supabase.from('league_standings')
          .delete().eq('league_id', league.id).eq('season', season);
        if (dErr) { summary.failed.push(`${league.name}: clear ${dErr.message}`); continue; }

        const { error: iErr } = await supabase.from('league_standings').insert(toWrite);
        if (iErr) { summary.failed.push(`${league.name}: write ${iErr.message}`); continue; }
      }

      summary.leagues += 1;
      summary.tables += groups.size;
      summary.rows += toWrite.length;
      summary.resolved += toWrite.filter((r) => r.team_id != null).length;
      await sleep(SLEEP_MS);
    }

    const pct = summary.rows > 0 ? Math.round((100 * summary.resolved) / summary.rows) : 0;
    console.log(`[standings] ${DRY_RUN ? 'DRY RUN — ' : ''}`
      + `${summary.rows} row(s) in ${summary.tables} table(s) across `
      + `${summary.leagues} league(s); ${summary.resolved} (${pct}%) matched to a club of ours`);
    if (unusable.length) {
      console.log(`[standings] ${unusable.length} league(s) have no vendor id and were not asked for: `
        + unusable.map((l) => l.name).join(', '));
    }
    if (summary.empty.length) {
      console.log(`[standings] ${summary.empty.length} league(s) returned no table `
        + '(between seasons, or outside the subscription) and kept their previous one: '
        + summary.empty.join(', '));
    }
    if (summary.failed.length) {
      console.log(`[standings] ${summary.failed.length} league(s) failed and kept their previous table:`);
      for (const f of summary.failed) console.log(`[standings]   ${f}`);
    }
    // THE DAY'S COUNTER, read off the responses we were already making.
    const q = apiQuota.latestReading();
    if (q) console.log(`[standings] ${apiQuota.describeQuota(q)}`);
  } finally {
    dog.end();
  }
}

module.exports = { parseStandings, groupLabelFor, withTeamIds, currentSeasonYear };

if (require.main === module) {
  // THE READING IS PERSISTED AT THE END OF THE RUN, as every other
  // API-Football script here does, so the budget is visible between runs.
  main()
    .then(() => apiQuota.persistQuota(getClient()))
    .catch((e) => { console.error(`[standings] fatal: ${e.message}`); process.exit(1); });
}
