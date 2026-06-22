/**
 * EVE — Odds Ingestion Script
 *
 * Fetches live 1X2 odds from API-Football (RapidAPI) and writes them into Supabase.
 * Also upserts match and team records so the DB stays in sync with the feed.
 *
 * Execution flow:
 *   1. For each league, fetch upcoming fixtures from API-Football /fixtures
 *   2. Fetch odds for the league from /odds, paginating as needed
 *   3. Join odds to fixtures by fixture ID
 *   4. Upsert leagues → teams → matches (in dependency order)
 *   5. Insert new odds rows (append-only — never overwrites history)
 *
 * Idempotent: safe to run multiple times. Duplicate odds rows are prevented
 * by only inserting when odds have changed from the last snapshot.
 *
 * Usage:
 *   node ingestOdds.js              — run once
 *   node ingestOdds.js --dry-run    — fetch and log without writing to DB
 */

'use strict';

const https            = require('https');
const { createClient } = require('@supabase/supabase-js');

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

const RAPIDAPI_KEY = process.env.RAPIDAPI_KEY;
const RAPIDAPI_HOST = 'api-football-v1.p.rapidapi.com';

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const DRY_RUN      = process.argv.includes('--dry-run');

// Season year (the year the season starts — e.g. 2025 for 2025-26).
// Override with FOOTBALL_SEASON env var if needed.
const SEASON = parseInt(process.env.FOOTBALL_SEASON ?? new Date().getFullYear(), 10);

// Leagues: API-Football league IDs.
// Full list: https://www.api-football.com/documentation-v3#tag/Leagues
const LEAGUES = [
  { id: 39, name: 'Premier League',   country: 'England' },
  { id: 40, name: 'EFL Championship', country: 'England' },
];

// API-Football bet type IDs.
const BET_MATCH_WINNER = 1;   // 1X2
const BET_OVER_UNDER   = 5;   // Goals Over/Under
const BET_BTTS         = 8;   // Both Teams To Score

// Only insert a new odds row if price has moved by more than this amount.
const MIN_PRICE_MOVEMENT = 0.01;

// ---------------------------------------------------------------------------
// Supabase
// ---------------------------------------------------------------------------

function getSupabase() {
  if (!SUPABASE_URL || !SUPABASE_KEY) {
    throw new Error('Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY');
  }
  return createClient(SUPABASE_URL, SUPABASE_KEY);
}

// ---------------------------------------------------------------------------
// HTTP helper — RapidAPI requires headers, not a query param
// ---------------------------------------------------------------------------

function httpGet(path) {
  if (!RAPIDAPI_KEY) throw new Error('RAPIDAPI_KEY environment variable is not set');

  const url = `https://${RAPIDAPI_HOST}/v3${path}`;

  return new Promise((resolve, reject) => {
    const options = {
      method: 'GET',
      hostname: RAPIDAPI_HOST,
      path: `/v3${path}`,
      headers: {
        'x-rapidapi-key':  RAPIDAPI_KEY,
        'x-rapidapi-host': RAPIDAPI_HOST,
      },
    };

    https.request(options, (res) => {
      let body = '';
      res.on('data', chunk => { body += chunk; });
      res.on('end', () => {
        if (res.statusCode === 429) {
          reject(new Error('API-Football rate limit hit — too many requests'));
          return;
        }
        if (res.statusCode === 401 || res.statusCode === 403) {
          reject(new Error('RAPIDAPI_KEY is invalid or missing subscription'));
          return;
        }
        if (res.statusCode !== 200) {
          reject(new Error(`HTTP ${res.statusCode}: ${body.slice(0, 200)}`));
          return;
        }
        try {
          const parsed = JSON.parse(body);
          // API-Football surfaces errors in the response body
          if (parsed.errors && Object.keys(parsed.errors).length > 0) {
            reject(new Error(`API error: ${JSON.stringify(parsed.errors)}`));
            return;
          }
          resolve(parsed);
        } catch (e) {
          reject(new Error(`JSON parse error: ${e.message}`));
        }
      });
    }).on('error', reject).end();
  });
}

