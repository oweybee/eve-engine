/**
 * EVE — Daily Planner
 *
 * Runs once per day (05:00 UTC). Fetches today's fixtures for every covered
 * league from API-Football, then calculates the optimal polling interval so
 * that the full daily request budget is spread evenly across the active window.
 *
 * The plan (fixture IDs, interval, next_run_at) is saved to Supabase so
 * ingestOdds.js can gate its own execution without any fixed cron logic.
 *
 * Budget maths:
 *   cost_per_run    = number of fixtures today (1 request per fixture for /odds)
 *   planner_cost    = 1 (this script's single /fixtures request)
 *   available_runs  = floor((DAILY_BUDGET - planner_cost) / cost_per_run)
 *   interval_mins   = ceil(active_minutes / available_runs)
 *
 * Active window default: 08:00–00:00 UTC (16 hours).
 * Sleep window (00:00–08:00) is excluded — no requests, no runs.
 *
 * Required env vars:
 *   API_FOOTBALL_KEY, SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY

 *
 * Optional env vars:
 *   LEAGUE_IDS            — comma-separated API-Football league IDs to cover
 *                           (default: top-5 European + EFL tiers + World Cup)
 *   FOOTBALL_SEASON       — season year, e.g. 2026 (default: current year)
 *   DAILY_REQUEST_BUDGET  — total requests available today (default: 100)
 *   ACTIVE_START_HOUR     — UTC hour active window opens (default: 8)
 *   ACTIVE_END_HOUR       — UTC hour active window closes (default: 24)
 *
 * Supabase table required (run once):
 *   create table engine_plan (
 *     date             date primary key,
 *     fixture_ids      integer[] not null default '{}',
 *     interval_minutes integer,
 *     next_run_at      timestamptz,
 *     runs_planned     integer not null default 0,
 *     runs_completed   integer not null default 0,
 *     created_at       timestamptz not null default now()
 *   );
 *
 * Usage:
 *   node planDay.js
 *   node planDay.js --dry-run
 */

'use strict';

const https            = require('https');
const { createClient } = require('@supabase/supabase-js');

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

const API_FOOTBALL_KEY    = process.env.API_FOOTBALL_KEY;
const API_FOOTBALL_HOST   = 'v3.football.api-sports.io';
const SUPABASE_URL        = process.env.SUPABASE_URL;
const SUPABASE_KEY        = process.env.SUPABASE_SERVICE_ROLE_KEY;

const DAILY_BUDGET        = parseInt(process.env.DAILY_REQUEST_BUDGET || '200', 10);
const ACTIVE_START_HOUR   = parseInt(process.env.ACTIVE_START_HOUR    || '8',   10);
const ACTIVE_END_HOUR     = parseInt(process.env.ACTIVE_END_HOUR      || '24',  10);
const DAYS_AHEAD          = parseInt(process.env.DAYS_AHEAD || '1', 10);
const FOOTBALL_SEASON     = parseInt(process.env.FOOTBALL_SEASON || String(new Date().getUTCFullYear()), 10);
const DRY_RUN             = process.argv.includes('--dry-run');

// ---------------------------------------------------------------------------
// Competition coverage
//
// Each API-Football league id maps to the canonical name/country the engine
// stores in Supabase. We keep an explicit catalog rather than trusting the
// provider's league name because that name is a join/filter key used by the
// frontend feed and the in-play model — it must stay stable.
//
// Override the active set with LEAGUE_IDS (comma-separated api ids), e.g.
//   LEAGUE_IDS=39,140   → Premier League + La Liga only
// Ids not in the catalog still work; they fall back to the provider's own
// league name/country when the match is upserted.
// ---------------------------------------------------------------------------

const LEAGUE_CATALOG = {
  39:  { name: 'Premier League', country: 'England' },
  140: { name: 'La Liga',        country: 'Spain'   },
  78:  { name: 'Bundesliga',     country: 'Germany' },
  135: { name: 'Serie A',        country: 'Italy'   },
  61:  { name: 'Ligue 1',        country: 'France'  },
  40:  { name: 'Championship',   country: 'England' },
  41:  { name: 'League One',     country: 'England' },
  42:  { name: 'League Two',     country: 'England' },
  1:   { name: 'FIFA World Cup', country: 'International' },
};

