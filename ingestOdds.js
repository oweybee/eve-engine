/**
 * EVE — Odds Ingestion Script
 *
 * Fetches live 1X2 odds from The Odds API and writes them into Supabase.
 * Also upserts match and team records so the DB stays in sync with the feed.
 *
 * Execution flow:
 *   1. Fetch odds for each configured league from The Odds API
 *   2. Upsert leagues → teams → matches (in dependency order)
 *   3. Insert new odds rows (append-only — never overwrites history)
 *   4. Log a usage summary (API requests are metered on free tier)
 *
 * Idempotent: safe to run multiple times. Duplicate odds rows are prevented
 * by only inserting when odds have changed from the last snapshot.
 *
 * Usage:
 *   node ingestOdds.js              — run once
 *   node ingestOdds.js --dry-run    — fetch and log without writing to DB
 */

'use strict';

const https        = require('https');
const { createClient } = require('@supabase/supabase-js');

// ---------------------------------------------------------------------------
// Config — all values from environment variables
// ---------------------------------------------------------------------------

const ODDS_API_KEY   = process.env.ODDS_API_KEY;       // from theoddsapi.com
const SUPABASE_URL   = process.env.SUPABASE_URL;
const SUPABASE_KEY   = process.env.SUPABASE_SERVICE_ROLE_KEY;
const DRY_RUN        = process.argv.includes('--dry-run');

// Leagues to ingest. These are The Odds API sport keys.
// Full list: https://the-odds-api.com/sports-odds-data/sports-apis.html
const LEAGUES = [
  { sportKey: 'soccer_fifa_world_cup',             name: 'FIFA World Cup',    country: 'International' },
  { sportKey: 'soccer_conmebol_copa_libertadores', name: 'Copa Libertadores', country: 'South America' },
  { sportKey: 'soccer_norway_eliteserien',         name: 'Eliteserien',       country: 'Norway'        },
  { sportKey: 'soccer_sweden_allsvenskan',         name: 'Allsvenskan',       country: 'Sweden'        },
  { sportKey: 'soccer_brazil_serie_b',             name: 'Brazil Serie B',    country: 'Brazil'        },
];

// Bookmakers to request. The Odds API returns all available by default,
// but explicitly listing the main ones keeps response size predictable.
// Full list: https://the-odds-api.com/sports-odds-data/bookmakers.html
const BOOKMAKERS = [
  // Exchanges — sharp baseline
  'betfair_ex_uk',
  'smarkets',
  'matchbook',
  // UK soft books
  'bet365',
  'skybet',
  'williamhill',
  'paddypower',
  'coral',
  'ladbrokes_uk',
  'betfred_uk',
  'betway',
  'betvictor',
  'boylesports',
  'betfair_sb_uk',
  'unibet_uk',
  'virginbet',
  'sport888',
].join(',');

// Only insert a new odds row if price has moved by more than this amount.
// Prevents flooding the table with duplicate rows on unchanged prices.
const MIN_PRICE_MOVEMENT = 0.01;

// ---------------------------------------------------------------------------
// Supabase client
// ---------------------------------------------------------------------------

function getSupabase() {
  if (!SUPABASE_URL || !SUPABASE_KEY) {
    throw new Error('Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY');
  }
  return createClient(SUPABASE_URL, SUPABASE_KEY);
}

// ---------------------------------------------------------------------------
// HTTP helper — wraps Node https in a promise
// ---------------------------------------------------------------------------

function httpGet(url) {
  return new Promise((resolve, reject) => {
    https.get(url, (res) => {
      let body = '';
      res.on('data', chunk => { body += chunk; });
      res.on('end', () => {
        if (res.statusCode === 401) {
          reject(new Error('ODDS_API_KEY is invalid or missing'));
          return;
        }
        if (res.statusCode === 422) {
          reject(new Error('Sport key not found or not active on your plan'));
          return;
        }
        if (res.statusCode !== 200) {
          reject(new Error(`HTTP ${res.statusCode}: ${body}`));
          return;
        }
        // Expose remaining quota from response headers
        const remaining = res.headers['x-requests-remaining'];
        const used      = res.headers['x-requests-used'];
        if (remaining !== undefined) {
          console.log(`  [quota] used=${used} remaining=${remaining}`);
        }
        try {
          resolve(JSON.parse(body));
        } catch (e) {
          reject(new Error(`JSON parse error: ${e.message}`));
        }
      });
    }).on('error', reject);
  });
}

