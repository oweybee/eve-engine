'use strict';

/**
 * ingestLiveOdds.js — live match state + in-play odds ingestion.
 *
 * Feeds computeInplayValues.js. Each run:
 *   1. GET /fixtures?live=all  (one call) → for fixtures we already track,
 *      update matches.status='live', current goals_home/goals_away, minute.
 *   2. GET /odds/live?fixture=<id> per tracked live fixture → write the current
 *      in-play 1X2 price into the `odds` table (fetched_at = now) so the in-play
 *      engine reads a fresh live price.
 *
 * NOTE ON DATA SOURCE: API-Football /odds/live is a single aggregated feed, not
 * a crowd of bookmakers. We store it under one synthetic bookmaker
 * ('apifootball_live'). That is enough for the model-vs-market stage (which only
 * needs one live price). The multi-book book-lag consensus stage stays dormant
 * until a genuine multi-book live source is wired — by design, never on fake
 * "books".
 *
 * Required: API_FOOTBALL_KEY, SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY.
 * Usage: node ingestLiveOdds.js [--dry-run]
 */

const https         = require('https');
const { getClient } = require('./lib/supabaseClient');
const inplay        = require('./lib/inplay');

const API_FOOTBALL_KEY = process.env.API_FOOTBALL_KEY;
const API_HOST         = 'v3.football.api-sports.io';
const DRY_RUN          = process.argv.includes('--dry-run');
const LIVE_BOOKMAKER   = 'apifootball_live';

function httpGet(path) {
  if (!API_FOOTBALL_KEY) throw new Error('API_FOOTBALL_KEY not set');
  return new Promise((resolve, reject) => {
    https.request(
      { method: 'GET', hostname: API_HOST, path, headers: { 'x-apisports-key': API_FOOTBALL_KEY } },
      res => {
        let body = '';
        res.on('data', c => { body += c; });
        res.on('end', () => {
          if (res.statusCode !== 200) return reject(new Error(`HTTP ${res.statusCode}: ${body.slice(0, 200)}`));
          try { resolve(JSON.parse(body)); } catch (e) { reject(new Error(`JSON parse: ${e.message}`)); }
        });
      },
    ).on('error', reject).end();
  });
}

/** Matches we track that are inside the live window — Map<externalId, match>. */
async function fetchTrackedLiveMatches(supabase) {
  const { data, error } = await supabase
    .from('matches')
    .select('id, external_id, kickoff_at, status')
    .in('status', ['scheduled', 'live']);
  if (error) throw new Error(`fetchTrackedLiveMatches: ${error.message}`);

  const now = Date.now();
  const map = new Map();
  for (const m of data ?? []) {
    if (!/^\d+$/.test(m.external_id ?? '')) continue;
    const ko = m.kickoff_at ? new Date(m.kickoff_at).getTime() : NaN;
    if (inplay.isWithinLiveWindow(ko, now)) map.set(String(m.external_id), m);
  }
  return map;
}

/** Extract the current 1X2 price from an /odds/live bookmaker/bet payload. */
function extractLiveH2h(oddsBets) {
  // /odds/live response item shape: { fixture, odds: [ { id, name, values:[...] } ] }
  // Match-winner bet names vary ("Fulltime Result" / "Match Winner" / "1x2").
  const bet = (oddsBets ?? []).find(b =>
    /full ?time result|match winner|1x2|fulltime/i.test(b?.name ?? '')
  );
  if (!bet) return null;

  const pick = label => {
    const v = (bet.values ?? []).find(x =>
      String(x.value ?? '').toLowerCase() === label && !x.suspended
    );
    const o = v ? parseFloat(v.odd) : NaN;
    return Number.isFinite(o) && o > 1 && o < 1000 ? o : null;
  };
  const home = pick('home');
  const draw = pick('draw');
  const away = pick('away');
  if (home == null || draw == null || away == null) return null;
  return { home, draw, away };
}

async function run() {
  console.log(`\n[live] ${new Date().toISOString()}${DRY_RUN ? ' [DRY RUN]' : ''}`);
  const supabase = getClient();

  const tracked = await fetchTrackedLiveMatches(supabase);
  if (!tracked.size) { console.log('[live] no tracked matches in the live window — done'); return; }
  console.log(`[live] ${tracked.size} tracked match(es) in live window`);

  // 1. Live fixture state (one call) — update score/minute/status.
  let liveFixtures = [];
  try {
    const json = await httpGet('/fixtures?live=all');
    liveFixtures = json?.response ?? [];
  } catch (err) {
    console.error('[live] /fixtures?live=all failed:', err.message);
  }

  let stateUpdated = 0;
  const liveById = new Map();
  for (const fx of liveFixtures) {
    const id = String(fx?.fixture?.id ?? '');
    if (!tracked.has(id)) continue;
    liveById.set(id, fx);
    const update = {
      status:     'live',
      goals_home: fx?.goals?.home ?? null,
      goals_away: fx?.goals?.away ?? null,
      minute:     fx?.fixture?.status?.elapsed ?? null,
    };
    if (DRY_RUN) { console.log(`  [dry] ${id} → ${JSON.stringify(update)}`); stateUpdated++; continue; }
    const { error } = await supabase.from('matches').update(update).eq('id', tracked.get(id).id);
    if (error) console.warn(`  [live] state update ${id} failed: ${error.message}`);
    else stateUpdated++;
  }
  console.log(`[live] match state updated: ${stateUpdated}`);

  // 2. Live odds per tracked, currently-live fixture.
  let oddsInserted = 0;
  for (const [extId, fx] of liveById) {
    let bets;
    try {
      const json = await httpGet(`/odds/live?fixture=${extId}`);
      bets = json?.response?.[0]?.odds ?? [];
    } catch (err) {
      console.warn(`  [live] odds ${extId} failed: ${err.message}`);
      continue;
    }
    const h2h = extractLiveH2h(bets);
    if (!h2h) continue;

    const row = {
      match_id:   tracked.get(extId).id,
      bookmaker:  LIVE_BOOKMAKER,
      market:     'h2h',
      home_odds:  h2h.home,
      draw_odds:  h2h.draw,
      away_odds:  h2h.away,
      fetched_at: new Date().toISOString(),
    };
    if (DRY_RUN) { console.log(`  [dry] live odds ${extId}: ${JSON.stringify(h2h)}`); oddsInserted++; continue; }
    const { error } = await supabase.from('odds').insert(row);
    if (error) console.warn(`  [live] odds insert ${extId} failed: ${error.message}`);
    else oddsInserted++;

    await new Promise(r => setTimeout(r, 200));
  }
  console.log(`[live] live odds rows written: ${oddsInserted}`);
  console.log('[live] done');
}

if (require.main === module) {
  run().catch(err => { console.error('[live] fatal:', err.message); process.exit(1); });
}

module.exports = { run, extractLiveH2h, fetchTrackedLiveMatches };
