/**
 * EVE — Odds Ingestion (plan-driven)
 *
 * Reads today's plan from Supabase (written by planDay.js) and decides
 * whether it is time to run. If not due yet, exits immediately using 0
 * API requests. If due, fetches /odds per fixture ID (not per league),
 * advances next_run_at by the calculated interval, and upserts to DB.
 *
 * This script is triggered every 15 minutes by GitHub Actions, but most
 * invocations exit after a single Supabase read (no API calls made).
 * Actual odds fetches happen at the interval planDay.js calculated, which
 * equals active_minutes / available_runs — so the budget is consumed
 * exactly, spread evenly across the active window.
 *
 * Required env vars:
 *   API_FOOTBALL_KEY, SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY
 *
 * Optional env vars:
 *   ACTIVE_START_HOUR  — UTC hour to start polling (default: 8)
 *   ACTIVE_END_HOUR    — UTC hour to stop polling  (default: 24)
 *
 * Usage:
 *   node ingestOdds.js
 *   node ingestOdds.js --dry-run
 */

'use strict';

const https            = require('https');
const { createClient } = require('@supabase/supabase-js');

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

const API_FOOTBALL_KEY      = process.env.API_FOOTBALL_KEY;
const API_HOST = 'v3.football.api-sports.io';
const SUPABASE_URL      = process.env.SUPABASE_URL;
const SUPABASE_KEY      = process.env.SUPABASE_SERVICE_ROLE_KEY;
const ACTIVE_START_HOUR = parseInt(process.env.ACTIVE_START_HOUR ?? '8',  10);
const ACTIVE_END_HOUR   = parseInt(process.env.ACTIVE_END_HOUR   ?? '24', 10);
const DRY_RUN           = process.argv.includes('--dry-run');

// Only insert a new odds row when price moves by more than this.
const MIN_PRICE_MOVEMENT = 0.01;

// API-Football bet type IDs.
const BET_MATCH_WINNER = 1;

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
  if (!API_FOOTBALL_KEY) throw new Error('API_FOOTBALL_KEY not set');
  return new Promise((resolve, reject) => {
    const options = {
      method:   'GET',
      hostname: API_HOST,
      path:     path,
      headers: {
        'x-apisports-key': API_FOOTBALL_KEY,
      },
    };
    https.request(options, res => {
      let body = '';
      res.on('data', c => { body += c; });
      res.on('end', () => {
        if (res.statusCode === 429) { reject(new Error('Rate limit hit')); return; }
        if (res.statusCode !== 200) { reject(new Error(`HTTP ${res.statusCode}: ${body.slice(0, 200)}`)); return; }
        try {
          const parsed = JSON.parse(body);
          if (parsed.errors && Object.keys(parsed.errors).length > 0) {
            reject(new Error(`API error: ${JSON.stringify(parsed.errors)}`));
            return;
          }
          resolve(parsed);
        } catch (e) { reject(new Error(`JSON parse: ${e.message}`)); }
      });
    }).on('error', reject).end();
  });
}

// ---------------------------------------------------------------------------
// Load today's plan from Supabase
// ---------------------------------------------------------------------------

async function loadPlan(supabase) {
  const today = new Date().toISOString().slice(0, 10);
  const { data, error } = await supabase
    .from('engine_plan')
    .select('*')
    .eq('date', today)
    .maybeSingle();
  if (error) throw new Error(`loadPlan: ${error.message}`);
  return data; // null if planner hasn't run yet today
}

// ---------------------------------------------------------------------------
// Advance next_run_at in Supabase (called before fetching, prevents double-run)
// ---------------------------------------------------------------------------