// ---------------------------------------------------------------------------
// 1. Fetch odds from The Odds API
// ---------------------------------------------------------------------------

/**
 * Fetches 1X2 (h2h) odds for a single sport/league.
 * Returns the raw API response array.
 *
 * API docs: https://the-odds-api.com/liveapi/guides/v4/#get-odds
 */
async function fetchOddsForLeague(sportKey) {
  if (!ODDS_API_KEY) throw new Error('ODDS_API_KEY environment variable is not set');

  const url = [
    `https://api.the-odds-api.com/v4/sports/${sportKey}/odds`,
    `?apiKey=${ODDS_API_KEY}`,
    `&regions=uk`,           // UK region for UK bookmakers
    `&markets=h2h`,          // head-to-head = 1X2 match result
    `&oddsFormat=decimal`,
    `&bookmakers=${BOOKMAKERS}`,
  ].join('');

  console.log(`  Fetching ${sportKey}...`);
  const data = await httpGet(url);
  console.log(`  → ${data.length} events returned`);
  return data;
}

/**
 * Fetches over/under (totals) odds for a single sport/league.
 */
async function fetchTotalsForLeague(sportKey) {
  if (!ODDS_API_KEY) throw new Error('ODDS_API_KEY environment variable is not set');

  const url = [
    `https://api.the-odds-api.com/v4/sports/${sportKey}/odds`,
    `?apiKey=${ODDS_API_KEY}`,
    `&regions=uk`,
    `&markets=totals`,
    `&oddsFormat=decimal`,
    `&bookmakers=${BOOKMAKERS}`,
  ].join('');

  console.log(`  Fetching totals for ${sportKey}...`);
  const data = await httpGet(url);
  console.log(`  → ${data.length} totals events returned`);
  return data;
}

// ---------------------------------------------------------------------------
// 2. Normalise API response → our DB shape
// ---------------------------------------------------------------------------

/**
 * The Odds API event shape (simplified):
 * {
 *   id: "abc123",
 *   sport_key: "soccer_epl",
 *   home_team: "Arsenal",
 *   away_team: "Chelsea",
 *   commence_time: "2024-06-12T19:45:00Z",
 *   bookmakers: [
 *     {
 *       key: "bet365",
 *       markets: [
 *         {
 *           key: "h2h",
 *           outcomes: [
 *             { name: "Arsenal", price: 2.10 },
 *             { name: "Chelsea", price: 3.50 },
 *             { name: "Draw",    price: 3.20 }
 *           ]
 *         }
 *       ]
 *     }
 *   ]
 * }
 */
function normaliseEvent(event, leagueName) {
  const { id, home_team, away_team, commence_time, bookmakers } = event;

  // Extract odds per bookmaker
  const oddsRows = [];

  for (const bm of (bookmakers ?? [])) {
    const h2h = bm.markets?.find(m => m.key === 'h2h');
    if (!h2h) continue;

    const outcomes = h2h.outcomes ?? [];

    // Map outcome names to home/draw/away
    // The Odds API returns team names for win outcomes and "Draw" for the draw
    const homeOutcome = outcomes.find(o => o.name === home_team);
    const awayOutcome = outcomes.find(o => o.name === away_team);
    const drawOutcome = outcomes.find(o => o.name === 'Draw');

    if (!homeOutcome || !awayOutcome || !drawOutcome) continue;

    // Validate odds are sensible (> 1.0, < 1000)
    const h = parseFloat(homeOutcome.price);
    const d = parseFloat(drawOutcome.price);
    const a = parseFloat(awayOutcome.price);

    if (h <= 1 || d <= 1 || a <= 1) continue;
    if (h > 999 || d > 999 || a > 999) continue;

    oddsRows.push({
      bookmaker:  bm.key,
      market:     'h2h',
      home_odds:  h,
      draw_odds:  d,
      away_odds:  a,
      fetched_at: new Date().toISOString(),
    });
  }

  return {
    externalId:  id,
    homeTeam:    home_team,
    awayTeam:    away_team,
    kickoffAt:   commence_time,
    leagueName,
    oddsRows,
  };
}

/**
 * Fetches Both Teams to Score (btts) odds for a single sport/league.
 */
