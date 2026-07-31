/**
 * backfillSeasonFixtures.js — load WHOLE-SEASON fixture lists into `matches`.
 *
 * WHY
 * The Odds API is a monthly credit pool, and lib/oddsApiBudget.js paces spend
 * against "league-days" — how many (league, day) pairs the month actually holds.
 * That denominator is only as good as the fixture calendar in the database. Until
 * now the DB only knew about the next few days (planDay fetches date-by-date), so
 * the pacer had to fall back to a calendar-time estimate. With full season lists
 * loaded it divides the pool against the real football ahead.
 *
 * WHY IT'S CHEAP
 * `/fixtures?league={id}&season={year}` returns an ENTIRE season in one response
 * (paging is followed if the API ever says otherwise). So the whole tracked set
 * costs ~1 request per league — ~40 requests for every fixture in a season,
 * versus planDay's per-date-per-league polling. By far the cheapest data in the
 * pipeline, which is why loading every season we care about is affordable.
 *
 * SEASON AVAILABILITY IS PLAN-GATED
 * How far back `--seasons` can reach depends on the API-Football subscription,
 * not on this script. A season the plan doesn't cover comes back as HTTP 200
 * with an `errors` payload and an empty response — indistinguishable from "this
 * league didn't run" unless you read `errors`, which fetchSeason does.
 *
 * WHAT IT WRITES
 * Reuses planDay's upsertMatches for leagues/teams/matches (single source of
 * truth, `external_id` conflict target, so re-running is idempotent). Finished
 * fixtures additionally get their scoreline and result, which also feeds the ELO
 * ladder and training exports — the schema forbids status='completed' without
 * goals, and the season endpoint supplies them, so this is safe and useful.
 *
 * Usage:
 *   node backfillSeasonFixtures.js                        # current season, all leagues
 *   node backfillSeasonFixtures.js --season 2026
 *   node backfillSeasonFixtures.js --seasons 2024,2025,2026
 *   node backfillSeasonFixtures.js --leagues epl,e1       # corpus keys
 *   node backfillSeasonFixtures.js --dry-run
 */
'use strict';

const https = require('https');
const { getClient } = require('./lib/supabaseClient');
const { trackedLeagues, nameLooksRight } = require('./lib/trackedLeagues');
const { upsertMatches } = require('./planDay');

const API_KEY = process.env.API_FOOTBALL_KEY;

const args = process.argv.slice(2);
const flag = (name, fb) => {
  const i = args.indexOf(name);
  return i !== -1 && args[i + 1] ? args[i + 1] : fb;
};
const DRY = args.includes('--dry-run');

/** API-Football season = the START year (2026 ⇒ 2026/27). */
function currentSeasonYear(d = new Date()) {
  return d.getUTCMonth() + 1 >= 7 ? d.getUTCFullYear() : d.getUTCFullYear() - 1;
}

const FINISHED = new Set(['FT', 'AET', 'PEN']);

/** home|draw|away for a finished fixture, else null (mirrors fetchResults). */
function outcomeOf(f) {
  const h = f?.goals?.home, a = f?.goals?.away;
  if (!FINISHED.has(f?.fixture?.status?.short)) return null;
  if (h == null || a == null) return null;
  return h > a ? 'home' : (h < a ? 'away' : 'draw');
}

/**
 * League-days per calendar month — the denominator the Odds API pacer divides
 * its monthly credit pool by. A "league-day" is one (league, date) pair: it's
 * the billing unit, because The Odds API charges per league request, not per
 * fixture, so ten Premier League games on a Saturday cost the same as one.
 *
 * Returns Map<'YYYY-MM', number>. Pure, so it's testable without the API.
 */
