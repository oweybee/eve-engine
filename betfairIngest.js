/**
 * EVE — Betfair Exchange Ingestion
 *
 * Authenticates with Betfair, fetches upcoming FIFA World Cup events,
 * pulls Match Odds (1X2), Over/Under 2.5 Goals, and Both Teams to Score
 * market prices, then writes them into Supabase.
 *
 * Usage:
 *   node betfairIngest.js             — live run
 *   node betfairIngest.js --dry-run   — fetch + log, no DB writes
 *
 * Required env vars:
 *   BETFAIR_APP_KEY, BETFAIR_USERNAME, BETFAIR_PASSWORD
 *   SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY
 */

'use strict';

const https = require('https');
const { createClient } = require('@supabase/supabase-js');

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

const APP_KEY  = process.env.BETFAIR_APP_KEY;
const USERNAME = process.env.BETFAIR_USERNAME;
const PASSWORD = process.env.BETFAIR_PASSWORD;
const DRY_RUN  = process.argv.includes('--dry-run');

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

// FIFA World Cup competition ID on Betfair
const WORLD_CUP_COMPETITION_ID = '12469077';

// Minimum price movement to bother inserting a new row
const MIN_PRICE_MOVEMENT = 0.01;

// Self-throttle: skip the run if we already ingested within this many minutes.
// Keeps Betfair logins sane regardless of how often the engine fires.
const MIN_RUN_INTERVAL_MIN = parseFloat(process.env.BETFAIR_MIN_INTERVAL_MIN || '12');

// ---------------------------------------------------------------------------
// HTTP helpers
// ---------------------------------------------------------------------------

function httpPost(hostname, path, headers, body) {
  return new Promise((resolve, reject) => {
    const bodyStr = typeof body === 'string' ? body : JSON.stringify(body);
    const req = https.request(
      {
        hostname,
        path,
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(bodyStr),
          ...headers,
        },
      },
      (res) => {
        let data = '';
        res.on('data', chunk => { data += chunk; });
        res.on('end', () => {
          try { resolve({ status: res.statusCode, body: JSON.parse(data) }); }
          catch { resolve({ status: res.statusCode, body: data }); }
        });
      }
    );
    req.on('error', reject);
    req.write(bodyStr);
    req.end();
  });
}

function httpPostForm(hostname, path, headers, formBody, redirectCount = 0) {
  return new Promise((resolve, reject) => {
    if (redirectCount > 5) return reject(new Error('Too many redirects'));
    const bodyStr = formBody;
    const req = https.request(
      {
        hostname,
        path,
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          'Accept': 'application/json',
          'Content-Length': Buffer.byteLength(bodyStr),
          ...headers,
        },
      },
      (res) => {
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          res.resume();
          const loc = new URL(res.headers.location, `https://${hostname}`);
          resolve(httpPostForm(loc.hostname, loc.pathname + loc.search, headers, formBody, redirectCount + 1));
          return;
        }
        let data = '';
        res.on('data', chunk => { data += chunk; });
        res.on('end', () => {
          try { resolve({ status: res.statusCode, body: JSON.parse(data) }); }
          catch { resolve({ status: res.statusCode, body: data }); }
        });
      }
    );
    req.on('error', reject);
    req.write(bodyStr);
    req.end();
  });
}

// ---------------------------------------------------------------------------
// 1. Authenticate with Betfair
// ---------------------------------------------------------------------------

async function authenticate() {
  if (!APP_KEY || !USERNAME || !PASSWORD) {
    throw new Error('Missing BETFAIR_APP_KEY, BETFAIR_USERNAME, or BETFAIR_PASSWORD');
  }

  console.log('[auth] logging in as', USERNAME, '| app key length:', APP_KEY.length, '| key prefix:', APP_KEY.slice(0, 4) + '****');

  const formBody = `username=${encodeURIComponent(USERNAME)}&password=${encodeURIComponent(PASSWORD)}`;

  const { status, body } = await httpPostForm(
    'identitysso.betfair.com',
    '/api/login',
    { 'X-Application': APP_KEY },
    formBody
  );

  if (status !== 200) {
    console.error('[auth] HTTP', status, 'response body:', JSON.stringify(body));
    throw new Error(`Auth HTTP ${status}`);
  }
  if (body.status !== 'SUCCESS') throw new Error(`Auth failed: ${body.status} — ${body.error ?? ''}`);

  const token = body.token;
  if (!token) throw new Error('No session token in auth response');

  console.log('[auth] ✓ session token obtained');
  return token;
}

