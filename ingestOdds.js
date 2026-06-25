/**
 * EVE — Odds Ingestion (plan-driven)
 *
 * Reads today's plan from Supabase (written by planDay.js) and decides
 * whether it is time to run. If not due yet, exits immediately using 0
 * API requests. If due, fetches /odds per fixture ID, then upserts to DB.
 *
 * DB efficiency: two bulk reads before the fixture loop replace ~50+ serial
 * round-trips per run:
 *   1. ONE bulk SELECT on matches  → Map<externalId, matchUUID>
 *   2. ONE bulk SELECT on odds     → Map<matchUUID:bookmaker:market, lastRow>
 * Inside the loop all "have prices moved?" checks are O(1) Map lookups.
 *
 * P1-5 fix: advancePlan is called AFTER the fixture loop, not before.
 *   Previously: plan advanced → fixture 3 hits 429 → run marked complete but
 *   odds never written. Now: if the loop throws, advancePlan never fires and
 *   the scheduler retries at the original next_run_at.
 *
 * P2-7 fix: extractH2hRows normalises oddsItem to an array before iterating.
 *   The API may return a single object or an array; both are now handled.
 *
 * Required env vars:
 *   RAPIDAPI_KEY, SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY
 *
 * Optional env vars:
 *   ODDS_COUNTRY       — bookmaker country filter (default: GB)
 *   ACTIVE_START_HOUR  — UTC hour to start polling (default: 8)
 *   ACTIVE_END_HOUR    — UTC hour to stop polling  (default: 24)
 *
 * Usage:
 *   node ingestOdds.js
 *   node ingestOdds.js --dry-run
 */

'use strict';

const https            = require('https');
const { getClient }    = require('./lib/supabaseClient');

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

const RAPIDAPI_KEY      = process.env.RAPIDAPI_KEY;
const API_HOST          = 'free-api-live-football-data.p.rapidapi.com';
const ODDS_COUNTRY      = process.env.ODDS_COUNTRY ?? 'GB';
const ACTIVE_START_HOUR = parseInt(process.env.ACTIVE_START_HOUR ?? '8',  10);
const ACTIVE_END_HOUR   = parseInt(process.env.ACTIVE_END_HOUR   ?? '24', 10);
const DRY_RUN           = process.argv.includes('--dry-run');

const MIN_PRICE_MOVEMENT = 0.01;

// ---------------------------------------------------------------------------
// ---------------------------------------------------------------------------
// HTTP — RapidAPI
// ---------------------------------------------------------------------------

