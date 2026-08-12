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
 * P3-1 fix (12 Aug 2026): the parallel fetch loop (audit H6) fetched
 *   `plan.fixture_ids` — every fixture in the multi-day plan — instead of
 *   `dueIds`, the tiered subset computed just above it and used for logging.
 *   Every run therefore burned its API-Football per-minute budget on ~40-90
 *   fixtures regardless of how many were actually due (sometimes just 1),
 *   which reliably tripped the provider's rate limit and left `oddsInserted`
 *   at 0 for runs in a row — while the job still reported success, because of
 *   the second bug below. Fetching only `dueIds` is the whole point of the
 *   tiered-polling section immediately above; this call had stopped honoring
 *   it silently when the loop was parallelised.
 *
 * P3-2 fix (12 Aug 2026): API-Football returns HTTP 200 with an `errors`
 *   object in the body when a request is rate-limited — it does not use
 *   HTTP 429 for this. httpGetOnce only ever checked the status code, so a
 *   rate-limited call resolved normally with an empty `response` array and
 *   was logged and treated exactly like "this fixture legitimately has no
 *   odds right now": no retry, no error counted, `summary.errors` stayed 0.
 *   That is why the pipeline never threw and the existing `if: failure()`
 *   Slack/Discord alert in engine.yml never fired despite real, sustained
 *   data loss. httpGetOnce now treats a populated `errors` body the same as
 *   a 429 — it goes through the same retry/backoff path, and a still-failing
 *   fetch after retries is counted as a real error and surfaces the way a
 *   DB write failure already does in this file.
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
          let parsed;
          try { parsed = JSON.parse(body); }
          catch (e) { reject(new Error(`JSON parse: ${e.message}`)); return; }
          // API-Football signals rate-limiting inside a 200 OK body (P3-2 fix)
          // rather than via HTTP 429. Route it through the same retry/backoff
          // path as a real 429 instead of resolving as an empty response.
          if (parsed.errors && Object.keys(parsed.errors).length) {
            reject(Object.assign(
              new Error(`API-Football error: ${JSON.stringify(parsed.errors)}`),
              { is429: true },
            ));
            return;
          }
          resolve(parsed);
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
async function advancePlan(supabase, plan, polledIds = []) {
  const nextRunAt  = new Date(Date.now() + plan.interval_minutes * 60 * 1000);
  const nextHour   = nextRunAt.getUTCHours();
  const effectiveEnd = ACTIVE_END_HOUR === 24 ? 0 : ACTIVE_END_HOUR;
  const outsideWindow = ACTIVE_END_HOUR === 24
    ? nextRunAt.getUTCDate() > new Date().getUTCDate()
    : nextHour >= effectiveEnd;

  // Advance the per-fixture schedule for everything we just polled, each by its
  // OWN tier interval. Without this the fixtures stay due forever and the tiering
  // silently collapses back to polling everything every run.
  let scheduleUpdate;
  if (plan.fixture_schedule && polledIds.length) {
    scheduleUpdate = { ...plan.fixture_schedule };
    const nowMs = Date.now();
    for (const id of polledIds) {
      const cur = scheduleUpdate[String(id)];
      if (!cur?.everyMin) continue;
      scheduleUpdate[String(id)] = {
        ...cur,
        nextPollAt: new Date(nowMs + cur.everyMin * 60 * 1000).toISOString(),
      };
    }
  }

  const { error } = await supabase
    .from('engine_plan')
    .update({
      next_run_at:    outsideWindow ? null : nextRunAt.toISOString(),
      runs_completed: plan.runs_completed + 1,
      ...(scheduleUpdate ? { fixture_schedule: scheduleUpdate } : {}),
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

  // ── Tiered polling: only fetch fixtures that are DUE ──────────────────────
  // planDay writes a per-fixture schedule (lib/pollBudget.js): a game in its
  // closing 3h is due every 5 min, one three days out every 12h. Polling only
  // what's due is what makes 40 leagues affordable — previously every fixture
  // was fetched on every run. No schedule (legacy plan) → poll everything.
  const schedule = plan.fixture_schedule ?? null;
  const dueIds = schedule
    ? plan.fixture_ids.filter(id => {
        const s = schedule[String(id)];
        if (!s?.nextPollAt) return true;             // unscheduled → poll
        return new Date(s.nextPollAt).getTime() <= now.getTime();
      })
    : plan.fixture_ids;

  if (schedule && !dueIds.length) {
    console.log(`[ingest] 0 of ${plan.fixture_ids.length} fixture(s) due — advancing schedule only`);
    await advancePlan(supabase, plan);
    return;
  }
  console.log(`[ingest] ${dueIds.length}/${plan.fixture_ids.length} fixture(s) due: ${dueIds.join(', ')}`);

  // ── Bulk prefetch phase (2 queries replace ~50 serial reads) ──────────────

  // Bulk 1: resolve all fixture API IDs → Supabase match UUIDs
  const externalIds = dueIds.map(String);
  const fixtureToMatchId = await prefetchMatchIds(supabase, externalIds);

  // Bulk 2: latest odds per (matchId, bookmaker, market) for all known matches
  const knownMatchIds = [...fixtureToMatchId.values()];
  const lastOddsMap   = await prefetchLastOdds(supabase, knownMatchIds);

  console.log(`[ingest] prefetch: ${fixtureToMatchId.size}/${externalIds.length} matches in DB, ${lastOddsMap.size} last-odds entries loaded`);

  // Cache the league DB id so we only upsert it once per run.

  const summary = { fixtures: dueIds.length, oddsInserted: 0, unresolved: 0, errors: 0 };

  // ── Phase 1: fetch every DUE fixture's odds in parallel (bounded) ─────────
  // Was a serial fetch + sleep(200) between fixtures, so the network round-trips
  // dominated the run and capped odds freshness. Fetching is pure (no shared
  // state), so it parallelises safely; httpClient's Retry-After/backoff handles
  // any per-minute rate limit. (audit H6)
  //
  // P3-1 fix (12 Aug 2026): this iterated `plan.fixture_ids` — the entire
  // multi-day plan — instead of `dueIds` above. Fetch only what's due; that is
  // the entire reason the tiered schedule exists.
  const fetched = await withPool(
    dueIds,
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

  // ── Phase 2: process results SERIALLY — the shared match/odds Maps are
  // mutated here, so this must not run concurrently.
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

      // Resolve match UUID from the pre-fetched Map.
      //
      // We used to MINT a placeholder here when the id didn't resolve — a
      // hardcoded 'FIFA World Cup' league, `team_home_<id>` names and a null
      // kickoff. That made sense when the engine only covered the World Cup and
      // odds could legitimately arrive before the fixture row. It is actively
      // destructive now:
      //
      //   • the placeholder is keyed on the REAL external_id, so the next run
      //     resolves to it and the row never self-heals — odds pile onto a fake
      //     match indefinitely;
      //   • every downstream model is starved. computeModelBoard's mapLeague()
      //     has no pattern for 'FIFA World Cup', and `team_home_1490361` matches
      //     no club in the λ bundle, so the fixture is skipped twice over;
      //   • a null kickoff_at reads as the 1970 epoch, i.e. permanently
      //     "past kickoff", which silently drops the fixture from the board.
      //
      // On 2026-07-30 this minted 111 placeholders in a single day and they
      // absorbed every odds row the pipeline fetched.
      //
      // An unresolvable id now means planDay failed to create the match (its
      // upsertMatches `continue`s on a failed team/league upsert while still
      // listing the id in the plan). The honest response is to skip it loudly so
      // the gap is visible, and let planDay/backfillSeasonFixtures create the row
      // properly on their next pass.
      const matchId = fixtureToMatchId.get(extIdStr);
      if (!matchId) {
        summary.unresolved++;
        console.log(`  [skip] fixture ${fixtureId} — no match row (planDay has not ` +
                    `created it); not minting a placeholder`);
        continue;
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
      // dueIds = exactly what this run polled → each advances by its own tier
      await advancePlan(supabase, plan, dueIds);
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