// ---------------------------------------------------------------------------
// 2. Betfair Exchange API — JSON-RPC wrapper
// ---------------------------------------------------------------------------

async function betfairRpc(sessionToken, method, params) {
  const payload = {
    jsonrpc: '2.0',
    method:  `SportsAPING/v1.0/${method}`,
    params,
    id:      1,
  };

  const { status, body } = await httpPost(
    'api.betfair.com',
    '/exchange/betting/json-rpc/v1',
    {
      'X-Application':    APP_KEY,
      'X-Authentication': sessionToken,
      'Accept':           'application/json',
    },
    payload
  );

  if (status !== 200) throw new Error(`Betfair RPC HTTP ${status}`);
  if (body.error)     throw new Error(`Betfair RPC error: ${JSON.stringify(body.error)}`);
  if (body.result?.error) throw new Error(`Betfair API error: ${JSON.stringify(body.result.error)}`);

  return body.result;
}

// ---------------------------------------------------------------------------
// 3. List upcoming World Cup events
// ---------------------------------------------------------------------------

async function listWorldCupEvents(sessionToken) {
  console.log('[events] fetching FIFA World Cup events...');

  const result = await betfairRpc(sessionToken, 'listEvents', {
    filter: {
      eventTypeIds:   ['1'],           // Soccer
      competitionIds: [WORLD_CUP_COMPETITION_ID],
    },
  });

  const events = (result ?? []).map(e => ({
    betfairEventId: e.event.id,
    name:           e.event.name,
    openDate:       e.event.openDate,
    countryCode:    e.event.countryCode,
  }));

  console.log(`[events] → ${events.length} events found`);
  for (const ev of events) {
    console.log(`  ${ev.betfairEventId}  ${ev.name}  (${ev.openDate})`);
  }

  return events;
}

// ---------------------------------------------------------------------------
// 4. List markets for an event
// ---------------------------------------------------------------------------

async function listMarketsForEvent(sessionToken, eventId) {
  // RUNNER_DESCRIPTION gives us each runner's name + selectionId so we can map
  // prices to home/draw/away by NAME rather than by fragile array position.
  const result = await betfairRpc(sessionToken, 'listMarketCatalogue', {
    filter:           { eventIds: [eventId] },
    marketProjection: ['RUNNER_DESCRIPTION'],
    maxResults:       30,
  });

  return (result ?? []).map(m => ({
    marketId:   m.marketId,
    marketName: m.marketName,
    runners:    (m.runners ?? []).map(r => ({
      selectionId: r.selectionId,
      runnerName:  r.runnerName,
    })),
  }));
}

// ---------------------------------------------------------------------------
// 5. Fetch live prices for a list of market IDs
// ---------------------------------------------------------------------------

async function fetchPrices(sessionToken, marketIds) {
  if (!marketIds.length) return [];

  const result = await betfairRpc(sessionToken, 'listMarketBook', {
    marketIds,
    priceProjection: {
      priceData:          ['EX_BEST_OFFERS'],
      exBestOffersOverrides: { bestPricesDepth: 1 },
      virtualise:         false,
    },
  });

  return result ?? [];
}

// ---------------------------------------------------------------------------
// 6. Parse prices from market books
// ---------------------------------------------------------------------------

/**
 * Gets the best available back price for a runner book entry.
 */
function bestBackPrice(runner) {
  const backs = runner?.ex?.availableToBack ?? [];
  return backs.length ? parseFloat(backs[0].price) : null;
}

/** Accent/punctuation-insensitive name normaliser. */
function normName(s) {
  return (s ?? '')
    .toLowerCase()
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]/g, '');
}

/**
 * Builds { selectionId → bestBackPrice } from a market book.
 */
function priceMap(book) {
  const map = {};
  for (const rb of (book.runners ?? [])) map[rb.selectionId] = bestBackPrice(rb);
  return map;
}