async function advancePlan(supabase, plan) {
  const nextRunAt = new Date(Date.now() + plan.interval_minutes * 60 * 1000);

  // If the next run would fall outside the active window, null it out so
  // ingestOdds skips the rest of the day gracefully.
  const nextHour = nextRunAt.getUTCHours();
  const effectiveEnd = ACTIVE_END_HOUR === 24 ? 0 : ACTIVE_END_HOUR;
  const outsideWindow = ACTIVE_END_HOUR === 24
    ? nextRunAt.getUTCDate() > new Date().getUTCDate()  // past midnight
    : nextHour >= effectiveEnd;

  const { error } = await supabase
    .from('engine_plan')
    .update({
      next_run_at:    outsideWindow ? null : nextRunAt.toISOString(),
      runs_completed: plan.runs_completed + 1,
    })
    .eq('date', plan.date);

  if (error) throw new Error(`advancePlan: ${error.message}`);
  console.log(`[ingest] next run: ${outsideWindow ? 'none (window closed)' : nextRunAt.toISOString()}`);
}

// ---------------------------------------------------------------------------
// Fetch odds for a single fixture
// ---------------------------------------------------------------------------

async function fetchFixtureOdds(fixtureId) {
  const path = `/odds?fixture=${fixtureId}&bet=${BET_MATCH_WINNER}`;
  console.log(`  [odds] GET ${path}`);
  const json = await httpGet(path);
  return json.response?.[0] ?? null;
}

// ---------------------------------------------------------------------------
// Normalise bookmaker name to a slug
// ---------------------------------------------------------------------------

function slugifyBookmaker(name) {
  const map = {
    'Bet365':           'bet365',
    'William Hill':     'williamhill',
    'Ladbrokes':        'ladbrokes_uk',
    'Coral':            'coral',
    'Paddy Power':      'paddypower',
    'Betfair':          'betfair_sb_uk',
    'Betfair Exchange': 'betfair_ex_uk',
    'Betway':           'betway',
    'Unibet':           'unibet_uk',
    'SkyBet':           'skybet',
    'Sky Bet':          'skybet',
    'Betfred':          'betfred_uk',
    'BetVictor':        'betvictor',
    'Boylesports':      'boylesports',
    'BoyleSports':      'boylesports',
    'Virgin Bet':       'virginbet',
    '888sport':         'sport888',
    'Smarkets':         'smarkets',
    'Matchbook':        'matchbook',
  };
  return map[name] ?? name.toLowerCase().replace(/\s+/g, '_').replace(/[^a-z0-9_]/g, '');
}

// ---------------------------------------------------------------------------
// Extract 1X2 odds rows from an API-Football odds response item
// ---------------------------------------------------------------------------

function extractH2hRows(oddsItem) {
  const rows = [];
  for (const bm of (oddsItem?.bookmakers ?? [])) {
    const h2hBet = bm.bets?.find(b => b.id === BET_MATCH_WINNER);
    if (!h2hBet) continue;

    const homeVal = h2hBet.values?.find(v => v.value === 'Home');
    const drawVal = h2hBet.values?.find(v => v.value === 'Draw');
    const awayVal = h2hBet.values?.find(v => v.value === 'Away');
    if (!homeVal || !drawVal || !awayVal) continue;

    const h = parseFloat(homeVal.odd);
    const d = parseFloat(drawVal.odd);
    const a = parseFloat(awayVal.odd);
    if (h <= 1 || d <= 1 || a <= 1 || h > 999 || d > 999 || a > 999) continue;

    rows.push({
      bookmaker:  slugifyBookmaker(bm.name),
      market:     'h2h',
      home_odds:  h,
      draw_odds:  d,
      away_odds:  a,
      fetched_at: new Date().toISOString(),
    });
  }
  return rows;
}

// ---------------------------------------------------------------------------
// Upsert league / team / match (unchanged from previous version)
// ---------------------------------------------------------------------------

async function upsertLeague(supabase, name, country) {
  const { data, error } = await supabase
    .from('leagues')
    .upsert({ name, country }, { onConflict: 'name' })
    .select('id').single();
  if (error) throw new Error(`upsertLeague: ${error.message}`);
  return data.id;
}

async function upsertTeam(supabase, name) {
  const { data, error } = await supabase
    .from('teams')
    .upsert({ name, short_name: makeShortName(name) }, { onConflict: 'name' })
    .select('id').single();
  if (error) throw new Error(`upsertTeam: ${error.message}`);
  return data.id;
}

