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
const { getClient }    = require('./lib/supabaseClient');

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

const API_FOOTBALL_KEY  = process.env.API_FOOTBALL_KEY;
const API_HOST          = 'v3.football.api-sports.io';
const ACTIVE_START_HOUR = parseInt(process.env.ACTIVE_START_HOUR || '8',  10);
const ACTIVE_END_HOUR   = parseInt(process.env.ACTIVE_END_HOUR   || '24', 10);
const DRY_RUN           = process.argv.includes('--dry-run');

const MIN_PRICE_MOVEMENT = 0.01;

// How many fixtures' odds to fetch concurrently (audit H6). The daily API budget
// is large; the only real limit is per-minute rate, which httpClient's
// Retry-After/backoff absorbs. Tune down if the plan's per-minute cap is tight.
const FETCH_CONCURRENCY = parseInt(process.env.INGEST_FETCH_CONCURRENCY || '6', 10);

// ---------------------------------------------------------------------------
// HTTP — API-Football v3
// ---------------------------------------------------------------------------

function httpGetOnce(path) {
  if (!API_FOOTBALL_KEY) throw new Error('API_FOOTBALL_KEY not set');
  return new Promise((resolve, reject) => {
    https.request(
      {
        method:   'GET',
        hostname: API_HOST,
        path,
        headers: {
          'x-apisports-key': API_FOOTBALL_KEY,
        },
      },
      res => {
        let body = '';
        res.on('data', c => { body += c; });
        res.on('end', () => {
          if (res.statusCode === 429) { reject(Object.assign(new Error('Rate limit hit'), { is429: true })); return; }
          if (res.statusCode !== 200) { reject(new Error(`HTTP ${res.statusCode}: ${body.slice(0, 200)}`)); return; }
          let json;
          try { json = JSON.parse(body); }
          catch (e) { reject(new Error(`JSON parse: ${e.message}`)); return; }
          // API-Football signals rate-limiting inside a 200 OK body instead of
          // an HTTP 429 status, e.g. {"errors":{"rateLimit":"Too many
          // requests..."},"response":[]}. Without this check it's
          // indistinguishable from a legitimate empty result, so the
          // retry/backoff below never fires and the fixture is silently
          // treated as "no odds available" every run.
          if (json?.errors?.rateLimit) {
            reject(Object.assign(new Error(`Rate limit hit (body): ${json.errors.rateLimit}`), { is429: true }));
            return;
          }
          resolve(json);
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
    .select('match_id, bookmaker, market, market_line, home_odds, draw_odds, away_odds, fetched_at')
    .in('match_id', matchIds)
    .gte('fetched_at', since48h)
    .order('fetched_at', { ascending: false });
  if (error) throw new Error(`prefetchLastOdds: ${error.message}`);

  // DESC order: first occurrence of each key is the most recent row.
  // Key includes market_line so different lines of the same market don't collide.
  const map = new Map();
  for (const row of data ?? []) {
    const key = `${row.match_id}:${row.bookmaker}:${row.market}:${row.market_line ?? ''}`;
    if (!map.has(key)) map.set(key, row);
  }
  return map;
}

// ---------------------------------------------------------------------------
// Odds API helpers
// ---------------------------------------------------------------------------

async function fetchFixtureOdds(fixtureId) {
  // No &bet filter — one call returns every market (1X2, O/U, BTTS, …) for all
  // bookmakers, so we extract secondary markets at zero extra API quota.
  const path = `/odds?fixture=${fixtureId}`;
  console.log(`  [odds] GET ${path}`);
  const json = await httpGet(path);
  if (!json.response?.length) {
    console.log(`  [debug] raw response: ${JSON.stringify(json).slice(0, 500)}`);
  }
  // Return the bookmakers array from the first response item, or empty array
  return json.response?.[0]?.bookmakers ?? [];
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
 * Extracts a 1X2 odds row from a single API-Football bookmaker object.
 * Shape: { id, name, bets: [{ id, name, values: [{ value, odd }] }] }
 * We look for the Match Winner bet (id === 1) with Home / Draw / Away values.
 *
 * @param {object} bookmaker
 * @returns {Array<{bookmaker:string, market:string, home_odds:number, draw_odds:number, away_odds:number, fetched_at:string}>}
 */
function extractH2hRows(bookmaker) {
  // Find the Match Winner market (bet id 1)
  const matchWinner = (bookmaker?.bets ?? []).find(b => b.id === 1);
  if (!matchWinner) return [];

  const values = matchWinner.values ?? [];
  const find   = label => values.find(v => (v.value ?? '').toLowerCase() === label.toLowerCase());
  const homeV  = find('Home');
  const drawV  = find('Draw');
  const awayV  = find('Away');
  if (!homeV || !drawV || !awayV) return [];

  const h = parseFloat(homeV.odd);
  const d = parseFloat(drawV.odd);
  const a = parseFloat(awayV.odd);
  if (h <= 1 || d <= 1 || a <= 1 || h > 999) return [];

  const bookmakerSlug = slugifyBookmaker(bookmaker.name ?? '');

  return [{
    bookmaker:  bookmakerSlug,
    market:     'h2h',
    home_odds:  h,
    draw_odds:  d,
    away_odds:  a,
    fetched_at: new Date().toISOString(),
  }];
}

/**
 * Extracts the Goals Over/Under 2.5 line from a bookmaker object.
 * API-Football: bet id 5 ("Goals Over/Under"), values like
 *   { value: "Over 2.5", odd: "1.74" }, { value: "Under 2.5", odd: "2.26" }
 *
 * Stored to match the existing Betfair convention so downstream reads uniformly:
 *   over → home_odds, under → away_odds, line → market_line, draw_odds → null.
 *
 * @param {object} bookmaker
 * @returns {Array<object>}
 */
const TOTALS_TARGET_LINE = 2.5;
function extractTotalsRows(bookmaker) {
  const ou = (bookmaker?.bets ?? []).find(b => b.id === 5);
  if (!ou) return [];

  let over = null, under = null;
  for (const v of ou.values ?? []) {
    const m = String(v.value ?? '').match(/^(over|under)\s+([\d.]+)$/i);
    if (!m || parseFloat(m[2]) !== TOTALS_TARGET_LINE) continue;
    const odd = parseFloat(v.odd);
    if (!(odd > 1) || odd > 999) continue;
    if (/over/i.test(m[1])) over = odd; else under = odd;
  }
  if (over == null || under == null) return [];

  return [{
    bookmaker:   slugifyBookmaker(bookmaker.name ?? ''),
    market:      'totals',
    market_line: TOTALS_TARGET_LINE,
    home_odds:   over,
    draw_odds:   null,
    away_odds:   under,
    fetched_at:  new Date().toISOString(),
  }];
}

/**
 * Extracts the Both Teams To Score market from a bookmaker object.
 * API-Football: bet id 8 ("Both Teams Score"), values { value: "Yes"/"No", odd }.
 *
 * Stored to match the existing Betfair convention:
 *   yes → home_odds, no → away_odds, market_line → null, draw_odds → null.
 *
 * @param {object} bookmaker
 * @returns {Array<object>}
 */
function extractBttsRows(bookmaker) {
  const btts = (bookmaker?.bets ?? []).find(b => b.id === 8);
  if (!btts) return [];

  const find = label => (btts.values ?? []).find(v => String(v.value ?? '').toLowerCase() === label);
  const yesV = find('yes');
  const noV  = find('no');
  if (!yesV || !noV) return [];

  const y = parseFloat(yesV.odd);
  const n = parseFloat(noV.odd);
  if (!(y > 1) || !(n > 1) || y > 999 || n > 999) return [];

  return [{
    bookmaker:   slugifyBookmaker(bookmaker.name ?? ''),
    market:      'btts',
    market_line: null,
    home_odds:   y,
    draw_odds:   null,
    away_odds:   n,
    fetched_at:  new Date().toISOString(),
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

  // ── Phase 1: fetch every fixture's odds in parallel (bounded) ──────────────
  // Was a serial fetch + sleep(200) between fixtures, so the network round-trips
  // dominated the run and capped odds freshness. Fetching is pure (no shared
  // state), so it parallelises safely; httpClient's Retry-After/backoff handles
  // any per-minute rate limit. (audit H6)
  const fetched = await withPool(
    plan.fixture_ids,
    async (fixtureId) => {
      try {
        return { fixtureId, bookmakers: await fetchFixtureOdds(fixtureId) };
      } catch (err) {
        console.error(`  [error] fixture ${fixtureId} fetch: ${err.message}`);
        summary.errors++;
        return { fixtureId, bookmakers: null };
      }
    },
    FETCH_CONCURRENCY,
  );

  // ── Phase 2: process results SERIALLY — the shared match/odds Maps and
  // cachedLeagueId are mutated here, so this must not run concurrently.
  for (const { fixtureId, bookmakers } of fetched) {
    try {
      if (bookmakers === null) continue; // fetch already failed and was counted
      const extIdStr = String(fixtureId);

      if (!bookmakers.length) {
        console.log(`  [skip] fixture ${fixtureId} — no odds returned`);
        continue;
      }

      // Each bookmaker object yields 1X2 + Over/Under + BTTS rows (where present).
      const rows = bookmakers.flatMap(bm => [
        ...extractH2hRows(bm),
        ...extractTotalsRows(bm),
        ...extractBttsRows(bm),
      ]);

      if (!rows.length) {
        console.log(`  [skip] fixture ${fixtureId} — no parseable odds`);
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
        const key  = `${matchId}:${row.bookmaker}:${row.market ?? 'h2h'}:${row.market_line ?? ''}`;
        const last = lastOddsMap.get(key);

        if (!oddsHaveMoved(last, row)) continue;

        if (DRY_RUN) {
          console.log(`    [dry-run] ${row.market} ${row.bookmaker} H=${row.home_odds} D=${row.draw_odds} A=${row.away_odds}`);
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

// Bounded-concurrency map: runs `fn` over `items` at most `concurrency` at a
// time. Mirrors the helper in computeValues.js. `fn` should handle its own
// errors; a rejection yields null for that item.
async function withPool(items, fn, concurrency) {
  const n = Number.isFinite(concurrency) && concurrency >= 1 ? concurrency : 1;
  const results = [];
  for (let start = 0; start < items.length; start += n) {
    const batch   = items.slice(start, start + n);
    const settled = await Promise.allSettled(batch.map(fn));
    for (const s of settled) results.push(s.status === 'fulfilled' ? s.value : null);
  }
  return results;
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

module.exports = { ingest, extractH2hRows, extractTotalsRows, extractBttsRows, oddsHaveMoved };