/**
 * Parses a Match Odds market by RUNNER NAME (not array position).
 * The draw runner is always named exactly "The Draw"; the home/away runners
 * match the home/away team names from the event. If names can't be matched
 * confidently we return null so the caller skips rather than storing garbage.
 */
function parseMatchOdds(book, runners, homeTeam, awayTeam) {
  const prices = priceMap(book);

  let homeSel = null, drawSel = null, awaySel = null;
  const homeN = normName(homeTeam);
  const awayN = normName(awayTeam);

  for (const r of runners) {
    const n = normName(r.runnerName);
    if (r.runnerName === 'The Draw' || n === 'thedraw') drawSel = r.selectionId;
    else if (n === homeN) homeSel = r.selectionId;
    else if (n === awayN) awaySel = r.selectionId;
  }

  if (homeSel == null || drawSel == null || awaySel == null) {
    console.warn(`    [warn] Match Odds runner names not matched (home="${homeTeam}" away="${awayTeam}", runners=[${runners.map(r => r.runnerName).join(', ')}]) — skipping market`);
    return null;
  }

  const h = prices[homeSel], d = prices[drawSel], a = prices[awaySel];
  if (!h || !d || !a || h <= 1 || d <= 1 || a <= 1) return null;

  return { market: 'h2h', homeTeam, awayTeam, homeOdds: h, drawOdds: d, awayOdds: a };
}

/**
 * Parses an Over/Under 2.5 market by runner name ("Over 2.5 Goals" / "Under …").
 */
function parseOverUnder(book, runners) {
  const prices = priceMap(book);
  let overSel = null, underSel = null;
  for (const r of runners) {
    if (/over/i.test(r.runnerName))  overSel  = r.selectionId;
    else if (/under/i.test(r.runnerName)) underSel = r.selectionId;
  }
  if (overSel == null || underSel == null) {
    console.warn('    [warn] O/U runner names not matched — skipping market');
    return null;
  }
  const o = prices[overSel], u = prices[underSel];
  if (!o || !u || o <= 1 || u <= 1) return null;

  return { market: 'totals', marketLine: 2.5, overOdds: o, underOdds: u };
}

/**
 * Parses a Both Teams to Score market by runner name ("Yes" / "No").
 */
function parseBTTS(book, runners) {
  const prices = priceMap(book);
  let yesSel = null, noSel = null;
  for (const r of runners) {
    if (/^yes$/i.test(r.runnerName)) yesSel = r.selectionId;
    else if (/^no$/i.test(r.runnerName)) noSel = r.selectionId;
  }
  if (yesSel == null || noSel == null) {
    console.warn('    [warn] BTTS runner names not matched — skipping market');
    return null;
  }
  const y = prices[yesSel], n = prices[noSel];
  if (!y || !n || y <= 1 || n <= 1) return null;

  return { market: 'btts', yesOdds: y, noOdds: n };
}

/**
 * Parses a Booking Points market (Betfair: "Booking Points").
 *
 * Betfair booking points runner names vary by event but follow patterns like:
 *   "Under 30.5", "Over 30.5", "Under 35.5 Booking Points", etc.
 * We find all Over/Under pairs and pick the line with the tightest spread
 * (most liquid). Stored as: over → home_odds, under → away_odds, line → market_line.
 */
function parseBookings(book, runners) {
  const prices = priceMap(book);
  const lines = {};  // line → { overSel, underSel }

  for (const r of runners) {
    const name = r.runnerName ?? '';
    const overMatch  = name.match(/over\s+([\d.]+)/i);
    const underMatch = name.match(/under\s+([\d.]+)/i);
    if (overMatch) {
      const line = parseFloat(overMatch[1]);
      if (!lines[line]) lines[line] = {};
      lines[line].overSel = r.selectionId;
    } else if (underMatch) {
      const line = parseFloat(underMatch[1]);
      if (!lines[line]) lines[line] = {};
      lines[line].underSel = r.selectionId;
    }
  }

  // Find complete (over+under) pairs; pick the most liquid (tightest margin)
  let best = null, bestSpread = Infinity;
  for (const [lineStr, sel] of Object.entries(lines)) {
    if (!sel.overSel || !sel.underSel) continue;
    const o = prices[sel.overSel], u = prices[sel.underSel];
    if (!o || !u || o <= 1 || u <= 1) continue;
    const spread = Math.abs((1 / o + 1 / u) - 1);  // overround — lower = more liquid
    if (spread < bestSpread) {
      bestSpread = spread;
      best = { line: parseFloat(lineStr), overOdds: o, underOdds: u };
    }
  }

  if (!best) {
    console.warn('    [warn] Booking Points runners not matched — skipping market');
    return null;
  }
  return { market: 'bookings', ...best };
}