async function upsertMatch(supabase, { externalId, homeTeamId, awayTeamId, leagueId, kickoffAt }) {
  const { data, error } = await supabase
    .from('matches')
    .upsert(
      { external_id: externalId, home_team_id: homeTeamId, away_team_id: awayTeamId,
        league_id: leagueId, kickoff_at: kickoffAt, status: 'scheduled' },
      { onConflict: 'external_id' }
    )
    .select('id').single();
  if (error) throw new Error(`upsertMatch: ${error.message}`);
  return data.id;
}

// ---------------------------------------------------------------------------
// Insert odds (append-only, deduped by price movement)
// ---------------------------------------------------------------------------

async function getLastOdds(supabase, matchId, bookmaker, market = 'h2h') {
  const { data, error } = await supabase
    .from('odds')
    .select('home_odds, draw_odds, away_odds')
    .eq('match_id', matchId)
    .eq('bookmaker', bookmaker)
    .eq('market', market)
    .order('fetched_at', { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error) throw new Error(`getLastOdds: ${error.message}`);
  return data;
}

function oddsHaveMoved(last, newRow) {
  if (!last) return true;
  return (
    Math.abs((newRow.home_odds ?? 0) - (last.home_odds ?? 0)) > MIN_PRICE_MOVEMENT ||
    Math.abs((newRow.away_odds ?? 0) - (last.away_odds ?? 0)) > MIN_PRICE_MOVEMENT ||
    (newRow.draw_odds != null && last.draw_odds != null &&
      Math.abs(newRow.draw_odds - last.draw_odds) > MIN_PRICE_MOVEMENT)
  );
}

async function insertOddsRows(supabase, matchId, rows) {
  let inserted = 0;
  for (const row of rows) {
    const last = await getLastOdds(supabase, matchId, row.bookmaker, row.market ?? 'h2h');
    if (!oddsHaveMoved(last, row)) continue;
    if (DRY_RUN) {
      console.log(`    [dry-run] ${row.bookmaker} H=${row.home_odds} D=${row.draw_odds} A=${row.away_odds}`);
      inserted++;
      continue;
    }
    const { error } = await supabase.from('odds').insert({ match_id: matchId, ...row });
    if (error) console.warn(`    [warn] insert failed (${row.bookmaker}): ${error.message}`);
    else inserted++;
  }
  return inserted;
}

// ---------------------------------------------------------------------------
// Process a single fixture: fetch odds, upsert match + odds rows
// ---------------------------------------------------------------------------

async function processFixture(supabase, fixtureId, leagueId) {
  const oddsItem = await fetchFixtureOdds(fixtureId);
  if (!oddsItem) {
    console.log(`  [skip] fixture ${fixtureId} — no odds returned`);
    return 0;
  }

  const { fixture, league, teams } = oddsItem;
  const homeTeam    = teams?.home?.name ?? `home_${fixtureId}`;
  const awayTeam    = teams?.away?.name ?? `away_${fixtureId}`;
  const kickoffAt   = fixture?.date;
  const leagueName  = league?.name  ?? 'World Cup';
  const leagueCountry = league?.country ?? 'International';

  const rows = extractH2hRows(oddsItem);
  if (!rows.length) {
    console.log(`  [skip] ${homeTeam} vs ${awayTeam} — no valid bookmaker odds`);
    return 0;
  }

  console.log(`  ${homeTeam} vs ${awayTeam} (${rows.length} books)`);

  if (DRY_RUN) {
    for (const r of rows) console.log(`    [dry-run] ${r.bookmaker} H=${r.home_odds} D=${r.draw_odds} A=${r.away_odds}`);
    return rows.length;
  }

  const dbLeagueId  = leagueId ?? await upsertLeague(supabase, leagueName, leagueCountry);
  const homeTeamId  = await upsertTeam(supabase, homeTeam);
  const awayTeamId  = await upsertTeam(supabase, awayTeam);
  const matchId     = await upsertMatch(supabase, {
    externalId:  String(fixtureId),
    homeTeamId,
    awayTeamId,
    leagueId:    dbLeagueId,
    kickoffAt,
  });

  return insertOddsRows(supabase, matchId, rows);
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function ingest() {
  const now = new Date();
  const hour = now.getUTCHours();

  // Sleep window guard — exit immediately, zero API calls.
  const effectiveEnd = ACTIVE_END_HOUR === 24 ? 24 : ACTIVE_END_HOUR;
  if (hour < ACTIVE_START_HOUR || (ACTIVE_END_HOUR !== 24 && hour >= effectiveEnd)) {
    console.log(`[ingest] outside active window (${ACTIVE_START_HOUR}:00–${ACTIVE_END_HOUR}:00 UTC) — sleeping`);
    return;
  }

  const supabase = getSupabase();

  // Load today's plan — one Supabase read, zero API calls.
  let plan;
  try {
    plan = await loadPlan(supabase);
  } catch (err) {
    console.error(`[ingest] could not load plan: ${err.message}`);
    return;
  }

  if (!plan) {
    console.log('[ingest] no plan for today — has planDay.js run yet?');
    return;
  }

  if (!plan.fixture_ids?.length) {
    console.log('[ingest] rest day — no fixtures scheduled');
    return;
  }

  if (!plan.next_run_at) {
    console.log('[ingest] active window exhausted for today — done');
    return;
  }

  const nextRun = new Date(plan.next_run_at);
  if (now < nextRun) {
    const waitMins = Math.round((nextRun - now) / 60000);
    console.log(`[ingest] not due yet — ${waitMins} min until next run (${plan.next_run_at})`);
    return;
  }

  // ── It's time to run ────────────────────────────────────────────────────
  console.log(`\n[ingest] run ${plan.runs_completed + 1}/${plan.runs_planned} — ${now.toISOString()}`);
  console.log(`[ingest] ${plan.fixture_ids.length} fixture(s): ${plan.fixture_ids.join(', ')}`);

  // Advance the schedule first (prevents double-runs if this job overlaps).
  if (!DRY_RUN) await advancePlan(supabase, plan);

  const summary = { fixtures: plan.fixture_ids.length, oddsInserted: 0, errors: 0 };

  // Cache the league DB id so we only upsert it once per run.
  let cachedLeagueId = null;

  for (const fixtureId of plan.fixture_ids) {
    try {
      const inserted = await processFixture(supabase, fixtureId, cachedLeagueId);
      summary.oddsInserted += inserted;
      await sleep(200); // small pause between fixture requests
    } catch (err) {
      console.error(`  [error] fixture ${fixtureId}: ${err.message}`);
      summary.errors++;
    }
  }

  console.log('[ingest] done:', summary);
  return summary;
}

// ---------------------------------------------------------------------------
// Utilities
// ---------------------------------------------------------------------------

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function makeShortName(name) {
  const overrides = {
    'Manchester City':         'Man City',
    'Manchester United':       'Man Utd',
    'Tottenham Hotspur':       'Spurs',
    'Newcastle United':        'Newcastle',
    'Nottingham Forest':       'Nottm Forest',
    'West Ham United':         'West Ham',
    'Wolverhampton Wanderers': 'Wolves',
    'Brighton & Hove Albion':  'Brighton',
    'United States':           'USA',
    'United Arab Emirates':    'UAE',
    'Saudi Arabia':            'Saudi Arabia',
    'South Korea':             'S. Korea',
    'Costa Rica':              'Costa Rica',
    'New Zealand':             'New Zealand',
  };
  return overrides[name] ?? (name.length > 14 ? name.split(' ').slice(0, 2).join(' ') : name);
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

if (require.main === module) {
  ingest().catch(err => {
    console.error('[ingest] fatal:', err.message);
    process.exit(1);
  });
}

module.exports = { ingest, extractH2hRows, oddsHaveMoved };
