/**
 * fetchMatchDetails.js — fetches lineups, predictions and match stats from
 * API-Football v3 and upserts into Supabase.
 *
 * Called after computeValues.js in the engine pipeline.
 * Safe to call every 15 min — it only fetches for matches kicking off within
 * the next 24h (predictions/lineups) or completed within the last 6h (stats).
 * Each endpoint result is cached per match_id via upsert so repeated calls
 * are idempotent.
 *
 * Endpoints used (all included in Ultra plan):
 *   GET /predictions?fixture={id}     — AI win probability + advice + predicted lineup
 *   GET /fixtures/lineups?fixture={id} — confirmed starting XI (available ~H-1)
 *   GET /fixtures/statistics?fixture={id} — match stats (post-kickoff)
 *
 * Required env vars: API_FOOTBALL_KEY, SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY
 */

'use strict';

const https            = require('https');
const { createClient } = require('@supabase/supabase-js');

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

const API_FOOTBALL_KEY  = process.env.API_FOOTBALL_KEY;
const API_FOOTBALL_HOST = 'v3.football.api-sports.io';
const SUPABASE_URL      = process.env.SUPABASE_URL;
const SUPABASE_KEY      = process.env.SUPABASE_SERVICE_ROLE_KEY;

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
          if (res.statusCode === 429) {
            reject(Object.assign(new Error('Rate limit hit'), { is429: true }));
            return;
          }
          if (res.statusCode !== 200) {
            reject(new Error(`HTTP ${res.statusCode}: ${body.slice(0, 200)}`));
            return;
          }
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
        console.warn(`[details] 429 on attempt ${attempt}/${retries} — waiting ${delay / 1000}s before retry`);
        await sleep(delay);
        continue;
      }
      throw err;
    }
  }
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// ---------------------------------------------------------------------------
// Query matches to process
// ---------------------------------------------------------------------------

/**
 * Returns matches that are either:
 *   - upcoming within the next 24h (fetch predictions + lineups), or
 *   - completed within the last 6h (fetch match stats)
 *
 * Only includes matches where external_id looks like a pure integer (API-Football fixture ID).
 */
async function queryMatches(supabase) {
  const now       = new Date();
  const in24h     = new Date(now.getTime() + 24 * 60 * 60 * 1000).toISOString();
  const minus6h   = new Date(now.getTime() - 6  * 60 * 60 * 1000).toISOString();

  const { data, error } = await supabase
    .from('matches')
    .select('id, external_id, kickoff_at, status')
    .neq('status', 'cancelled')
    // external_id must be a pure integer (API-Football fixture ID)
    .filter('external_id', 'ilike', '%')  // ensure external_id is not null
    .or(`kickoff_at.lte.${in24h},and(status.eq.completed,kickoff_at.gte.${minus6h})`);

  if (error) throw new Error(`queryMatches: ${error.message}`);

  // Additional in-JS filter: external_id must be all digits
  return (data ?? []).filter(m => /^\d+$/.test(m.external_id ?? ''));
}

// ---------------------------------------------------------------------------
// API fetch helpers
// ---------------------------------------------------------------------------

async function fetchPredictions(fixtureId) {
  const json = await httpGet(`/predictions?fixture=${fixtureId}`);
  return json.response?.[0] ?? null;
}

async function fetchLineups(fixtureId) {
  const json = await httpGet(`/fixtures/lineups?fixture=${fixtureId}`);
  return json.response ?? [];
}

async function fetchStats(fixtureId) {
  const json = await httpGet(`/fixtures/statistics?fixture=${fixtureId}`);
  return json.response ?? [];
}

// ---------------------------------------------------------------------------
// Upsert helpers
// ---------------------------------------------------------------------------

async function upsertPrediction(supabase, fixtureId, prediction) {
  const teams = prediction?.teams ?? {};
  const pct   = prediction?.predictions?.percent ?? {};
  const advice      = prediction?.predictions?.advice ?? null;
  const homeFormRaw = teams?.home?.last_5?.form ?? null;
  const awayFormRaw = teams?.away?.last_5?.form ?? null;

  // pct values look like "45%", "30%", "25%"
  const parsePct = s => s != null ? parseFloat(String(s).replace('%', '')) : null;

  const { error } = await supabase
    .from('match_predictions_af')
    .upsert({
      fixture_id:   String(fixtureId),
      home_win_pct: parsePct(pct.home),
      draw_pct:     parsePct(pct.draw),
      away_win_pct: parsePct(pct.away),
      advice,
      home_form:    homeFormRaw,
      away_form:    awayFormRaw,
      fetched_at:   new Date().toISOString(),
    }, { onConflict: 'fixture_id' });

  if (error) throw new Error(`upsertPrediction(${fixtureId}): ${error.message}`);
}

