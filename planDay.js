/**
 * EVE — Daily Planner
 *
 * Runs once per day (05:00 UTC). Fetches today's World Cup fixtures from
 * API-Football, then calculates the optimal polling interval so that the
 * full daily request budget is spread evenly across the active window.
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
 *   WORLD_CUP_LEAGUE_ID   — API-Football league ID (default: 1)
 *   FOOTBALL_SEASON       — season year, e.g. 2025 (default: current year)
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

const RAPIDAPI_KEY        = process.env.RAPIDAPI_KEY;
const API_HOST            = 'free-api-live-football-data.p.rapidapi.com';
const WORLD_CUP_KEYWORD   = process.env.WORLD_CUP_KEYWORD ?? 'FIFA World Cup';
const SUPABASE_URL        = process.env.SUPABASE_URL;
const SUPABASE_KEY        = process.env.SUPABASE_SERVICE_ROLE_KEY;

const DAILY_BUDGET        = parseInt(process.env.DAILY_REQUEST_BUDGET ?? '200', 10);
const ACTIVE_START_HOUR   = parseInt(process.env.ACTIVE_START_HOUR    ?? '8',   10);
const ACTIVE_END_HOUR     = parseInt(process.env.ACTIVE_END_HOUR      ?? '24',  10);
const DAYS_AHEAD          = parseInt(process.env.DAYS_AHEAD ?? '3', 10);
// All leagueIds used by this API for the FIFA World Cup (groups, knockouts etc.)
const WC_LEAGUE_IDS       = (process.env.WORLD_CUP_LEAGUE_IDS ?? '894796,894797,894798,894799,894800,894801,894802,894803,894804,894805')
  .split(',').map(Number);
const DRY_RUN             = process.argv.includes('--dry-run');

// ---------------------------------------------------------------------------
// Supabase
// ---------------------------------------------------------------------------

function getSupabase() {
  if (!SUPABASE_URL || !SUPABASE_KEY) throw new Error('Missing Supabase credentials');
  return createClient(SUPABASE_URL, SUPABASE_KEY);
}

// ---------------------------------------------------------------------------
// HTTP — RapidAPI
// ---------------------------------------------------------------------------

function httpGet(path) {
  if (!RAPIDAPI_KEY) throw new Error('RAPIDAPI_KEY not set');
  return new Promise((resolve, reject) => {
    const options = {
      method:   'GET',
      hostname: API_HOST,
      path,
      headers: {
        'x-rapidapi-key':  RAPIDAPI_KEY,
        'x-rapidapi-host': API_HOST,
      },
    };
    https.request(options, res => {
      let body = '';
      res.on('data', c => { body += c; });
      res.on('end', () => {
        if (res.statusCode === 429) { reject(new Error('Rate limit hit')); return; }
        if (res.statusCode !== 200) { reject(new Error(`HTTP ${res.statusCode}: ${body.slice(0, 200)}`)); return; }
        try { resolve(JSON.parse(body)); }
        catch (e) { reject(new Error(`JSON parse: ${e.message}`)); }
      });
    }).on('error', reject).end();
  });
}

// ---------------------------------------------------------------------------
// Fetch World Cup fixtures for a single date
// ---------------------------------------------------------------------------

async function fetchFixturesForDate(date) {
  const apiDate = date.replace(/-/g, '');
  const path = `/football-get-matches-by-date?date=${apiDate}`;
  console.log(`[plan] GET ${path}`);
  const json = await httpGet(path);
  const matches = json.response?.matches ?? json.matches ?? [];
  const wcMatches = matches.filter(m =>
    WC_LEAGUE_IDS.includes(m.leagueId) && !m.status?.finished
  );
  console.log(`[plan]   ${date}: ${matches.length} total, ${wcMatches.length} WC upcoming`);
  return wcMatches;
}

// ---------------------------------------------------------------------------
// Fetch World Cup fixtures for today + DAYS_AHEAD days
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
  const fixtureIds = fixtures.map(f => f.id);

  if (fixtureIds.length === 0) {
    console.log(`[plan] no World Cup fixtures in the next ${DAYS_AHEAD} days`);
    return {
      date:             today,
      fixture_ids:      [],
      interval_minutes: null,
      next_run_at:      null,
      runs_planned:     0,
      runs_completed:   0,
    };
  }

  // Planner cost = 1 request per day fetched
  const plannerCost   = DAYS_AHEAD;
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

async function upsertMatches(supabase, fixtures) {
  // Upsert the FIFA World Cup league row
  const { data: leagueRow, error: le } = await supabase
    .from('leagues')
    .upsert({ name: 'FIFA World Cup', country: 'International' }, { onConflict: 'name' })
    .select('id').single();
  if (le) { console.warn(`[plan] upsertLeague: ${le.message}`); return; }
  const leagueId = leagueRow.id;

  let upserted = 0;
  for (const f of fixtures) {
    const homeName = f.home?.name ?? f.home?.longName ?? `home_${f.id}`;
    const awayName = f.away?.name ?? f.away?.longName ?? `away_${f.id}`;

    // Parse kickoff time — format is "DD.MM.YYYY HH:MM" in the API response
    let kickoffAt = null;
    if (f.time) {
      const [datePart, timePart] = f.time.split(' ');
      const [d, m, y] = datePart.split('.');
      kickoffAt = `${y}-${m}-${d}T${timePart}:00Z`;
    }

    const shortName = n => n.length > 12 ? n.split(' ').slice(0, 2).join(' ') : n;

    const { data: homeRow } = await supabase.from('teams')
      .upsert({ name: homeName, short_name: shortName(homeName) }, { onConflict: 'name' })
      .select('id').single();
    const { data: awayRow } = await supabase.from('teams')
      .upsert({ name: awayName, short_name: shortName(awayName) }, { onConflict: 'name' })
      .select('id').single();
    if (!homeRow || !awayRow) continue;

    const { error: me } = await supabase.from('matches').upsert({
      external_id:   String(f.id),
      home_team_id:  homeRow.id,
      away_team_id:  awayRow.id,
      league_id:     leagueId,
      kickoff_at:    kickoffAt,
      status:        'scheduled',
    }, { onConflict: 'external_id' });

    if (me) console.warn(`[plan] upsertMatch(${f.id}): ${me.message}`);
    else upserted++;
  }
  console.log(`[plan] upserted ${upserted}/${fixtures.length} match records`);
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