/**
 * Parses a Total Corners market (Betfair: "Total Corners" or "Asian Corners").
 *
 * Runner names follow patterns like:
 *   "Under 9.5 Corners", "Over 9.5 Corners", "Under 10.5", "Over 10.5"
 * Picks the most liquid line (lowest overround) when multiple lines exist.
 * Stored as: over → home_odds, under → away_odds, line → market_line.
 */
function parseCorners(book, runners) {
  const prices = priceMap(book);
  const lines = {};

  for (const r of runners) {
    const name = r.runnerName ?? '';
    const overMatch  = name.match(/over\s+([\d.]+)/i);
    const underMatch = name.match(/under\s+([\d.]+)/i);
    if (overMatch) {
      const line = parseFloat(overMatch[1]);
      if (!lines[line]) lines[line] = {};
      lines[line].overSel = r.selectionId;
    } else if (underMatch) {
      const line = parseFloat(underMatch[1]);
      if (!lines[line]) lines[line] = {};
      lines[line].underSel = r.selectionId;
    }
  }

  let best = null, bestSpread = Infinity;
  for (const [lineStr, sel] of Object.entries(lines)) {
    if (!sel.overSel || !sel.underSel) continue;
    const o = prices[sel.overSel], u = prices[sel.underSel];
    if (!o || !u || o <= 1 || u <= 1) continue;
    const spread = Math.abs((1 / o + 1 / u) - 1);
    if (spread < bestSpread) {
      bestSpread = spread;
      best = { line: parseFloat(lineStr), overOdds: o, underOdds: u };
    }
  }

  if (!best) {
    console.warn('    [warn] Total Corners runners not matched — skipping market');
    return null;
  }
  return { market: 'corners', ...best };
}

// ---------------------------------------------------------------------------
// 7. Supabase helpers
// ---------------------------------------------------------------------------

function getSupabase() {
  if (!SUPABASE_URL || !SUPABASE_KEY) throw new Error('Missing Supabase env vars');
  return createClient(SUPABASE_URL, SUPABASE_KEY);
}

async function upsertLeague(supabase) {
  const { data, error } = await supabase
    .from('leagues')
    .upsert({ name: 'FIFA World Cup', country: 'International' }, { onConflict: 'name' })
    .select('id')
    .single();
  if (error) throw new Error(`upsertLeague: ${error.message}`);
  return data.id;
}

async function upsertTeam(supabase, name) {
  const short = name.length > 12 ? name.split(' ').slice(0, 2).join(' ') : name;
  const { data, error } = await supabase
    .from('teams')
    .upsert({ name, short_name: short }, { onConflict: 'name' })
    .select('id')
    .single();
  if (error) throw new Error(`upsertTeam(${name}): ${error.message}`);
  return data.id;
}

/**
 * Finds an existing match by fuzzy team name matching on the same day.
 * Betfair team names often differ from The Odds API (e.g. "United States" vs "USA"),
 * so we fetch all World Cup matches on that date and score by name similarity.
 */