function leagueDaysByMonth(fixtures) {
  const seen = new Set();
  const byMonth = new Map();
  for (const f of fixtures) {
    const iso = f?.fixture?.date;
    const leagueId = f?.league?.id ?? f?._league?.id;
    if (!iso || leagueId == null) continue;
    const day = String(iso).slice(0, 10);          // YYYY-MM-DD (API sends TZ-qualified ISO)
    const key = `${leagueId}|${day}`;
    if (seen.has(key)) continue;                   // same league, same day → one billable unit
    seen.add(key);
    const month = day.slice(0, 7);
    byMonth.set(month, (byMonth.get(month) ?? 0) + 1);
  }
  return byMonth;
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
 * Fetch every page of a fixtures query.
 *
 * API-Football wraps every response in `paging: {current, total}`. A league+season
 * query normally comes back as a single page, but "normally" is not a guarantee we
 * can lean on here: a silently truncated season is precisely the failure this
 * script exists to prevent — the pacer would divide the monthly pool by a
 * calendar missing half its matchdays and quietly overspend. So follow paging
 * whenever the API says there's more, and surface how many pages it took.
 *
 * Also surfaces `errors`, which API-Football returns with HTTP 200 — a plan that
 * doesn't cover a requested season comes back as an EMPTY response with an error
 * string, not a 4xx, so without this it looks identical to "league didn't run".
 */
async function fetchSeason(leagueId, season, get = httpGet) {
  const all = [];
  let page = 1, pages = 1, calls = 0;
  do {
    const json = await get(`/fixtures?league=${leagueId}&season=${season}&page=${page}`);
    calls++;
    const errs = json?.errors;
    const errList = Array.isArray(errs) ? errs : Object.values(errs ?? {});
    if (errList.length) {
      // HTTP 200 + errors = plan/param problem. Loud, because it mimics "no fixtures".
      throw new Error(`API error: ${errList.join('; ')}`);
    }
    all.push(...(json.response ?? []));
    pages = json?.paging?.total ?? 1;
    page++;
  } while (page <= pages);
  return { fixtures: all, calls, pages };
}

/**
 * Finished fixtures need their scoreline written too — the schema rejects
 * status='completed' without goals, and these rows also feed computeElo and the
 * training exports.
 */
async function applyResults(supabase, fixtures) {
  let done = 0;
  for (const f of fixtures) {
    const outcome = outcomeOf(f);
    if (!outcome) continue;
    const { error } = await supabase
      .from('matches')
      .update({
        status: 'completed',
        goals_home: f.goals.home,
        goals_away: f.goals.away,
        result: outcome,
      })
      .eq('external_id', String(f.fixture.id));
    if (error) console.warn(`  warn result ${f.fixture.id}: ${error.message}`);
    else done++;
  }
  return done;
}

async function main() {
  if (!API_KEY) { console.log('[backfill] API_FOOTBALL_KEY not set — aborting'); process.exit(1); }

  const seasons = (flag('--seasons', flag('--season', String(currentSeasonYear()))) + '')
    .split(',').map(s => parseInt(s.trim(), 10)).filter(Number.isFinite);
  const resolvedSeasons = seasons.length ? seasons : [currentSeasonYear()];

  const onlyKeys = flag('--leagues', '').split(',').map(s => s.trim()).filter(Boolean);
  let leagues = trackedLeagues(process.env);
  if (onlyKeys.length) {
    leagues = leagues.filter(l => onlyKeys.includes(l.corpusKey ?? l.name));
  }

  console.log(`[backfill] ${leagues.length} league(s) × ${resolvedSeasons.length} season(s) ` +
              `≈ ${leagues.length * resolvedSeasons.length} request(s) (one per season per ` +
              `league, plus any extra pages)`);
  console.log(`[backfill] seasons: ${resolvedSeasons.join(', ')}`);

  const supabase = DRY ? null : getClient();
  let totalFixtures = 0, totalUpserted = 0, totalResults = 0, apiCalls = 0;
  let rateLimited = false;
  const mismatches = [];
  const allFixtures = [];

  for (const season of resolvedSeasons) {
    if (rateLimited) break;
    for (const league of leagues) {
      if (rateLimited) break;
      let fixtures, pages;
      try {
        const got = await fetchSeason(league.id, season);
        fixtures = got.fixtures;
        pages = got.pages;
        apiCalls += got.calls;
      } catch (e) {
        console.log(`  warn ${league.name} ${season}: ${e.message}`);
        if (/429|quota|limit|too many/i.test(e.message)) {
          console.log('[backfill] rate limited — stopping early; re-run later to continue ' +
                      '(upserts are idempotent on external_id)');
          rateLimited = true;
          break;
        }
        continue;
      }
      if (!fixtures.length) {
        console.log(`  ${league.name} ${season}: none (league may not run this season, ` +
                    `or your plan doesn't cover it)`);
        continue;
      }

      // Same self-verification planDay does: a re-pointed id must be loud.
      const apiName = fixtures[0]?.league?.name;
      if (apiName && !nameLooksRight(league.name, apiName)) {
        const msg = `id=${league.id} expected "${league.name}" but API says "${apiName}"`;
        mismatches.push(msg);
        console.warn(`  ⚠ LEAGUE ID MISMATCH: ${msg}`);
      }

      const tagged = fixtures.map(f => ({ ...f, _league: league }));
      totalFixtures += tagged.length;
      allFixtures.push(...tagged);
      const finished = tagged.filter(f => outcomeOf(f)).length;
      console.log(`  ${league.name} ${season}: ${tagged.length} fixtures (${finished} finished)` +
                  (pages > 1 ? ` [${pages} pages]` : ''));

      if (DRY) continue;
      // upsertMatches returns the Set of fixture ids that now have a match row.
      const ok = await upsertMatches(supabase, tagged);
      totalUpserted += (ok instanceof Set ? ok.size : (ok ?? 0));
      totalResults += await applyResults(supabase, tagged);
    }
  }

  console.log(`\n[backfill] ${apiCalls} API call(s) → ${totalFixtures} fixture(s) seen`);
  if (!DRY) console.log(`[backfill] upserted ${totalUpserted}, results written ${totalResults}`);
  if (mismatches.length) {
    console.warn(`\n[backfill] ⚠ ${mismatches.length} LEAGUE ID MISMATCH(ES) — fix in ` +
                 `lib/trackedLeagues.js or override via env:`);
    for (const m of mismatches) console.warn(`   ${m}`);
  }
  // The point of the exercise: the monthly quota division, from real football.
  const byMonth = leagueDaysByMonth(allFixtures);
  if (byMonth.size) {
    const credits = parseInt(process.env.ODDS_API_MONTHLY_CREDITS || '100000', 10);
    const reserve = parseInt(process.env.ODDS_API_RESERVE || '2000', 10);
    const spendable = Math.max(0, credits - reserve);
    console.log(`\n[backfill] LEAGUE-DAYS PER MONTH (the Odds API billing unit — one`);
    console.log(`           (league, date) pair, since a league request is priced the`);
    console.log(`           same whether it returns 1 fixture or 10):\n`);
    console.log(`           month     league-days   credits/league-day @ ${spendable.toLocaleString()}`);
    for (const month of [...byMonth.keys()].sort()) {
      const n = byMonth.get(month);
      const per = n ? Math.floor(spendable / n) : 0;
      console.log(`           ${month}   ${String(n).padStart(11)}   ${String(per).padStart(18)}`);
    }
    const busiest = [...byMonth.entries()].sort((a, b) => b[1] - a[1])[0];
    console.log(`\n[backfill] busiest month ${busiest[0]} at ${busiest[1]} league-days — ` +
                `pace for that one, not the average.`);
  }

  console.log(`\n[backfill] the Odds API pacer can now divide its monthly pool against ` +
              `real fixture calendars instead of a calendar-time estimate.`);
}

if (require.main === module) {
  main().catch(err => { console.error('[backfill] FATAL:', err.message); process.exit(1); });
}

module.exports = { currentSeasonYear, outcomeOf, leagueDaysByMonth, fetchSeason, FINISHED };
