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

const FOOTBALL_DATA_KEY   = process.env.FOOTBALL_DATA_KEY;
const API_HOST            = 'api.football-data.org';
const COMPETITION         = process.env.COMPETITION ?? 'WC'; // WC = FIFA World Cup
const SUPABASE_URL        = process.env.SUPABASE_URL;
const SUPABASE_KEY        = process.env.SUPABASE_SERVICE_ROLE_KEY;

const DAILY_BUDGET        = parseInt(process.env.DAILY_REQUEST_BUDGET  ?? '100', 10);
const ACTIVE_START_HOUR   = parseInt(process.env.ACTIVE_START_HOUR     ?? '8',   10);
const ACTIVE_END_HOUR     = parseInt(process.env.ACTIVE_END_HOUR       ?? '24',  10);
const DRY_RUN             = process.argv.includes('--dry-run');

const PLANNER_COST        = 1;

// ---------------------------------------------------------------------------
// Supabase
// ---------------------------------------------------------------------------

function getSupabase() {
  if (!SUPABASE_URL || !SUPABASE_KEY) throw new Error('Missing Supabase credentials');
  return createClient(SUPABASE_URL, SUPABASE_KEY);
}

// ---------------------------------------------------------------------------
// HTTP — football-data.org
// ---------------------------------------------------------------------------

function httpGet(path) {
  if (!FOOTBALL_DATA_KEY) throw new Error('FOOTBALL_DATA_KEY not set');
  return new Promise((resolve, reject) => {
    const options = {
      method:   'GET',
      hostname: API_HOST,
      path,
      headers: {
        'X-Auth-Token': FOOTBALL_DATA_KEY,
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
// Fetch today's fixtures
// ---------------------------------------------------------------------------

async function fetchTodayFixtures(date) {
  const path = `/v4/competitions/${COMPETITION}/matches?dateFrom=${date}&dateTo=${date}&status=SCHEDULED,LIVE,IN_PLAY,PAUSED`;
  console.log(`[plan] GET ${path}`);
  const json = await httpGet(path);
  return json.matches ?? [];
}

// ---------------------------------------------------------------------------
// Calculate plan
// ---------------------------------------------------------------------------

function calcPlan(fixtures, today) {
  const fixtureIds = fixtures.map(f => f.id);

  if (fixtureIds.length === 0) {
    console.log(`[plan] rest day — no fixtures on ${today}`);
    return {
      date:             today,
      fixture_ids:      [],
      interval_minutes: null,
      next_run_at:      null,
      runs_planned:     0,
      runs_completed:   0,
    };
  }

  // Each run fetches /odds once per fixture.
  const costPerRun    = fixtureIds.length;
  const runBudget     = DAILY_BUDGET - PLANNER_COST;
  const availableRuns = Math.floor(runBudget / costPerRun);
  const activeMinutes = (ACTIVE_END_HOUR - ACTIVE_START_HOUR) * 60;
  const intervalMins  = Math.ceil(activeMinutes / availableRuns);

  // First run: top of the active window today (or now if already past it).
  const firstRun = new Date(`${today}T${String(ACTIVE_START_HOUR).padStart(2, '0')}:00:00Z`);
  const now = new Date();
  const nextRunAt = firstRun < now ? now : firstRun;

  console.log(`[plan] ${today}`);
  console.log(`  fixtures:       ${fixtureIds.length} (ids: ${fixtureIds.join(', ')})`);
  console.log(`  budget:         ${DAILY_BUDGET} req/day − ${PLANNER_COST} planner = ${runBudget} for runs`);
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
    fixtures = await fetchTodayFixtures(today);
    console.log(`[plan] ${fixtures.length} fixture(s) returned from API`);
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