async function findOrCreateMatch(supabase, { homeTeam, awayTeam, leagueId, kickoffAt, externalId }) {
  const kickoffDate = kickoffAt.slice(0, 10);

  // Fetch all matches on same day with team names
  const { data: candidates } = await supabase
    .from('matches')
    .select(`
      id,
      home_team:teams!matches_home_team_id_fkey ( name ),
      away_team:teams!matches_away_team_id_fkey ( name )
    `)
    .gte('kickoff_at', kickoffDate + 'T00:00:00Z')
    .lte('kickoff_at', kickoffDate + 'T23:59:59Z');

  if (candidates?.length) {
    // Score each candidate by how well names match (case-insensitive, partial)
    const norm = s => s.toLowerCase().replace(/[^a-z0-9]/g, '');
    const bfHome = norm(homeTeam);
    const bfAway = norm(awayTeam);

    let bestMatch = null;
    let bestScore = 0;

    for (const c of candidates) {
      const dbHome = norm(c.home_team?.name ?? '');
      const dbAway = norm(c.away_team?.name ?? '');

      // Score: +2 for exact norm match, +1 for one containing the other
      let score = 0;
      if (dbHome === bfHome || dbAway === bfAway) score += 2;
      if (dbHome === bfAway || dbAway === bfHome) score += 2; // swapped home/away
      if (dbHome.includes(bfHome) || bfHome.includes(dbHome)) score += 1;
      if (dbAway.includes(bfAway) || bfAway.includes(dbAway)) score += 1;
      if (dbHome.includes(bfAway) || bfAway.includes(dbHome)) score += 1;
      if (dbAway.includes(bfHome) || bfHome.includes(dbAway)) score += 1;

      if (score > bestScore) { bestScore = score; bestMatch = c; }
    }

    if (bestMatch && bestScore >= 2) {
      return bestMatch.id;
    }
  }

  // No match found — upsert teams and create new match record
  const { data: homeTeamRow, error: homeErr } = await supabase
    .from('teams')
    .upsert({ name: homeTeam, short_name: homeTeam.length > 12 ? homeTeam.split(' ').slice(0, 2).join(' ') : homeTeam }, { onConflict: 'name' })
    .select('id').single();
  // P0-6 fix: team upsert can return null data on RLS or constraint violations.
  // Dereference .id without this guard causes an unrecoverable TypeError that
  // crashes the entire ingest run for all subsequent matches.
  if (!homeTeamRow) throw new Error(`findOrCreateMatch: home team upsert returned no row for "${homeTeam}"${homeErr ? ` — ${homeErr.message}` : ''}`);

  const { data: awayTeamRow, error: awayErr } = await supabase
    .from('teams')
    .upsert({ name: awayTeam, short_name: awayTeam.length > 12 ? awayTeam.split(' ').slice(0, 2).join(' ') : awayTeam }, { onConflict: 'name' })
    .select('id').single();
  if (!awayTeamRow) throw new Error(`findOrCreateMatch: away team upsert returned no row for "${awayTeam}"${awayErr ? ` — ${awayErr.message}` : ''}`);

  const { data, error } = await supabase
    .from('matches')
    .upsert(
      { external_id: externalId, home_team_id: homeTeamRow.id, away_team_id: awayTeamRow.id, league_id: leagueId, kickoff_at: kickoffAt, status: 'scheduled' },
      { onConflict: 'external_id' }
    )
    .select('id').single();
  if (error) throw new Error(`findOrCreateMatch(${externalId}): ${error.message}`);
  return data.id;
}

