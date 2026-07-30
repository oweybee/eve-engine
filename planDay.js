/**
 * EVE — Daily Planner
 *
 * Runs once per day (05:00 UTC). Fetches today's fixtures for every tracked
 * competition (see TRACKED_LEAGUES — World Cup, Allsvenskan, MLS) from
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
 *   ALLSVENSKAN_LEAGUE_ID — API-Football league ID (default: 113)
 *   MLS_LEAGUE_ID         — API-Football league ID (default: 253)
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
// Tracked competitions
// ---------------------------------------------------------------------------
// Each entry: { id: API-Football league id, name/country: the canonical row we
// upsert into `leagues` }. The upserted `name` is the SINGLE source of truth the
// frontend filters on (lib/feed.js AVAILABLE_LEAGUES) — keep the two in sync.
// The API's own league name is deliberately NOT used, so e.g. World Cup stays
// 'FIFA World Cup' (matching existing rows) rather than the API's "World Cup".
const WORLD_CUP_LEAGUE_ID   = parseInt(process.env.WORLD_CUP_LEAGUE_ID   || '1',   10);
const ALLSVENSKAN_LEAGUE_ID = parseInt(process.env.ALLSVENSKAN_LEAGUE_ID || '113', 10);
const MLS_LEAGUE_ID         = parseInt(process.env.MLS_LEAGUE_ID         || '253', 10);

// The full tracked set now lives in lib/trackedLeagues.js (40 competitions,
// 36 with corpus history). Ids are env-overridable and self-verified against the
// name API-Football returns, so a wrong id warns instead of silently ingesting
// the wrong competition. The three legacy env vars above are still honoured.
const { trackedLeagues, nameLooksRight } = require('./lib/trackedLeagues');
const { planPolling, summarise } = require('./lib/pollBudget');

const TRACKED_LEAGUES = trackedLeagues(process.env);

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
// Fetch one league's fixtures for a single date
// ---------------------------------------------------------------------------

async function fetchFixturesForDate(date, league) {
  const path = `/fixtures?date=${date}&league=${league.id}&season=${FOOTBALL_SEASON}`;
  console.log(`[plan] GET ${path}`);
  const json = await httpGet(path);
  const fixtures = json.response ?? [];
  // SELF-VERIFY the league id: compare our expected name to what the API calls
  // this id. A re-pointed or mistyped id would otherwise ingest the WRONG
  // competition silently — this makes it a loud line in the run log instead.
  const apiName = fixtures[0]?.league?.name;
  if (apiName && !nameLooksRight(league.name, apiName)) {
    console.warn(`[plan] ⚠ LEAGUE ID MISMATCH: id=${league.id} expected "${league.name}" ` +
                 `but API says "${apiName}" — fix the id in lib/trackedLeagues.js or ` +
                 `override it via env, then re-run.`);
  }
  // Filter out already-finished fixtures (FT = full time, AET = after extra time, PEN = penalties)
  const FINISHED_STATUSES = ['FT', 'AET', 'PEN'];
  const upcoming = fixtures.filter(f => !FINISHED_STATUSES.includes(f.fixture?.status?.short));
  console.log(`[plan]   ${league.name} ${date}: ${fixtures.length} total, ${upcoming.length} upcoming`);
  // Tag each fixture with its canonical league so upsertMatches assigns the
  // correct leagues row regardless of what the API names the competition.
  return upcoming.map(f => ({ ...f, _league: league }));
}

// ---------------------------------------------------------------------------
// Fetch fixtures across every tracked league for today + DAYS_AHEAD days
// ---------------------------------------------------------------------------

async function fetchUpcomingFixtures(today) {
  const all = [];
  for (let i = 0; i < DAYS_AHEAD; i++) {
    const d = new Date(today);
    d.setUTCDate(d.getUTCDate() + i);
    const dateStr = d.toISOString().slice(0, 10);
    for (const league of TRACKED_LEAGUES) {
      const matches = await fetchFixturesForDate(dateStr, league);
      all.push(...matches);
      await sleep(300); // gentle pause between requests
    }
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
    console.log(`[plan] no upcoming fixtures across ${TRACKED_LEAGUES.length} tracked leagues in the next ${DAYS_AHEAD} days`);
    return {
      date:             today,
      fixture_ids:      [],
      interval_minutes: null,
      next_run_at:      null,
      runs_planned:     0,
      runs_completed:   0,
    };
  }

  // ── Tiered, budget-aware polling (lib/pollBudget.js) ─────────────────────
  // Previously every fixture was polled at ONE flat interval, so quota went on
  // games three days out and ran thin before kickoff. Now each fixture gets an
  // interval by time-to-kickoff (5m in the closing 3h → 12h out at the far end),
  // and the planner degrades cheapest-information-first if the budget is tight.
  const plannerCost = DAYS_AHEAD * TRACKED_LEAGUES.length;
  const budgetPlan = planPolling({
    fixtures: fixtures.map(f => ({ id: f.fixture.id, kickoffAt: f.fixture.date })),
    budget: DAILY_BUDGET,
    reserve: { planner: plannerCost, details: 0, live: 0 },
  });
  console.log(`  ${summarise(budgetPlan)}`);

  // Per-fixture schedule for ingestOdds — it polls only what is DUE.
  const fixtureSchedule = {};
  for (const s2 of budgetPlan.schedule) {
    fixtureSchedule[String(s2.id)] = {
      tier: s2.tier, everyMin: s2.everyMin, nextPollAt: s2.nextPollAt,
    };
  }
  // The loop must wake at least as often as the tightest tier so closing-line
  // polls aren't missed; runs_planned is now an upper bound, not a hard budget.
  const tightest = Math.min(...budgetPlan.tiers.map(t => t.everyMin));
  const intervalMins = Math.max(1, tightest);
  const activeMinutes = (ACTIVE_END_HOUR - ACTIVE_START_HOUR) * 60;
  const availableRuns = Math.ceil(activeMinutes / intervalMins);

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
    fixture_schedule: fixtureSchedule,
    interval_minutes: intervalMins,
    next_run_at:      nextRunAt.toISOString(),
    runs_planned:     availableRuns,
    runs_completed:   0,
  };
}

// ---------------------------------------------------------------------------
// Upsert match records so ingestOdds.js can link odds to real team names
// ---------------------------------------------------------------------------

async function upsertMatches(supabase, fixtures, { extraCols } = {}) {
  // BATCHED, not per-fixture. The old shape — three sequential round trips per
  // fixture (home team, away team, match) — was fine for planDay's ~50-game
  // daily window but took over an hour for a whole-season backfill (~15k
  // fixtures), blowing straight past the workflow timeout. Same rows land
  // either way; they land in ~30 requests instead of ~45,000.
  //
  // `extraCols(fixture)` optionally returns extra columns to merge into that
  // fixture's row (the season backfill uses it to write final scores in the
  // same pass). Rows keep status 'scheduled' unless extraCols overrides it.
  const CHUNK = 500;
  const shortName = n => n.length > 12 ? n.split(' ').slice(0, 2).join(' ') : n;

  // 1. Leagues — a handful, resolved (and cached) one upsert each. League
  //    identity is (name, country): names collide across countries (two
  //    Premier Leagues, two Serie As, three Super Leagues — migration 044).
  const leagueKey = l => `${l.name}|${l.country}`;
  const leagueIdByKey = new Map();
  for (const f of fixtures) {
    const league = f._league ?? TRACKED_LEAGUES[0];
    if (leagueIdByKey.has(leagueKey(league))) continue;
    const { data, error } = await supabase
      .from('leagues')
      .upsert({ name: league.name, country: league.country }, { onConflict: 'name,country' })
      .select('id').single();
    if (error) { console.warn(`[plan] upsertLeague(${league.name}): ${error.message}`); continue; }
    leagueIdByKey.set(leagueKey(league), data.id);
  }

  // 2. Teams — unique by name (bulk upsert rejects in-batch duplicates), chunked.
  const uniqueTeams = new Map();
  for (const f of fixtures) {
    for (const name of [f.teams?.home?.name ?? `home_${f.fixture.id}`,
                        f.teams?.away?.name ?? `away_${f.fixture.id}`]) {
      if (!uniqueTeams.has(name)) uniqueTeams.set(name, { name, short_name: shortName(name) });
    }
  }
  const teamIdByName = new Map();
  const teamRows = [...uniqueTeams.values()];
  for (let i = 0; i < teamRows.length; i += CHUNK) {
    const { data, error } = await supabase.from('teams')
      .upsert(teamRows.slice(i, i + CHUNK), { onConflict: 'name' })
      .select('id, name');
    if (error) { console.warn(`[plan] upsertTeams: ${error.message}`); continue; }
    for (const t of data ?? []) teamIdByName.set(t.name, t.id);
  }

  // 3. Matches — unique by external_id (twin rows in one batch are a Postgres
  //    error, "cannot affect row a second time"), chunked.
  const rowById = new Map();
  for (const f of fixtures) {
    const fixtureId = f.fixture.id;
    const league    = f._league ?? TRACKED_LEAGUES[0];
    const leagueId  = leagueIdByKey.get(leagueKey(league));
    const homeId    = teamIdByName.get(f.teams?.home?.name ?? `home_${fixtureId}`);
    const awayId    = teamIdByName.get(f.teams?.away?.name ?? `away_${fixtureId}`);
    if (!leagueId || !homeId || !awayId) continue;
    rowById.set(String(fixtureId), {
      external_id:   String(fixtureId),
      home_team_id:  homeId,
      away_team_id:  awayId,
      league_id:     leagueId,
      // kickoff is an ISO 8601 string e.g. "2026-06-25T20:00:00+00:00"
      kickoff_at:    f.fixture?.date ?? null,
      status:        'scheduled',
      ...(extraCols ? extraCols(f) : null),
    });
  }
  let upserted = 0;
  const matchRows = [...rowById.values()];
  for (let i = 0; i < matchRows.length; i += CHUNK) {
    const batch = matchRows.slice(i, i + CHUNK);
    const { error: me } = await supabase.from('matches')
      .upsert(batch, { onConflict: 'external_id' });
    if (me) console.warn(`[plan] upsertMatches batch @${i}: ${me.message}`);
    else upserted += batch.length;
  }
  console.log(`[plan] upserted ${upserted}/${fixtures.length} match records`);
  return upserted;
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

  // P1-3 fix: early-exit if a plan for today already exists AND has fixtures.
  // Without this, every accidental re-run (or workflow retry) burns DAYS_AHEAD
  // API credits re-fetching the same fixtures and overwrites runs_completed → 0.
  //
  // The fixture-count check was added after a bad first-run-of-the-day fetch
  // (transient API-Football error/empty response) saved a 0-fixture plan and
  // then had that empty plan re-confirmed by this same guard on every 5-minute
  // tick for the rest of the day — ingestOdds.js self-gates on an empty plan,
  // so one bad fetch blacked out odds ingestion until UTC midnight. An empty
  // existing plan is now retried instead of locked in.
  if (!DRY_RUN) {
    const supabaseEarly = getSupabase();
    const { data: existing } = await supabaseEarly
      .from('engine_plan')
      .select('date, fixture_ids, runs_planned, runs_completed')
      .eq('date', today)
      .single();
    if (existing && (existing.fixture_ids?.length ?? 0) > 0) {
      console.log(`[planDay] plan for ${today} already exists (${existing.fixture_ids.length} fixtures, ${existing.runs_completed}/${existing.runs_planned} runs) — skipping`);
      return;
    }
    if (existing) {
      console.log(`[planDay] existing plan for ${today} has 0 fixtures — retrying fetch instead of locking in an empty day`);
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

// Only auto-run as a script — so backfillSeasonFixtures.js (and tests) can reuse
// upsertMatches/fetchFixturesForDate without kicking off a full planning run.
if (require.main === module) {
  main().catch(err => {
    console.error('[planDay] fatal:', err.message);
    process.exit(1);
  });
}

module.exports = { upsertMatches, fetchFixturesForDate, calcPlan, TRACKED_LEAGUES };