// ---------------------------------------------------------------------------
// 1. Fetch fixtures (team names + kickoff times)
// ---------------------------------------------------------------------------

/**
 * Fetches upcoming fixtures for a league.
 * Returns a Map of fixtureId → { homeTeam, awayTeam, kickoffAt }.
 */
async function fetchFixturesForLeague(leagueId) {
  // next=100 returns the next 100 upcoming fixtures; also grab in-progress
  const path = `/fixtures?league=${leagueId}&season=${SEASON}&next=100`;
  console.log(`  [fixtures] GET ${path}`);
  const json = await httpGet(path);

  const map = new Map();
  for (const item of (json.response ?? [])) {
    map.set(item.fixture.id, {
      homeTeam:  item.teams.home.name,
      awayTeam:  item.teams.away.name,
      kickoffAt: item.fixture.date,
    });
  }
  console.log(`  → ${map.size} upcoming fixtures`);
  return map;
}

// ---------------------------------------------------------------------------
// 2. Fetch odds (paginated)
// ---------------------------------------------------------------------------

/**
 * Fetches all odds pages for a league + bet type.
 * Returns array of raw API response items.
 */
async function fetchOddsPages(leagueId, betId) {
  const all = [];
  let page = 1;

  while (true) {
    const path = `/odds?league=${leagueId}&season=${SEASON}&bet=${betId}&page=${page}`;
    console.log(`  [odds] GET ${path}`);
    const json = await httpGet(path);
    const items = json.response ?? [];
    all.push(...items);

    const { current, total } = json.paging ?? { current: 1, total: 1 };
    if (current >= total) break;
    page++;
    await sleep(300); // respect rate limit between pages
  }

  console.log(`  → ${all.length} odds records`);
  return all;
}

// ---------------------------------------------------------------------------
// 3. Normalise API-Football response → our DB shape
// ---------------------------------------------------------------------------

/**
 * API-Football odds item shape:
 * {
 *   fixture: { id: 868077 },
 *   bookmakers: [
 *     {
 *       id: 8,
 *       name: "Bet365",
 *       bets: [
 *         {
 *           id: 1,
 *           name: "Match Winner",
 *           values: [
 *             { value: "Home", odd: "1.83" },
 *             { value: "Draw", odd: "3.75" },
 *             { value: "Away", odd: "4.20" }
 *           ]
 *         }
 *       ]
 *     }
 *   ]
 * }
 */

/**
 * Normalise bookmaker name to a consistent slug.
 * e.g. "Bet365" → "bet365", "William Hill" → "williamhill"
 */
function slugifyBookmaker(name) {
  const overrides = {
    'Bet365':          'bet365',
    'William Hill':    'williamhill',
    'Ladbrokes':       'ladbrokes_uk',
    'Coral':           'coral',
    'Paddy Power':     'paddypower',
    'Betfair':         'betfair_sb_uk',
    'Betfair Exchange':'betfair_ex_uk',
    'Betway':          'betway',
    'Unibet':          'unibet_uk',
    'SkyBet':          'skybet',
    'Sky Bet':         'skybet',
    'Betfred':         'betfred_uk',
    'BetVictor':       'betvictor',
    'Boylesports':     'boylesports',
    'BoyleSports':     'boylesports',
    'Virgin Bet':      'virginbet',
    '888sport':        'sport888',
    'Smarkets':        'smarkets',
    'Matchbook':       'matchbook',
  };
  return overrides[name] ?? name.toLowerCase().replace(/\s+/g, '_').replace(/[^a-z0-9_]/g, '');
}

/**
 * Extract 1X2 odds rows from a single API-Football odds item.
 */
function normaliseH2hItem(item, fixtureMap) {
  const fixtureId = item.fixture?.id;
  const fixture   = fixtureMap.get(fixtureId);
  if (!fixture) return null; // fixture not in our upcoming window

  const oddsRows = [];

  for (const bm of (item.bookmakers ?? [])) {
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

    oddsRows.push({
      bookmaker:  slugifyBookmaker(bm.name),
      market:     'h2h',
      home_odds:  h,
      draw_odds:  d,
      away_odds:  a,
      fetched_at: new Date().toISOString(),
    });
  }

  return {
    externalId: String(fixtureId),
    ...fixture,
    oddsRows,
  };
}

