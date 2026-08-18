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
    // `kickoff_at` rides along so the caller can drop fixtures that have already
    // started — one extra column on a query we were making anyway.
    .select('id, external_id, kickoff_at')
    .in('external_id', externalIds);
  if (error) throw new Error(`prefetchMatchIds: ${error.message}`);
  return new Map((data ?? []).map(r => [r.external_id, { id: r.id, kickoffAt: r.kickoff_at }]));
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

// ── THE CLOSING FLOOR ────────────────────────────────────────────────────────
//
// Inside this window before kickoff a fixture is polled at least this often,
// WHATEVER TIER IT IS ON.
//
// This exists because fixing the fetch loop is, on its own, a freshness
// REGRESSION. The bug fetched every planned fixture on every run, so polling
// was maximal by accident; polling only what is due drops a fixture on the
// 180-minute 'near' tier to roughly ONE look in its final three hours — and
// that is the window where prices move fastest. Measured over 10 days on the
// bettable panel, price movements recorded per fixture-book:
//
//     T-0 to 2h    1.01   (0.51 / hour)
//     T-2 to 6h    1.09   (0.27 / hour)
//     T-6 to 24h   1.96   (0.11 / hour)
//
// Prices move about five times faster per hour in the closing two hours than a
// day out. Polling that window least often is precisely backwards, and holding
// a price the book has since moved off is the phantom-price condition that
// `price_was_takeable()` measures and the 90% takeability gate fails on. We
// would have reintroduced it with our own fix.
//
// NOTE the 1.01 figure is a count of PRICE MOVES, not of polls — `odds` only
// stores a row when the price moved (`oddsHaveMoved`). It was recorded while
// the buggy fetch was polling that fixture every run, so it says how often the
// market moved, never how often we looked. It cannot be read as evidence that
// any tier interval produces one poll.
//
// Cost is bounded and small: 3 polls per fixture inside two hours is ~300
// requests on a 101-fixture Saturday, against the ~2,570 a day the broken fetch
// was already spending. Net spend still falls sharply.
//
// This is a FLOOR, not a tier. `pollBudget` still owns tier assignment, and
// sizing the closing tier against measured consumption is a separate decision
// that this does not pre-empt.
const CLOSING_FLOOR_WINDOW_MIN = parseFloat(process.env.CLOSING_FLOOR_WINDOW_MIN || '120');
const CLOSING_FLOOR_EVERY_MIN  = parseFloat(process.env.CLOSING_FLOOR_EVERY_MIN  || '40');

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

  // NO EARLY RETURN ON AN EMPTY DUE SET. There used to be one, and it fired
  // BEFORE the closing floor below could look at kickoff times — so on exactly
  // the quiet runs where the floor matters most (nothing due by tier, a fixture
  // 40 minutes from kickoff) it returned without polling. Whether there is work
  // is now decided by `pollIds`, after both rules have had a say.
  console.log(`[ingest] ${dueIds.length}/${plan.fixture_ids.length} fixture(s) due by schedule`);

  // ── Bulk prefetch phase (2 queries replace ~50 serial reads) ──────────────

  // Bulk 1: resolve EVERY planned fixture → UUID + kickoff. All of them, not
  // just the due ones, because the closing floor below has to be able to see a
  // fixture the schedule does not currently consider due.
  const externalIds = plan.fixture_ids.map(String);
  const resolved = await prefetchMatchIds(supabase, externalIds);

  // ── A FIXTURE THAT HAS KICKED OFF IS NOT A PRE-MATCH FIXTURE ─────────────
  //
  // `planDay` builds the day's fixture list ONCE, at 05:00, and `pollBudget`
  // correctly filters to upcoming fixtures at that moment — when everything
  // that day still is. The list is then executed all day against a schedule
  // that only ever asks "is this due?", never "has this started?". So a game
  // that kicked off at 14:00 keeps being polled every tier interval until the
  // active window closes at midnight.
  //
  // Measured over 10 days: 20-23% of EVERY pre-match book's rows were fetched
  // after kickoff — marathonbet 1,376, betfair 1,333, betvictor 1,314, bet365
  // 1,271, pinnacle 921 — against only 7.4-8.9% landing in the two hours
  // before kickoff, which is the window that decides whether a published price
  // is takeable. A fifth of the odds budget was being spent on quotes that are
  // suspended or in-play and worthless to a pre-match product.
  //
  // Nothing downstream wants them. `closing_lines` enforces `quoted_at <=
  // kickoff_at` at the database, `fetchResults` no longer reads
  // `odds_snapshots` at all, and in-play is priced by The Odds API on its own
  // path. The only consumer left was `captureSnapshot`'s 'closing' label,
  // which is the mislabelling that made those snapshots useless in the first
  // place.
  //
  // This is a filter, not a reallocation: the requests are simply not spent,
  // and the tiers can be tightened against the freed budget separately.
  let summaryUnresolved = 0;
  const startedIds = [];
  const fixtureToMatchId = new Map();
  for (const [extId, m] of resolved) {
    if (m.kickoffAt && new Date(m.kickoffAt).getTime() <= now.getTime()) {
      startedIds.push(extId);
      continue;
    }
    fixtureToMatchId.set(extId, m.id);
  }
  if (startedIds.length) {
    console.log(`[ingest] skipping ${startedIds.length} fixture(s) past kickoff — a started game has no pre-match price`);
  }

  // Bulk 2: latest odds per (matchId, bookmaker, market) for all known matches
  const knownMatchIds = [...fixtureToMatchId.values()];
  const lastOddsMap   = await prefetchLastOdds(supabase, knownMatchIds);

  console.log(`[ingest] prefetch: ${fixtureToMatchId.size}/${externalIds.length} matches in DB, ${lastOddsMap.size} last-odds entries loaded`);

  // Cache the league DB id so we only upsert it once per run.

  // ── WHAT THIS RUN ACTUALLY FETCHES ───────────────────────────────────────
  //
  // THE TIERING WAS NOT SAVING A SINGLE REQUEST. `dueIds` was computed above,
  // logged, and used to advance the schedule — and then Phase 1 fetched
  // `plan.fixture_ids`, the WHOLE day's plan, on every run. The block comment
  // fifty lines up says polling only what's due "is what makes 40 leagues
  // affordable"; the loop underneath it did the thing that comment says was
  // replaced, and `summary.fixtures` reported the due count while the run
  // spent requests on everything.
  //
  // That is the real reason the odds feed is thin. The daily budget was being
  // burned on fixtures three days out at the same rate as fixtures in their
  // closing hour, so `pollBudget` had to widen the tiers to fit — today's plan
  // is 64 fixtures ALL on the 180-minute 'near' tier — which is why the last
  // two hours before kickoff get ~1.0 snapshots and the freshest quote on the
  // forward card is over an hour old.
  //
  // Fetch what is due, resolvable, and has not started. Nothing else.
  // Due by schedule, OR inside the closing window and not looked at recently.
  // `nextPollAt - everyMin` is when the fixture was last polled; the schedule
  // stores no explicit timestamp and does not need one.
  const dueSet = new Set(dueIds.map(String));
  const floorIds = [];
  for (const [extId, m] of resolved) {
    if (dueSet.has(extId) || !fixtureToMatchId.has(extId) || !m.kickoffAt) continue;
    const minsToKo = (new Date(m.kickoffAt).getTime() - now.getTime()) / 60000;
    if (minsToKo <= 0 || minsToKo > CLOSING_FLOOR_WINDOW_MIN) continue;
    const sched = schedule?.[extId];
    if (!sched?.nextPollAt || !sched?.everyMin) { floorIds.push(extId); continue; }
    const lastPolledMs = new Date(sched.nextPollAt).getTime() - sched.everyMin * 60000;
    if (now.getTime() - lastPolledMs >= CLOSING_FLOOR_EVERY_MIN * 60000) floorIds.push(extId);
  }
  if (floorIds.length) {
    console.log(`[ingest] closing floor adds ${floorIds.length} fixture(s) inside ` +
                `${CLOSING_FLOOR_WINDOW_MIN}min of kickoff not otherwise due`);
  }

  const pollIds = [...new Set([...dueIds.map(String), ...floorIds])]
    .filter(id => fixtureToMatchId.has(id));
  const unresolvedCount = externalIds.length - resolved.size;
  if (unresolvedCount > 0) {
    // Loud, per the ruling above: an unresolvable id means planDay failed to
    // create the match, and the gap should be visible rather than absorbed.
    console.log(`[ingest] ${unresolvedCount} fixture(s) have no match row — planDay has not created them`);
    summaryUnresolved = unresolvedCount;
  }
  if (!pollIds.length) {
    console.log(`[ingest] nothing to poll — advancing schedule only`);
    await advancePlan(supabase, plan);
    return;
  }
  console.log(`[ingest] fetching ${pollIds.length} of ${plan.fixture_ids.length} planned fixture(s)`);

  const summary = { fixtures: pollIds.length, oddsInserted: 0, unresolved: summaryUnresolved, errors: 0 };

  // ── Phase 1: fetch every fixture's odds in parallel (bounded) ──────────────
  // Was a serial fetch + sleep(200) between fixtures, so the network round-trips
  // dominated the run and capped odds freshness. Fetching is pure (no shared
  // state), so it parallelises safely; httpClient's Retry-After/backoff handles
  // any per-minute rate limit. (audit H6)
  const fetched = await withPool(
    pollIds,
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
      // pollIds = exactly what this run polled → each advances by its own tier.
      // It was `dueIds`, which left every closing-floor fixture un-advanced and
      // therefore due again on the very next run.
      await advancePlan(supabase, plan, pollIds);
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