async function fetchBttsForLeague(sportKey) {
  if (!ODDS_API_KEY) throw new Error('ODDS_API_KEY environment variable is not set');

  const url = [
    `https://api.the-odds-api.com/v4/sports/${sportKey}/odds`,
    `?apiKey=${ODDS_API_KEY}`,
    `&regions=uk`,
    `&markets=btts`,
    `&oddsFormat=decimal`,
    `&bookmakers=${BOOKMAKERS}`,
  ].join('');

  console.log(`  Fetching btts for ${sportKey}...`);
  const data = await httpGet(url);
  console.log(`  → ${data.length} btts events returned`);
  return data;
}

/**
 * Normalises a BTTS API event into Yes/No odds rows.
 * Uses home_odds for Yes price, away_odds for No price, draw_odds null.
 */
function normaliseBttsEvent(event) {
  const { id, bookmakers } = event;
  const oddsRows = [];

  for (const bm of (bookmakers ?? [])) {
    const btts = bm.markets?.find(m => m.key === 'btts');
    if (!btts) continue;

    const outcomes = btts.outcomes ?? [];
    const yesOutcome = outcomes.find(o => o.name === 'Yes');
    const noOutcome  = outcomes.find(o => o.name === 'No');
    if (!yesOutcome || !noOutcome) continue;

    const yesPrice = parseFloat(yesOutcome.price);
    const noPrice  = parseFloat(noOutcome.price);
    if (yesPrice <= 1 || noPrice <= 1) continue;

    oddsRows.push({
      bookmaker:   bm.key,
      market:      'btts',
      home_odds:   yesPrice,   // Yes stored as home_odds
      draw_odds:   null,
      away_odds:   noPrice,    // No stored as away_odds
      market_line: null,
      fetched_at:  new Date().toISOString(),
    });
  }

  return { externalId: id, oddsRows };
}

/**
 * Normalises a totals API event into Over/Under odds rows.
 * Uses home_odds for Over price, away_odds for Under price, draw_odds null.
 */
function normaliseTotalsEvent(event) {
  const { id, bookmakers } = event;
  const oddsRows = [];

  for (const bm of (bookmakers ?? [])) {
    const totals = bm.markets?.find(m => m.key === 'totals');
    if (!totals) continue;

    const outcomes = totals.outcomes ?? [];
    const overOutcome  = outcomes.find(o => o.name === 'Over');
    const underOutcome = outcomes.find(o => o.name === 'Under');
    if (!overOutcome || !underOutcome) continue;

    const overPrice  = parseFloat(overOutcome.price);
    const underPrice = parseFloat(underOutcome.price);
    const line       = parseFloat(overOutcome.point ?? underOutcome.point ?? 0);

    if (overPrice <= 1 || underPrice <= 1) continue;

    oddsRows.push({
      bookmaker:   bm.key,
      market:      'totals',
      home_odds:   overPrice,   // Over stored as home_odds
      draw_odds:   null,
      away_odds:   underPrice,  // Under stored as away_odds
      market_line: line,
      fetched_at:  new Date().toISOString(),
    });
  }

  return { externalId: id, oddsRows };
}

// ---------------------------------------------------------------------------
// 3. Upsert reference data (leagues, teams, matches)
// ---------------------------------------------------------------------------

/**
 * Upserts a league row and returns its UUID.
 * Uses name as the unique key.
 */
async function upsertLeague(supabase, { name, country }) {
  const { data, error } = await supabase
    .from('leagues')
    .upsert({ name, country }, { onConflict: 'name' })
    .select('id')
    .single();

  if (error) throw new Error(`upsertLeague(${name}): ${error.message}`);
  return data.id;
}

/**
 * Upserts a team row and returns its UUID.
 * Uses name as the unique key — requires a unique constraint on teams(name).
 */
async function upsertTeam(supabase, name) {
  const { data, error } = await supabase
    .from('teams')
    .upsert({ name, short_name: makeShortName(name) }, { onConflict: 'name' })
    .select('id')
    .single();

  if (error) throw new Error(`upsertTeam(${name}): ${error.message}`);
  return data.id;
}

/**
 * Upserts a match row and returns its UUID.
 * Uses external_id (The Odds API event id) as the unique key.
 * Requires an external_id column on matches — see migration note below.
 */