/**
 * Extract Over/Under odds rows from a single API-Football odds item.
 */
function normaliseTotalsItem(item) {
  const fixtureId = item.fixture?.id;
  const oddsRows  = [];

  for (const bm of (item.bookmakers ?? [])) {
    const totalsBet = bm.bets?.find(b => b.id === BET_OVER_UNDER);
    if (!totalsBet) continue;

    // API-Football returns multiple lines (e.g. Over 2.5, Over 3.5)
    // Group by line — pick the 2.5 line if available, else first
    const lines = new Map();
    for (const v of (totalsBet.values ?? [])) {
      // value format: "Over 2.5" or "Under 2.5"
      const match = v.value.match(/^(Over|Under)\s+([\d.]+)$/);
      if (!match) continue;
      const [, side, lineStr] = match;
      const line = parseFloat(lineStr);
      if (!lines.has(line)) lines.set(line, {});
      lines.get(line)[side] = parseFloat(v.odd);
    }

    // Prefer 2.5 line; fall back to first available
    const targetLine = lines.has(2.5) ? 2.5 : [...lines.keys()][0];
    if (targetLine == null) continue;

    const { Over: overPrice, Under: underPrice } = lines.get(targetLine);
    if (!overPrice || !underPrice || overPrice <= 1 || underPrice <= 1) continue;

    oddsRows.push({
      bookmaker:   slugifyBookmaker(bm.name),
      market:      'totals',
      home_odds:   overPrice,
      draw_odds:   null,
      away_odds:   underPrice,
      market_line: targetLine,
      fetched_at:  new Date().toISOString(),
    });
  }

  return { externalId: String(fixtureId), oddsRows };
}

/**
 * Extract BTTS odds rows from a single API-Football odds item.
 */
function normaliseBttsItem(item) {
  const fixtureId = item.fixture?.id;
  const oddsRows  = [];

  for (const bm of (item.bookmakers ?? [])) {
    const bttsBet = bm.bets?.find(b => b.id === BET_BTTS);
    if (!bttsBet) continue;

    const yesVal = bttsBet.values?.find(v => v.value === 'Yes');
    const noVal  = bttsBet.values?.find(v => v.value === 'No');
    if (!yesVal || !noVal) continue;

    const yesPrice = parseFloat(yesVal.odd);
    const noPrice  = parseFloat(noVal.odd);
    if (yesPrice <= 1 || noPrice <= 1) continue;

    oddsRows.push({
      bookmaker:   slugifyBookmaker(bm.name),
      market:      'btts',
      home_odds:   yesPrice,
      draw_odds:   null,
      away_odds:   noPrice,
      market_line: null,
      fetched_at:  new Date().toISOString(),
    });
  }

  return { externalId: String(fixtureId), oddsRows };
}

// ---------------------------------------------------------------------------
// 4. Upsert reference data (leagues, teams, matches) — unchanged from before
// ---------------------------------------------------------------------------

async function upsertLeague(supabase, { name, country }) {
  const { data, error } = await supabase
    .from('leagues')
    .upsert({ name, country }, { onConflict: 'name' })
    .select('id')
    .single();
  if (error) throw new Error(`upsertLeague(${name}): ${error.message}`);
  return data.id;
}

async function upsertTeam(supabase, name) {
  const { data, error } = await supabase
    .from('teams')
    .upsert({ name, short_name: makeShortName(name) }, { onConflict: 'name' })
    .select('id')
    .single();
  if (error) throw new Error(`upsertTeam(${name}): ${error.message}`);
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
      { onConflict: 'external_id' }
    )
    .select('id')
    .single();
  if (error) throw new Error(`upsertMatch(${externalId}): ${error.message}`);
  return data.id;
}