// Default coverage: top-5 European + English EFL tiers, plus the World Cup
// (id 1) so the in-flight 2026 tournament keeps producing signals. Drop it by
// setting LEAGUE_IDS without 1 once the tournament ends.
const DEFAULT_LEAGUE_IDS = [39, 140, 78, 135, 61, 40, 41, 42, 1];

const LEAGUE_IDS = process.env.LEAGUE_IDS
  ? process.env.LEAGUE_IDS.split(',').map(s => parseInt(s.trim(), 10)).filter(Number.isInteger)
  : DEFAULT_LEAGUE_IDS;

// ---------------------------------------------------------------------------
// Supabase
// ---------------------------------------------------------------------------

function getSupabase() {
  if (!SUPABASE_URL || !SUPABASE_KEY) throw new Error('Missing Supabase credentials');
  return createClient(SUPABASE_URL, SUPABASE_KEY);
}

// ---------------------------------------------------------------------------
// HTTP — API-Football v3
// ---------------------------------------------------------------------------

function httpGetOnce(path) {
  if (!API_FOOTBALL_KEY) throw new Error('API_FOOTBALL_KEY not set');
  return new Promise((resolve, reject) => {
    https.request(
      {
        method:   'GET',
        hostname: API_FOOTBALL_HOST,
        path,
        headers: { 'x-apisports-key': API_FOOTBALL_KEY },
      },
      res => {
        let body = '';
        res.on('data', c => { body += c; });
        res.on('end', () => {
          if (res.statusCode === 429) { reject(Object.assign(new Error('Rate limit hit'), { is429: true })); return; }
          if (res.statusCode !== 200) { reject(new Error(`HTTP ${res.statusCode}: ${body.slice(0, 200)}`)); return; }
          try { resolve(JSON.parse(body)); }
          catch (e) { reject(new Error(`JSON parse: ${e.message}`)); }
        });
      },
    ).on('error', reject).end();
  });
}

async function httpGet(path, retries = 3, baseDelayMs = 60_000) {
  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      return await httpGetOnce(path);
    } catch (err) {
      if (err.is429 && attempt < retries) {
        const delay = baseDelayMs * attempt;
        console.warn(`[plan] 429 on attempt ${attempt}/${retries} — waiting ${delay / 1000}s before retry`);
        await sleep(delay);
        continue;
      }
      throw err;
    }
  }
}

// ---------------------------------------------------------------------------
// Fetch fixtures for a single date across every covered league
// ---------------------------------------------------------------------------

// Filter out already-finished fixtures (FT = full time, AET = after extra time, PEN = penalties)
const FINISHED_STATUSES = ['FT', 'AET', 'PEN'];

async function fetchFixturesForDate(date) {
  const all = [];
  for (const leagueId of LEAGUE_IDS) {
    const path = `/fixtures?date=${date}&league=${leagueId}&season=${FOOTBALL_SEASON}`;
    console.log(`[plan] GET ${path}`);
    let json;
    try {
      json = await httpGet(path);
    } catch (err) {
      // One league failing must not sink the whole plan — log and carry on.
      console.warn(`[plan]   league ${leagueId} fetch failed: ${err.message}`);
      continue;
    }
    const fixtures = json.response ?? [];
    const upcoming = fixtures.filter(f => !FINISHED_STATUSES.includes(f.fixture?.status?.short));
    console.log(`[plan]   ${date} league ${leagueId}: ${fixtures.length} total, ${upcoming.length} upcoming`);
    all.push(...upcoming);
    await sleep(300); // gentle pause between per-league requests
  }
  return all;
}

// ---------------------------------------------------------------------------
// Fetch fixtures for today + DAYS_AHEAD days
// ---------------------------------------------------------------------------