async function upsertMatch(supabase, { externalId, homeTeamId, awayTeamId, leagueId, kickoffAt }) {
  const { data, error } = await supabase
    .from('matches')
    .upsert(
      {
        external_id:   externalId,
        home_team_id:  homeTeamId,
        away_team_id:  awayTeamId,
        league_id:     leagueId,
        kickoff_at:    kickoffAt,
        status:        'scheduled',
      },
      { onConflict: 'external_id' }
    )
    .select('id')
    .single();

  if (error) throw new Error(`upsertMatch(${externalId}): ${error.message}`);
  return data.id;
}

// ---------------------------------------------------------------------------
// 4. Insert odds (append-only, deduped by price movement)
// ---------------------------------------------------------------------------

/**
 * Fetches the most recent odds row for this match+bookmaker+market combination.
 */
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

/**
 * Returns true if the new odds differ from the last stored odds
 * by more than MIN_PRICE_MOVEMENT on any outcome.
 */
function oddsHaveMoved(lastOdds, newRow) {
  if (!lastOdds) return true;
  const homeMove = Math.abs((newRow.home_odds ?? 0) - (lastOdds.home_odds ?? 0));
  const awayMove = Math.abs((newRow.away_odds ?? 0) - (lastOdds.away_odds ?? 0));
  // draw_odds is null for totals, skip if both are null
  const drawMove = (newRow.draw_odds != null && lastOdds.draw_odds != null)
    ? Math.abs(newRow.draw_odds - lastOdds.draw_odds)
    : 0;
  return homeMove > MIN_PRICE_MOVEMENT || awayMove > MIN_PRICE_MOVEMENT || drawMove > MIN_PRICE_MOVEMENT;
}

/**
 * Inserts odds rows for all bookmakers for a single match.
 * Only inserts rows where prices have actually moved.
 * Returns count of rows inserted.
 */
async function insertOddsForMatch(supabase, matchId, oddsRows) {
  let inserted = 0;

  for (const row of oddsRows) {
    const market = row.market ?? 'h2h';
    const last   = await getLastOdds(supabase, matchId, row.bookmaker, market);

    if (!oddsHaveMoved(last, row)) continue;

    if (DRY_RUN) {
      if (market === 'totals') {
        console.log(`    [dry-run] totals: ${row.bookmaker} O=${row.home_odds} U=${row.away_odds} line=${row.market_line}`);
      } else {
        console.log(`    [dry-run] h2h: ${row.bookmaker} H=${row.home_odds} D=${row.draw_odds} A=${row.away_odds}`);
      }
      inserted++;
      continue;
    }

    const { error } = await supabase
      .from('odds')
      .insert({ match_id: matchId, ...row });

    if (error) {
      console.warn(`    [warn] odds insert failed (${row.bookmaker} ${market}): ${error.message}`);
    } else {
      inserted++;
    }
  }

  return inserted;
}

// ---------------------------------------------------------------------------
// 5. Main ingestion loop
// ---------------------------------------------------------------------------