// ---------------------------------------------------------------------------
// 5. Insert odds (append-only, deduped by price movement) — unchanged
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

function oddsHaveMoved(lastOdds, newRow) {
  if (!lastOdds) return true;
  const homeMove = Math.abs((newRow.home_odds ?? 0) - (lastOdds.home_odds ?? 0));
  const awayMove = Math.abs((newRow.away_odds ?? 0) - (lastOdds.away_odds ?? 0));
  const drawMove = (newRow.draw_odds != null && lastOdds.draw_odds != null)
    ? Math.abs(newRow.draw_odds - lastOdds.draw_odds)
    : 0;
  return homeMove > MIN_PRICE_MOVEMENT || awayMove > MIN_PRICE_MOVEMENT || drawMove > MIN_PRICE_MOVEMENT;
}

async function insertOddsForMatch(supabase, matchId, oddsRows) {
  let inserted = 0;
  for (const row of oddsRows) {
    const market = row.market ?? 'h2h';
    const last   = await getLastOdds(supabase, matchId, row.bookmaker, market);
    if (!oddsHaveMoved(last, row)) continue;

    if (DRY_RUN) {
      console.log(`    [dry-run] ${market}: ${row.bookmaker} H=${row.home_odds} D=${row.draw_odds ?? '—'} A=${row.away_odds}`);
      inserted++;
      continue;
    }

    const { error } = await supabase.from('odds').insert({ match_id: matchId, ...row });
    if (error) {
      console.warn(`    [warn] odds insert failed (${row.bookmaker} ${market}): ${error.message}`);
    } else {
      inserted++;
    }
  }
  return inserted;
}

// ---------------------------------------------------------------------------
// 6. Main ingestion loop
// ---------------------------------------------------------------------------