async function fetchUpcomingFixtures(today) {
  const all = [];
  for (let i = 0; i < DAYS_AHEAD; i++) {
    const d = new Date(today);
    d.setUTCDate(d.getUTCDate() + i);
    const dateStr = d.toISOString().slice(0, 10);
    const matches = await fetchFixturesForDate(dateStr);
    all.push(...matches);
    if (i < DAYS_AHEAD - 1) await sleep(300); // gentle pause between requests
  }
  return all;
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// ---------------------------------------------------------------------------
// Calculate plan
// ---------------------------------------------------------------------------

function calcPlan(fixtures, today) {
  const fixtureIds = fixtures.map(f => f.fixture.id);

  if (fixtureIds.length === 0) {
    console.log(`[plan] no upcoming fixtures in the next ${DAYS_AHEAD} days across ${LEAGUE_IDS.length} league(s)`);
    return {
      date:             today,
      fixture_ids:      [],
      interval_minutes: null,
      next_run_at:      null,
      runs_planned:     0,
      runs_completed:   0,
    };
  }

  // Planner cost = 1 /fixtures request per league, per day fetched
  const plannerCost   = LEAGUE_IDS.length * DAYS_AHEAD;
  // Each run fetches odds for all fixtures in one pass (1 req per fixture).
  const costPerRun    = fixtureIds.length;
  const runBudget     = DAILY_BUDGET - plannerCost;
  const availableRuns = Math.floor(runBudget / costPerRun);
  const activeMinutes = (ACTIVE_END_HOUR - ACTIVE_START_HOUR) * 60;
  const intervalMins  = Math.ceil(activeMinutes / availableRuns);

  // First run: top of the active window today (or now if already past it).
  const firstRun = new Date(`${today}T${String(ACTIVE_START_HOUR).padStart(2, '0')}:00:00Z`);
  const now = new Date();
  const nextRunAt = firstRun < now ? now : firstRun;

  console.log(`[plan] ${today} (+${DAYS_AHEAD - 1} days ahead)`);
  console.log(`  fixtures:       ${fixtureIds.length} across ${DAYS_AHEAD} days (ids: ${fixtureIds.join(', ')})`);
  console.log(`  budget:         ${DAILY_BUDGET} req/day − ${plannerCost} planner = ${runBudget} for runs`);
  console.log(`  cost/run:       ${costPerRun} req (1 per fixture)`);
  console.log(`  available runs: ${availableRuns}`);
  console.log(`  active window:  ${ACTIVE_START_HOUR}:00–${ACTIVE_END_HOUR === 24 ? '00:00+1' : ACTIVE_END_HOUR + ':00'} UTC (${activeMinutes} min)`);
  console.log(`  interval:       every ${intervalMins} min`);
  console.log(`  first run at:   ${nextRunAt.toISOString()}`);

  return {
    date:             today,
    fixture_ids:      fixtureIds,
    interval_minutes: intervalMins,
    next_run_at:      nextRunAt.toISOString(),
    runs_planned:     availableRuns,
    runs_completed:   0,
  };
}

// ---------------------------------------------------------------------------
// Upsert match records so ingestOdds.js can link odds to real team names
// ---------------------------------------------------------------------------

// Resolve a fixture's league to a Supabase leagues.id, upserting on first use.
// Canonical name/country come from LEAGUE_CATALOG so the stored name is stable
// regardless of the provider's own wording; anything outside the catalog falls
// back to the provider's league name/country. Cached per run by API league id.
async function resolveLeagueId(supabase, apiLeague, cache) {
  const apiId = apiLeague?.id;
  if (apiId != null && cache.has(apiId)) return cache.get(apiId);

  const catalog = apiId != null ? LEAGUE_CATALOG[apiId] : null;
  const name    = catalog?.name    ?? apiLeague?.name    ?? 'Unknown League';
  const country = catalog?.country ?? apiLeague?.country ?? null;

  const { data, error } = await supabase
    .from('leagues')
    .upsert({ name, country }, { onConflict: 'name' })
    .select('id').single();
  if (error) { console.warn(`[plan] upsertLeague(${name}): ${error.message}`); return null; }

  if (apiId != null) cache.set(apiId, data.id);
  return data.id;
}

async function upsertMatches(supabase, fixtures) {
  const leagueCache = new Map(); // api league id → Supabase leagues.id
  let upserted = 0;
  for (const f of fixtures) {
    const fixtureId = f.fixture.id;
    const homeName  = f.teams?.home?.name ?? `home_${fixtureId}`;
    const awayName  = f.teams?.away?.name ?? `away_${fixtureId}`;

    const leagueId = await resolveLeagueId(supabase, f.league, leagueCache);
    if (!leagueId) continue;

    // kickoff is an ISO 8601 string e.g. "2026-06-25T20:00:00+00:00"
    const kickoffAt = f.fixture?.date ?? null;

    const shortName = n => n.length > 12 ? n.split(' ').slice(0, 2).join(' ') : n;

    const { data: homeRow } = await supabase.from('teams')
      .upsert({ name: homeName, short_name: shortName(homeName) }, { onConflict: 'name' })
      .select('id').single();
    const { data: awayRow } = await supabase.from('teams')
      .upsert({ name: awayName, short_name: shortName(awayName) }, { onConflict: 'name' })
      .select('id').single();
    if (!homeRow || !awayRow) continue;

    const { error: me } = await supabase.from('matches').upsert({
      external_id:   String(fixtureId),
      home_team_id:  homeRow.id,
      away_team_id:  awayRow.id,
      league_id:     leagueId,
      kickoff_at:    kickoffAt,
      status:        'scheduled',
    }, { onConflict: 'external_id' });

    if (me) console.warn(`[plan] upsertMatch(${fixtureId}): ${me.message}`);
    else upserted++;
  }
  console.log(`[plan] upserted ${upserted}/${fixtures.length} match records across ${leagueCache.size} league(s)`);
}

// ---------------------------------------------------------------------------
// Save plan to Supabase
// ---------------------------------------------------------------------------

async function savePlan(supabase, plan) {
  const { error } = await supabase
    .from('engine_plan')
    .upsert(plan, { onConflict: 'date' });
  if (error) throw new Error(`savePlan: ${error.message}`);
  console.log(`[plan] saved to Supabase`);
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

async function main() {
  const today = new Date().toISOString().slice(0, 10); // YYYY-MM-DD UTC
  console.log(`\n[planDay] ${DRY_RUN ? '(DRY RUN) ' : ''}${today} — budget ${DAILY_BUDGET} req, window ${ACTIVE_START_HOUR}:00–${ACTIVE_END_HOUR}:00 UTC\n`);

  // P1-3 fix: early-exit if a plan for today already exists.
  // Without this, every accidental re-run (or workflow retry) burns DAYS_AHEAD
  // API credits re-fetching the same fixtures and overwrites runs_completed → 0.
  if (!DRY_RUN) {
    const supabaseEarly = getSupabase();
    const { data: existing } = await supabaseEarly
      .from('engine_plan')
      .select('date, fixture_ids, runs_planned, runs_completed')
      .eq('date', today)
      .single();
    if (existing) {
      console.log(`[planDay] plan for ${today} already exists (${existing.fixture_ids?.length ?? 0} fixtures, ${existing.runs_completed}/${existing.runs_planned} runs) — skipping`);
      return;
    }
  }

  let fixtures;
  try {
    fixtures = await fetchUpcomingFixtures(today);
    console.log(`[plan] ${fixtures.length} total fixture(s) across next ${DAYS_AHEAD} days`);
  } catch (err) {
    console.error(`[plan] failed to fetch fixtures: ${err.message}`);
    process.exit(1);
  }

  const plan = calcPlan(fixtures, today);

  if (DRY_RUN) {
    console.log('\n[plan] dry-run — would save:', JSON.stringify(plan, null, 2));
    return;
  }

  const supabase = getSupabase();

  // Upsert match records with real team names so ingestOdds can link odds correctly
  try {
    await upsertMatches(supabase, fixtures);
  } catch (err) {
    console.warn(`[plan] upsertMatches failed: ${err.message}`);
  }
  try {
    await savePlan(supabase, plan);
  } catch (err) {
    console.error(`[plan] failed to save plan: ${err.message}`);
    process.exit(1);
  }

  console.log('\n[planDay] done');
}

main().catch(err => {
  console.error('[planDay] fatal:', err.message);
  process.exit(1);
});