async function ingest() {
  console.log(`\n[ingest] starting ${DRY_RUN ? '(DRY RUN) ' : ''}at ${new Date().toISOString()}`);

  const supabase = getSupabase();
  const summary  = { leagues: 0, events: 0, oddsInserted: 0, errors: 0 };

  for (const league of LEAGUES) {
    console.log(`\n[league] ${league.name}`);

    // Fetch from The Odds API
    let events;
    try {
      events = await fetchOddsForLeague(league.sportKey);
    } catch (err) {
      console.error(`  [error] fetch failed: ${err.message}`);
      summary.errors++;
      continue;
    }

    if (!events.length) {
      console.log('  no events returned (off-season or no upcoming fixtures)');
      continue;
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

    // Process each event (h2h)
    for (const event of events) {
      const norm = normaliseEvent(event, league.name);

      if (!norm.oddsRows.length) {
        console.log(`  [skip] ${norm.homeTeam} vs ${norm.awayTeam} — no valid bookmaker odds`);
        continue;
      }

      console.log(`  ${norm.homeTeam} vs ${norm.awayTeam} (${norm.oddsRows.length} books)`);

      try {
        // Upsert teams
        const homeTeamId = DRY_RUN ? 'dry-id' : await upsertTeam(supabase, norm.homeTeam);
        const awayTeamId = DRY_RUN ? 'dry-id' : await upsertTeam(supabase, norm.awayTeam);

        // Upsert match
        const matchId = DRY_RUN
          ? 'dry-match-id'
          : await upsertMatch(supabase, {
              externalId:  norm.externalId,
              homeTeamId,
              awayTeamId,
              leagueId,
              kickoffAt:   norm.kickoffAt,
            });

        // Insert h2h odds
        const inserted = await insertOddsForMatch(supabase, matchId, norm.oddsRows);
        summary.oddsInserted += inserted;
        summary.events++;

      } catch (err) {
        console.error(`    [error] ${norm.homeTeam} vs ${norm.awayTeam}: ${err.message}`);
        summary.errors++;
      }
    }

    // ── Totals (over/under) ingestion ────────────────────────────────────
    console.log(`\n[totals] ${league.name}`);
    let totalsEvents;
    try {
      totalsEvents = await fetchTotalsForLeague(league.sportKey);
    } catch (err) {
      console.warn(`  [warn] totals fetch failed: ${err.message}`);
      totalsEvents = [];
    }

    for (const event of totalsEvents) {
      const norm = normaliseTotalsEvent(event);
      if (!norm.oddsRows.length) continue;

      try {
        // Look up existing match by external_id — already upserted above
        if (!DRY_RUN) {
          const { data: matchRow, error } = await supabase
            .from('matches')
            .select('id')
            .eq('external_id', norm.externalId)
            .maybeSingle();

          if (error || !matchRow) continue; // match not in DB yet, skip

          const inserted = await insertOddsForMatch(supabase, matchRow.id, norm.oddsRows);
          summary.oddsInserted += inserted;
        } else {
          console.log(`  [dry-run] totals for ${norm.externalId}: ${norm.oddsRows.length} rows`);
        }
      } catch (err) {
        console.error(`    [error] totals ${norm.externalId}: ${err.message}`);
        summary.errors++;
      }
    }

    // ── BTTS (both teams to score) ingestion ─────────────────────────────
    console.log(`\n[btts] ${league.name}`);
    let bttsEvents;
    try {
      bttsEvents = await fetchBttsForLeague(league.sportKey);
    } catch (err) {
      console.warn(`  [warn] btts fetch failed: ${err.message}`);
      bttsEvents = [];
    }

    for (const event of bttsEvents) {
      const norm = normaliseBttsEvent(event);
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
          console.log(`  [dry-run] btts for ${norm.externalId}: ${norm.oddsRows.length} rows`);
        }
      } catch (err) {
        console.error(`    [error] btts ${norm.externalId}: ${err.message}`);
        summary.errors++;
      }
    }

    summary.leagues++;

    // Brief pause between leagues to avoid hammering the API
    await sleep(300);
  }

  console.log('\n[ingest] complete:', summary);

  if (summary.errors > 0 && summary.leagues === 0) {
    throw new Error(
      `all ${summary.errors} league fetches failed — ODDS_API_KEY may be invalid or quota exhausted`
    );
  }

  return summary;
}

// ---------------------------------------------------------------------------
// Utilities
// ---------------------------------------------------------------------------

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Generate a short name from a full team name.
 * e.g. "Manchester City" → "Man City", "Arsenal" → "Arsenal"
 */
function makeShortName(name) {
  const overrides = {
    'Manchester City':    'Man City',
    'Manchester United':  'Man Utd',
    'Tottenham Hotspur':  'Spurs',
    'Newcastle United':   'Newcastle',
    'Nottingham Forest':  'Nottm Forest',
    'West Ham United':    'West Ham',
    'Wolverhampton Wanderers': 'Wolves',
    'Brighton & Hove Albion':  'Brighton',
    'Bayer 04 Leverkusen':     'Leverkusen',
    'Borussia Dortmund':       'Dortmund',
    'Borussia Mönchengladbach':'Gladbach',
    'Atletico Madrid':         'Atletico',
    'Real Sociedad':           'Sociedad',
    'Inter Milan':             'Inter',
    'AC Milan':                'Milan',
    'Paris Saint-Germain':     'PSG',
  };
  return overrides[name] ?? (name.length > 12 ? name.split(' ').slice(0, 2).join(' ') : name);
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

module.exports = { ingest, normaliseEvent, oddsHaveMoved };