async function ingest() {
  console.log(`\n[ingest] starting ${DRY_RUN ? '(DRY RUN) ' : ''}at ${new Date().toISOString()} — season ${SEASON}`);

  const supabase = getSupabase();
  const summary  = { leagues: 0, events: 0, oddsInserted: 0, errors: 0 };

  for (const league of LEAGUES) {
    console.log(`\n[league] ${league.name} (id=${league.id})`);

    // ── Step 1: fixtures ────────────────────────────────────────────────────
    let fixtureMap;
    try {
      fixtureMap = await fetchFixturesForLeague(league.id);
    } catch (err) {
      console.error(`  [error] fixtures fetch failed: ${err.message}`);
      summary.errors++;
      continue;
    }

    if (fixtureMap.size === 0) {
      console.log('  no upcoming fixtures — skipping');
      continue;
    }

    // ── Step 2: 1X2 odds ───────────────────────────────────────────────────
    let h2hItems = [];
    try {
      h2hItems = await fetchOddsPages(league.id, BET_MATCH_WINNER);
    } catch (err) {
      console.error(`  [error] h2h odds fetch failed: ${err.message}`);
      summary.errors++;
    }

    // Upsert league
    let leagueId;
    try {
      leagueId = DRY_RUN ? 'dry-run-league-id' : await upsertLeague(supabase, league);
    } catch (err) {
      console.error(`  [error] league upsert failed: ${err.message}`);
      summary.errors++;
      continue;
    }

    // Process h2h items
    for (const item of h2hItems) {
      const norm = normaliseH2hItem(item, fixtureMap);
      if (!norm || !norm.oddsRows.length) continue;

      console.log(`  ${norm.homeTeam} vs ${norm.awayTeam} (${norm.oddsRows.length} books)`);

      try {
        const homeTeamId = DRY_RUN ? 'dry-id' : await upsertTeam(supabase, norm.homeTeam);
        const awayTeamId = DRY_RUN ? 'dry-id' : await upsertTeam(supabase, norm.awayTeam);
        const matchId    = DRY_RUN ? 'dry-match-id' : await upsertMatch(supabase, {
          externalId:  norm.externalId,
          homeTeamId,
          awayTeamId,
          leagueId,
          kickoffAt:   norm.kickoffAt,
        });

        const inserted = await insertOddsForMatch(supabase, matchId, norm.oddsRows);
        summary.oddsInserted += inserted;
        summary.events++;
      } catch (err) {
        console.error(`    [error] ${norm.homeTeam} vs ${norm.awayTeam}: ${err.message}`);
        summary.errors++;
      }
    }

    await sleep(500); // pause between h2h and over/under fetches

    // ── Step 3: Over/Under odds ────────────────────────────────────────────
    console.log(`\n[totals] ${league.name}`);
    let totalsItems = [];
    try {
      totalsItems = await fetchOddsPages(league.id, BET_OVER_UNDER);
    } catch (err) {
      console.warn(`  [warn] totals fetch failed: ${err.message}`);
    }

    for (const item of totalsItems) {
      const norm = normaliseTotalsItem(item);
      if (!norm.oddsRows.length) continue;

      try {
        if (!DRY_RUN) {
          const { data: matchRow, error } = await supabase
            .from('matches')
            .select('id')
            .eq('external_id', norm.externalId)
            .maybeSingle();
          if (error || !matchRow) continue;
          const inserted = await insertOddsForMatch(supabase, matchRow.id, norm.oddsRows);
          summary.oddsInserted += inserted;
        } else {
          console.log(`  [dry-run] totals for fixture ${norm.externalId}: ${norm.oddsRows.length} rows`);
        }
      } catch (err) {
        console.error(`    [error] totals ${norm.externalId}: ${err.message}`);
        summary.errors++;
      }
    }

    await sleep(500);

    // ── Step 4: BTTS odds ──────────────────────────────────────────────────
    console.log(`\n[btts] ${league.name}`);
    let bttsItems = [];
    try {
      bttsItems = await fetchOddsPages(league.id, BET_BTTS);
    } catch (err) {
      console.warn(`  [warn] btts fetch failed: ${err.message}`);
    }

    for (const item of bttsItems) {
      const norm = normaliseBttsItem(item);
      if (!norm.oddsRows.length) continue;

      try {
        if (!DRY_RUN) {
          const { data: matchRow, error } = await supabase
            .from('matches')
            .select('id')
            .eq('external_id', norm.externalId)
            .maybeSingle();
          if (error || !matchRow) continue;
          const inserted = await insertOddsForMatch(supabase, matchRow.id, norm.oddsRows);
          summary.oddsInserted += inserted;
        } else {
          console.log(`  [dry-run] btts for fixture ${norm.externalId}: ${norm.oddsRows.length} rows`);
        }
      } catch (err) {
        console.error(`    [error] btts ${norm.externalId}: ${err.message}`);
        summary.errors++;
      }
    }

    summary.leagues++;
    await sleep(500);
  }

  console.log('\n[ingest] complete:', summary);
  return summary;
}

// ---------------------------------------------------------------------------
// Utilities
// ---------------------------------------------------------------------------

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function makeShortName(name) {
  const overrides = {
    'Manchester City':          'Man City',
    'Manchester United':        'Man Utd',
    'Tottenham Hotspur':        'Spurs',
    'Newcastle United':         'Newcastle',
    'Nottingham Forest':        'Nottm Forest',
    'West Ham United':          'West Ham',
    'Wolverhampton Wanderers':  'Wolves',
    'Brighton & Hove Albion':   'Brighton',
    'Sheffield United':         'Sheffield Utd',
    'Sheffield Wednesday':      'Sheff Wed',
    'Queens Park Rangers':      'QPR',
    'Stoke City':               'Stoke',
    'Blackburn Rovers':         'Blackburn',
    'Swansea City':             'Swansea',
    'Cardiff City':             'Cardiff',
    'Preston North End':        'Preston',
    'Coventry City':            'Coventry',
    'Bristol City':             'Bristol C',
    'Bayer 04 Leverkusen':      'Leverkusen',
    'Borussia Dortmund':        'Dortmund',
    'Paris Saint-Germain':      'PSG',
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

module.exports = { ingest, normaliseH2hItem, oddsHaveMoved };