async function upsertLineup(supabase, fixtureId, teamEntry, side) {
  const formation  = teamEntry?.formation ?? null;
  const isConfirmed = teamEntry?.startXI != null; // startXI present means confirmed
  const players = (teamEntry?.startXI ?? []).map(p => ({
    name:   p.player?.name   ?? null,
    number: p.player?.number ?? null,
    pos:    p.player?.pos    ?? null,
    grid:   p.player?.grid   ?? null,
  }));

  const { error } = await supabase
    .from('match_lineups')
    .upsert({
      fixture_id:   String(fixtureId),
      team_side:    side,
      formation,
      players,
      is_confirmed: isConfirmed,
      fetched_at:   new Date().toISOString(),
    }, { onConflict: 'fixture_id,team_side' });

  if (error) throw new Error(`upsertLineup(${fixtureId}, ${side}): ${error.message}`);
}

async function upsertMatchStats(supabase, fixtureId, teamEntry, side) {
  // Preserve the raw statistics array as-is
  const stats = teamEntry?.statistics ?? [];

  const { error } = await supabase
    .from('match_stats')
    .upsert({
      fixture_id: String(fixtureId),
      team_side:  side,
      stats,
      fetched_at: new Date().toISOString(),
    }, { onConflict: 'fixture_id,team_side' });

  if (error) throw new Error(`upsertMatchStats(${fixtureId}, ${side}): ${error.message}`);
}

// ---------------------------------------------------------------------------
// Determine match phase
// ---------------------------------------------------------------------------

function isUpcoming(match) {
  if (!match.kickoff_at) return false;
  const now   = Date.now();
  const ko    = new Date(match.kickoff_at).getTime();
  return ko > now;
}

function isRecentlyCompleted(match) {
  if (!match.kickoff_at) return false;
  const now    = Date.now();
  const ko     = new Date(match.kickoff_at).getTime();
  const minus6h = now - 6 * 60 * 60 * 1000;
  // kickoff was in the last 6h and match is completed (or we assume completed)
  return ko >= minus6h && ko <= now;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  if (!API_FOOTBALL_KEY) {
    console.log('[details] API_FOOTBALL_KEY not set — skipping');
    return;
  }

  const supabase = getSupabase();

  let matches;
  try {
    matches = await queryMatches(supabase);
  } catch (err) {
    console.error(`[details] failed to query matches: ${err.message}`);
    process.exit(1);
  }

  if (!matches.length) {
    console.log('[details] no matches to process');
    return;
  }

  console.log(`[details] processing ${matches.length} match(es)`);

  const counts = { predictions: 0, lineups: 0, stats: 0 };

  for (const match of matches) {
    const fixtureId = match.external_id;

    try {
      if (isUpcoming(match)) {
        // ── Predictions ──────────────────────────────────────────────────────
        try {
          const prediction = await fetchPredictions(fixtureId);
          await sleep(300);
          if (prediction) {
            await upsertPrediction(supabase, fixtureId, prediction);
            counts.predictions++;
          }
        } catch (err) {
          console.warn(`  [warn] predictions(${fixtureId}): ${err.message}`);
        }

        // ── Lineups ───────────────────────────────────────────────────────────
        try {
          const lineupTeams = await fetchLineups(fixtureId);
          await sleep(300);
          // lineupTeams is array of two entries: [{team:{name,id}, formation, startXI, ...}, ...]
          // Determine home vs away by position (API returns home first, then away)
          if (lineupTeams.length >= 1) {
            await upsertLineup(supabase, fixtureId, lineupTeams[0], 'home');
            counts.lineups++;
          }
          if (lineupTeams.length >= 2) {
            await upsertLineup(supabase, fixtureId, lineupTeams[1], 'away');
            counts.lineups++;
          }
        } catch (err) {
          console.warn(`  [warn] lineups(${fixtureId}): ${err.message}`);
        }
      } else if (isRecentlyCompleted(match)) {
        // ── Match stats ───────────────────────────────────────────────────────
        try {
          const statTeams = await fetchStats(fixtureId);
          await sleep(300);
          // statTeams is array of two entries: [{team:{name,id}, statistics:[...]}, ...]
          if (statTeams.length >= 1) {
            await upsertMatchStats(supabase, fixtureId, statTeams[0], 'home');
            counts.stats++;
          }
          if (statTeams.length >= 2) {
            await upsertMatchStats(supabase, fixtureId, statTeams[1], 'away');
            counts.stats++;
          }
        } catch (err) {
          console.warn(`  [warn] stats(${fixtureId}): ${err.message}`);
        }
      }
    } catch (err) {
      console.error(`  [error] match ${match.id} (fixture ${fixtureId}): ${err.message}`);
    }
  }

  console.log(`[details] predictions: ${counts.predictions}, lineups: ${counts.lineups}, stats: ${counts.stats}`);
}

main().catch(err => {
  console.error('[details] fatal:', err.message);
  process.exit(1);
});