function httpGetOnce(path) {
  if (!RAPIDAPI_KEY) throw new Error('RAPIDAPI_KEY not set');
  return new Promise((resolve, reject) => {
    https.request(
      {
        method:   'GET',
        hostname: API_HOST,
        path,
        headers: {
          'x-rapidapi-key':  RAPIDAPI_KEY,
          'x-rapidapi-host': API_HOST,
        },
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

async function httpGet(path, retries = 2, baseDelayMs = 30_000) {
  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      return await httpGetOnce(path);
    } catch (err) {
      if (err.is429 && attempt < retries) {
        const delay = baseDelayMs * attempt;
        console.warn(`[ingest] 429 on attempt ${attempt}/${retries} — waiting ${delay / 1000}s before retry`);
        await sleep(delay);
        continue;
      }
      throw err;
    }
  }
}

// ---------------------------------------------------------------------------
// Plan management
// ---------------------------------------------------------------------------

async function loadPlan(supabase) {
  const today = new Date().toISOString().slice(0, 10);
  const { data, error } = await supabase
    .from('engine_plan')
    .select('*')
    .eq('date', today)
    .maybeSingle();
  if (error) throw new Error(`loadPlan: ${error.message}`);
  return data;
}

/**
 * Advance next_run_at and increment runs_completed.
 * Called AFTER the fixture loop completes (P1-5 fix).
 * A failed loop leaves the plan untouched so the scheduler retries.
 */
async function advancePlan(supabase, plan) {
  const nextRunAt  = new Date(Date.now() + plan.interval_minutes * 60 * 1000);
  const nextHour   = nextRunAt.getUTCHours();
  const effectiveEnd = ACTIVE_END_HOUR === 24 ? 0 : ACTIVE_END_HOUR;
  const outsideWindow = ACTIVE_END_HOUR === 24
    ? nextRunAt.getUTCDate() > new Date().getUTCDate()
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
// Bulk prefetch helpers (replace N+1 pattern)
// ---------------------------------------------------------------------------

/**
 * Resolves all fixture API IDs to Supabase match UUIDs in one query.
 * Returns Map<externalIdStr, matchUUID>.
 *
 * @param {import('@supabase/supabase-js').SupabaseClient} supabase
 * @param {string[]} externalIds
 * @returns {Promise<Map<string, string>>}
 */
async function prefetchMatchIds(supabase, externalIds) {
  if (!externalIds.length) return new Map();
  const { data, error } = await supabase
    .from('matches')
    .select('id, external_id')
    .in('external_id', externalIds);
  if (error) throw new Error(`prefetchMatchIds: ${error.message}`);
  return new Map((data ?? []).map(r => [r.external_id, r.id]));
}

/**
 * Fetches the latest odds row per (match_id, bookmaker, market) for all
 * provided match UUIDs in ONE query. Deduplication to "latest per group"
 * is done in JavaScript by iterating the DESC-ordered result and taking
 * the first occurrence of each composite key.
 *
 * Replaces ~40 serial getLastOdds() calls with one bulk read.
 * Bounded to the last 48 hours to keep response size predictable.
 *
 * @param {import('@supabase/supabase-js').SupabaseClient} supabase
 * @param {string[]} matchIds
 * @returns {Promise<Map<string, {home_odds:number, draw_odds:number, away_odds:number}>>}
 *   Key: `${matchId}:${bookmaker}:${market}`
 */
async function prefetchLastOdds(supabase, matchIds) {
  if (!matchIds.length) return new Map();

  const since48h = new Date(Date.now() - 48 * 60 * 60 * 1000).toISOString();
  const { data, error } = await supabase
    .from('odds')
    .select('match_id, bookmaker, market, home_odds, draw_odds, away_odds, fetched_at')
    .in('match_id', matchIds)
    .gte('fetched_at', since48h)
    .order('fetched_at', { ascending: false });
  if (error) throw new Error(`prefetchLastOdds: ${error.message}`);

  // DESC order: first occurrence of each key is the most recent row.
  const map = new Map();
  for (const row of data ?? []) {
    const key = `${row.match_id}:${row.bookmaker}:${row.market}`;
    if (!map.has(key)) map.set(key, row);
  }
  return map;
}

// ---------------------------------------------------------------------------
// Odds API helpers
// ---------------------------------------------------------------------------

async function fetchFixtureOdds(fixtureId) {
  const path = `/football-event-odds?eventid=${fixtureId}&countrycode=${ODDS_COUNTRY}`;
  console.log(`  [odds] GET ${path}`);
  const json = await httpGet(path);
  if (!json.response?.odds) {
    console.log(`  [debug] raw response: ${JSON.stringify(json).slice(0, 500)}`);
  }
  return json.response?.odds ?? null;
}

// ---------------------------------------------------------------------------
// Bookmaker name normalisation
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
// H2H row extraction
// ---------------------------------------------------------------------------

/**
 * Extracts a 1X2 odds row from a single oddsItem object.
 * Shape: { persistentKey, odds: { resolvedOddsMarket: { selections: [{name, oddsDecimal}] } } }
 *
 * @param {object} oddsItem
 * @returns {Array<{bookmaker:string, market:string, home_odds:number, draw_odds:number, away_odds:number, fetched_at:string}>}
 */
function extractH2hRows(oddsItem) {
  const selections = oddsItem?.odds?.resolvedOddsMarket?.selections ?? [];
  if (!selections.length) return [];

  const find = (...keys) => selections.find(s => keys.includes((s.name ?? '').toUpperCase()));
  const homeS = find('1');
  const drawS = find('X', 'N');
  const awayS = find('2');
  if (!homeS || !drawS || !awayS) return [];

  const h = parseFloat(homeS.oddsDecimal);
  const d = parseFloat(drawS.oddsDecimal);
  const a = parseFloat(awayS.oddsDecimal);
  if (h <= 1 || d <= 1 || a <= 1 || h > 999) return [];

  const rawName  = (oddsItem.persistentKey ?? '').split('_')[0];
  const bookmaker = slugifyBookmaker(rawName);

  return [{
    bookmaker,
    market:     'h2h',
    home_odds:  h,
    draw_odds:  d,
    away_odds:  a,
    fetched_at: new Date().toISOString(),
  }];
}

// ---------------------------------------------------------------------------
// Price movement gate
// ---------------------------------------------------------------------------

function oddsHaveMoved(last, newRow) {
  if (!last) return true;
  return (
    Math.abs((newRow.home_odds ?? 0) - (last.home_odds ?? 0)) > MIN_PRICE_MOVEMENT ||
    Math.abs((newRow.away_odds ?? 0) - (last.away_odds ?? 0)) > MIN_PRICE_MOVEMENT ||
    (newRow.draw_odds != null && last.draw_odds != null &&
      Math.abs(newRow.draw_odds - last.draw_odds) > MIN_PRICE_MOVEMENT)
  );
}

// ---------------------------------------------------------------------------
// Match record helpers
// ---------------------------------------------------------------------------

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
      {
        external_id:  externalId,
        home_team_id: homeTeamId,
        away_team_id: awayTeamId,
        league_id:    leagueId,
        kickoff_at:   kickoffAt,
        status:       'scheduled',
      },
      { onConflict: 'external_id' },
    )
    .select('id').single();
  if (error) throw new Error(`upsertMatch: ${error.message}`);
  return data.id;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function ingest() {
  const now  = new Date();
  const hour = now.getUTCHours();

  // Sleep window guard — zero API calls, zero DB reads.
  const effectiveEnd = ACTIVE_END_HOUR === 24 ? 24 : ACTIVE_END_HOUR;
  if (hour < ACTIVE_START_HOUR || (ACTIVE_END_HOUR !== 24 && hour >= effectiveEnd)) {
    console.log(`[ingest] outside active window (${ACTIVE_START_HOUR}:00–${ACTIVE_END_HOUR}:00 UTC) — sleeping`);
    return;
  }

  const supabase = getClient();

  // 1. Load today's plan — one Supabase read, zero API calls.
  const plan = await loadPlan(supabase);

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

  // ── It's time to run ──────────────────────────────────────────────────────
  console.log(`\n[ingest] run ${plan.runs_completed + 1}/${plan.runs_planned} — ${now.toISOString()}`);
  console.log(`[ingest] ${plan.fixture_ids.length} fixture(s): ${plan.fixture_ids.join(', ')}`);

  // ── Bulk prefetch phase (2 queries replace ~50 serial reads) ──────────────

  // Bulk 1: resolve all fixture API IDs → Supabase match UUIDs
  const externalIds = plan.fixture_ids.map(String);
  const fixtureToMatchId = await prefetchMatchIds(supabase, externalIds);

  // Bulk 2: latest odds per (matchId, bookmaker, market) for all known matches
  const knownMatchIds = [...fixtureToMatchId.values()];
  const lastOddsMap   = await prefetchLastOdds(supabase, knownMatchIds);

  console.log(`[ingest] prefetch: ${fixtureToMatchId.size}/${externalIds.length} matches in DB, ${lastOddsMap.size} last-odds entries loaded`);

  // Cache the league DB id so we only upsert it once per run.
  let cachedLeagueId = null;

  const summary = { fixtures: plan.fixture_ids.length, oddsInserted: 0, errors: 0 };

  // ── Fixture loop — all "have prices moved?" checks are O(1) Map lookups ──
  for (const fixtureId of plan.fixture_ids) {
    try {
      const extIdStr = String(fixtureId);

      // Fetch odds from API
      const oddsRaw = await fetchFixtureOdds(fixtureId);
      if (!oddsRaw) {
        console.log(`  [skip] fixture ${fixtureId} — no odds returned`);
        await sleep(200);
        continue;
      }

      // P2-7 fix: API may return a single object or an array of bookmaker objects.
      // Normalise to array so extractH2hRows always processes one item at a time.
      const oddsItems = Array.isArray(oddsRaw) ? oddsRaw : [oddsRaw];
      const rows = oddsItems.flatMap(item => extractH2hRows(item));

      if (!rows.length) {
        console.log(`  [skip] fixture ${fixtureId} — no parseable 1X2 odds`);
        await sleep(200);
        continue;
      }

      // Resolve match UUID — use pre-fetched Map, create on-demand if missing
      let matchId = fixtureToMatchId.get(extIdStr);
      if (!matchId && !DRY_RUN) {
        if (!cachedLeagueId) {
          cachedLeagueId = await upsertLeague(supabase, 'FIFA World Cup', 'International');
        }
        const homeTeamId = await upsertTeam(supabase, `team_home_${fixtureId}`);
        const awayTeamId = await upsertTeam(supabase, `team_away_${fixtureId}`);
        matchId = await upsertMatch(supabase, {
          externalId:  extIdStr,
          homeTeamId,
          awayTeamId,
          leagueId:    cachedLeagueId,
          kickoffAt:   null,
        });
        fixtureToMatchId.set(extIdStr, matchId);
        console.log(`  [match] created placeholder match for fixture ${fixtureId} → ${matchId}`);
      }

      // Insert rows where prices have moved — O(1) Map lookup per row
      let fixtureInserted = 0;
      for (const row of rows) {
        const key  = `${matchId}:${row.bookmaker}:${row.market ?? 'h2h'}`;
        const last = lastOddsMap.get(key);

        if (!oddsHaveMoved(last, row)) continue;

        if (DRY_RUN) {
          console.log(`    [dry-run] ${row.bookmaker} H=${row.home_odds} D=${row.draw_odds} A=${row.away_odds}`);
          fixtureInserted++;
          // Update map optimistically so repeated dry-runs don't double-count
          lastOddsMap.set(key, row);
          continue;
        }

        const { error } = await supabase.from('odds').insert({ match_id: matchId, ...row });
        if (error) {
          // DB write failure is an explicit error — not silently swallowed.
          console.error(`    [error] odds insert failed (fixture=${fixtureId} book=${row.bookmaker}): ${error.message}`);
          summary.errors++;
        } else {
          fixtureInserted++;
          summary.oddsInserted++;
          // Optimistic map update: prevents redundant inserts if same bookmaker
          // appears twice in the same run (shouldn't happen, but defensive).
          lastOddsMap.set(key, row);
        }
      }

      if (fixtureInserted > 0) {
        console.log(`  fixture ${fixtureId} — inserted ${fixtureInserted} row(s)`);
      }

      await sleep(200);
    } catch (err) {
      console.error(`  [error] fixture ${fixtureId}: ${err.message}`);
      summary.errors++;
    }
  }

  // P1-5 fix: advancePlan runs AFTER the fixture loop.
  // If the loop threw (e.g. rate limit on fixture 3), advancePlan never fires
  // and the scheduler retries at the original next_run_at instead of marking
  // an incomplete run as complete.
  if (!DRY_RUN) {
    try {
      await advancePlan(supabase, plan);
    } catch (err) {
      // advancePlan failure is non-fatal to the odds data already written,
      // but we must surface it — the scheduler is now in an undefined state.
      console.error(`[ingest] advancePlan failed: ${err.message}`);
      summary.errors++;
    }
  }

  console.log('[ingest] done:', summary);

  if (summary.errors > 0) {
    throw new Error(`[ingest] completed with ${summary.errors} error(s) — check logs above`);
  }

  return summary;
}

// ---------------------------------------------------------------------------
// Utilities
// ---------------------------------------------------------------------------

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

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