async function getLastOdds(supabase, matchId, bookmaker, market) {
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

function pricesHaveMoved(last, h, d, a) {
  if (!last) return true;
  const moved = (x, y) => x != null && y != null && Math.abs(x - y) > MIN_PRICE_MOVEMENT;
  return moved(h, last.home_odds) || moved(a, last.away_odds) || moved(d, last.draw_odds);
}

async function insertOddsRow(supabase, matchId, row) {
  if (DRY_RUN) {
    console.log(`      [dry-run] ${row.market} ${row.bookmaker} H=${row.home_odds} D=${row.draw_odds ?? '-'} A=${row.away_odds}`);
    return true;
  }

  const last = await getLastOdds(supabase, matchId, row.bookmaker, row.market);
  if (!pricesHaveMoved(last, row.home_odds, row.draw_odds, row.away_odds)) return false;

  const { error } = await supabase.from('odds').insert({ match_id: matchId, ...row });
  if (error) { console.warn(`      [warn] insert failed: ${error.message}`); return false; }
  return true;
}

// ---------------------------------------------------------------------------
// 8. Main ingestion loop
// ---------------------------------------------------------------------------

async function ingest() {
  console.log(`\n[betfairIngest] starting ${DRY_RUN ? '(DRY RUN) ' : ''}at ${new Date().toISOString()}`);

  // Self-throttle on data freshness — robust to any cron cadence. If a recent
  // Betfair row exists, skip (no login, no API calls).
  if (!DRY_RUN) {
    const supa  = getSupabase();
    const since = new Date(Date.now() - MIN_RUN_INTERVAL_MIN * 60_000).toISOString();
    const { data: recent } = await supa
      .from('odds').select('id').eq('bookmaker', 'betfair_ex_uk').gte('fetched_at', since).limit(1);
    if (recent && recent.length) {
      console.log(`[betfairIngest] skip — already ingested within ${MIN_RUN_INTERVAL_MIN} min`);
      return { skipped: true };
    }
  }

  // Authenticate
  const sessionToken = await authenticate();

  // Fetch events
  const events = await listWorldCupEvents(sessionToken);
  if (!events.length) {
    console.log('[betfairIngest] no events found — exiting');
    return;
  }

  const supabase = DRY_RUN ? null : getSupabase();
  const leagueId = DRY_RUN ? 'dry-league' : await upsertLeague(supabase);

  const summary = { events: 0, marketsProcessed: 0, oddsInserted: 0, errors: 0 };
  const fetchedAt = new Date().toISOString();

  for (const event of events) {
    console.log(`\n[event] ${event.name} (${event.betfairEventId})`);

    // List markets for this event
    let markets;
    try {
      markets = await listMarketsForEvent(sessionToken, event.betfairEventId);
    } catch (err) {
      console.error(`  [error] listMarkets: ${err.message}`);
      summary.errors++;
      continue;
    }

    if (!markets.length) {
      console.log('  no markets found');
      continue;
    }

    console.log(`  markets: ${markets.map(m => m.marketName).join(', ')}`);

    // Fetch prices for all markets in one call
    const marketIds = markets.map(m => m.marketId);
    let books;
    try {
      books = await fetchPrices(sessionToken, marketIds);
    } catch (err) {
      console.error(`  [error] fetchPrices: ${err.message}`);
      summary.errors++;
      continue;
    }

    // Build a map: marketId → book
    const bookMap = {};
    for (const b of books) bookMap[b.marketId] = b;

    // Derive team names from event name ("Austria v Jordan" → home/away)
    const nameParts = event.name.split(' v ');
    const homeTeam = nameParts[0]?.trim() ?? 'Home';
    const awayTeam = nameParts[1]?.trim() ?? 'Away';

    // Parse each market
    let matchOddsResult  = null;
    let overUnderResult  = null;
    let bttsResult       = null;
    let bookingsResult   = null;
    let cornersResult    = null;

    for (const mkt of markets) {
      const book = bookMap[mkt.marketId];
      if (!book) continue;
      const runners = mkt.runners ?? [];

      if (/^match odds$/i.test(mkt.marketName)) {
        matchOddsResult = parseMatchOdds(book, runners, homeTeam, awayTeam);
        if (matchOddsResult) {
          console.log(`  [h2h]    H(${homeTeam}):${matchOddsResult.homeOdds} D:${matchOddsResult.drawOdds} A(${awayTeam}):${matchOddsResult.awayOdds}`);
        }
      } else if (/^over\/under 2\.5 goals$/i.test(mkt.marketName)) {
        overUnderResult = parseOverUnder(book, runners);
        if (overUnderResult) {
          console.log(`  [totals] O:${overUnderResult.overOdds} U:${overUnderResult.underOdds}`);
        }
      } else if (/^both teams to score\??$/i.test(mkt.marketName)) {
        bttsResult = parseBTTS(book, runners);
        if (bttsResult) {
          console.log(`  [btts]   Y:${bttsResult.yesOdds} N:${bttsResult.noOdds}`);
        }
      } else if (/bookings?\s+points?/i.test(mkt.marketName)) {
        bookingsResult = parseBookings(book, runners);
        if (bookingsResult) {
          console.log(`  [cards]  line:${bookingsResult.line} O:${bookingsResult.overOdds} U:${bookingsResult.underOdds}`);
        }
      } else if (/total corners?|asian corners?/i.test(mkt.marketName)) {
        cornersResult = parseCorners(book, runners);
        if (cornersResult) {
          console.log(`  [corners] line:${cornersResult.line} O:${cornersResult.overOdds} U:${cornersResult.underOdds}`);
        }
      }
    }

    // Need at minimum the h2h market to identify teams
    if (!matchOddsResult) {
      console.log('  [skip] no parseable Match Odds market');
      continue;
    }

    // Upsert match + teams
    let matchId;
    try {
      if (DRY_RUN) {
        matchId = 'dry-match';
      } else {
        matchId = await findOrCreateMatch(supabase, {
          externalId: `bf_${event.betfairEventId}`,
          homeTeam:   matchOddsResult.homeTeam,
          awayTeam:   matchOddsResult.awayTeam,
          leagueId,
          kickoffAt:  event.openDate,
        });
      }
    } catch (err) {
      console.error(`  [error] upsert match: ${err.message}`);
      summary.errors++;
      continue;
    }

    // Insert h2h odds
    const h2hRow = {
      bookmaker:  'betfair_ex_uk',
      market:     'h2h',
      home_odds:  matchOddsResult.homeOdds,
      draw_odds:  matchOddsResult.drawOdds,
      away_odds:  matchOddsResult.awayOdds,
      fetched_at: fetchedAt,
    };
    if (await insertOddsRow(supabase, matchId, h2hRow)) summary.oddsInserted++;
    summary.marketsProcessed++;

    // Insert totals odds
    if (overUnderResult) {
      const totalsRow = {
        bookmaker:   'betfair_ex_uk',
        market:      'totals',
        home_odds:   overUnderResult.overOdds,    // Over → home_odds
        draw_odds:   null,
        away_odds:   overUnderResult.underOdds,   // Under → away_odds
        market_line: overUnderResult.marketLine,
        fetched_at:  fetchedAt,
      };
      if (await insertOddsRow(supabase, matchId, totalsRow)) summary.oddsInserted++;
      summary.marketsProcessed++;
    }

    // Insert BTTS odds
    if (bttsResult) {
      const bttsRow = {
        bookmaker:  'betfair_ex_uk',
        market:     'btts',
        home_odds:  bttsResult.yesOdds,   // Yes → home_odds
        draw_odds:  null,
        away_odds:  bttsResult.noOdds,    // No  → away_odds
        fetched_at: fetchedAt,
      };
      if (await insertOddsRow(supabase, matchId, bttsRow)) summary.oddsInserted++;
      summary.marketsProcessed++;
    }

    // Insert bookings (card points) odds
    if (bookingsResult) {
      const bookingsRow = {
        bookmaker:   'betfair_ex_uk',
        market:      'bookings',
        home_odds:   bookingsResult.overOdds,   // Over → home_odds
        draw_odds:   null,
        away_odds:   bookingsResult.underOdds,  // Under → away_odds
        market_line: bookingsResult.line,
        fetched_at:  fetchedAt,
      };
      if (await insertOddsRow(supabase, matchId, bookingsRow)) summary.oddsInserted++;
      summary.marketsProcessed++;
    }

    // Insert corners odds
    if (cornersResult) {
      const cornersRow = {
        bookmaker:   'betfair_ex_uk',
        market:      'corners',
        home_odds:   cornersResult.overOdds,   // Over → home_odds
        draw_odds:   null,
        away_odds:   cornersResult.underOdds,  // Under → away_odds
        market_line: cornersResult.line,
        fetched_at:  fetchedAt,
      };
      if (await insertOddsRow(supabase, matchId, cornersRow)) summary.oddsInserted++;
      summary.marketsProcessed++;
    }

    summary.events++;
    await sleep(100); // gentle rate limiting
  }

  console.log('\n[betfairIngest] done:', summary);
  return summary;
}

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

if (require.main === module) {
  ingest().catch(err => {
    console.error('[betfairIngest] fatal:', err.message);
    process.exit(1);
  });
}

module.exports = { ingest, authenticate, parseMatchOdds, parseOverUnder, parseBTTS, parseBookings, parseCorners };
