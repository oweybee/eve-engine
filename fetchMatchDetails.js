/**
 * fetchMatchDetails.js — fetches lineups, predictions and match stats from
 * API-Football v3 and upserts into Supabase.
 *
 * Called after computeValues.js in the engine pipeline.
 * Safe to call every 15 min — only fetches for matches within 24h (predictions/
 * lineups) or completed within the last 6h (stats).
 *
 * Endpoints used (all included in Ultra plan):
 *   GET /predictions?fixture={id}       — AI win probability + advice
 *   GET /fixtures/lineups?fixture={id}  — confirmed starting XI (~H-1)
 *   GET /fixtures/statistics?fixture={id} — match stats (post-kickoff)
 *
 * Tables written:
 *   match_predictions  — advice, pct_home/draw/away, winner, goals
 *   lineups            — team_id, team_name, formation, starting_xi, substitutes
 *   match_stats        — fixture_id, team_side, stats (jsonb array)
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

async function queryMatches(supabase) {
  const now   = new Date();
  const in24h = new Date(now.getTime() + 24 * 60 * 60 * 1000).toISOString();
  const ago6h = new Date(now.getTime() - 6  * 60 * 60 * 1000).toISOString();

  const { data, error } = await supabase
    .from('matches')
    .select('id, external_id, kickoff_at, status')
    .neq('status', 'cancelled')
    .not('external_id', 'is', null)
    .or(`kickoff_at.lte.${in24h},and(status.eq.completed,kickoff_at.gte.${ago6h})`);

  if (error) throw new Error(`queryMatches: ${error.message}`);
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
// Upsert helpers — aligned with actual Supabase table schemas
// ---------------------------------------------------------------------------

async function upsertPrediction(supabase, fixtureId, prediction) {
  const preds = prediction?.predictions ?? {};
  const pct   = preds?.percent ?? {};

  const { error } = await supabase
    .from('match_predictions')
    .upsert({
      fixture_id:              String(fixtureId),
      api_football_fixture_id: parseInt(fixtureId, 10),
      winner_team:             preds?.winner?.name  ?? null,
      winner_comment:          preds?.winner?.comment ?? null,
      under_over:              preds?.under_over ?? null,
      goals_home:              String(preds?.goals?.home ?? ''),
      goals_away:              String(preds?.goals?.away ?? ''),
      advice:                  preds?.advice ?? null,
      pct_home:                pct.home ?? null,
      pct_draw:                pct.draw ?? null,
      pct_away:                pct.away ?? null,
      fetched_at:              new Date().toISOString(),
    }, { onConflict: 'fixture_id' });

  if (error) throw new Error(`upsertPrediction(${fixtureId}): ${error.message}`);
}

async function upsertLineup(supabase, fixtureId, teamEntry) {
  // teamEntry shape from API-Football:
  // { team: {id, name}, formation, startXI: [{player:{id,name,number,pos,grid}},...], substitutes: [...] }
  const teamId   = teamEntry?.team?.id   ?? null;
  const teamName = teamEntry?.team?.name ?? null;
  if (!teamId) return;

  const { error } = await supabase
    .from('lineups')
    .upsert({
      fixture_id:              String(fixtureId),
      api_football_fixture_id: parseInt(fixtureId, 10),
      team_id:                 teamId,
      team_name:               teamName,
      formation:               teamEntry?.formation ?? null,
      starting_xi:             teamEntry?.startXI   ?? [],
      substitutes:             teamEntry?.substitutes ?? [],
      confirmed:               (teamEntry?.startXI?.length ?? 0) > 0,
      fetched_at:              new Date().toISOString(),
    }, { onConflict: 'fixture_id,team_id' });

  if (error) throw new Error(`upsertLineup(${fixtureId}, team=${teamId}): ${error.message}`);
}

async function upsertMatchStats(supabase, fixtureId, teamEntry, side) {
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
// Match phase helpers
// ---------------------------------------------------------------------------

function isUpcoming(match) {
  return !!match.kickoff_at && new Date(match.kickoff_at).getTime() > Date.now();
}

function isRecentlyCompleted(match) {
  if (!match.kickoff_at) return false;
  const ko  = new Date(match.kickoff_at).getTime();
  const now = Date.now();
  return ko >= now - 6 * 60 * 60 * 1000 && ko <= now;
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

    if (isUpcoming(match)) {
      // Predictions
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

      // Lineups (API returns home team first, then away — both in the same response)
      try {
        const lineupTeams = await fetchLineups(fixtureId);
        await sleep(300);
        for (const teamEntry of lineupTeams) {
          await upsertLineup(supabase, fixtureId, teamEntry);
          counts.lineups++;
        }
      } catch (err) {
        console.warn(`  [warn] lineups(${fixtureId}): ${err.message}`);
      }
    } else if (isRecentlyCompleted(match)) {
      // Match stats (API returns home team first, then away)
      try {
        const statTeams = await fetchStats(fixtureId);
        await sleep(300);
        const sides = ['home', 'away'];
        for (let i = 0; i < statTeams.length && i < 2; i++) {
          await upsertMatchStats(supabase, fixtureId, statTeams[i], sides[i]);
          counts.stats++;
        }
      } catch (err) {
        console.warn(`  [warn] stats(${fixtureId}): ${err.message}`);
      }
    }
  }

  console.log(`[details] predictions: ${counts.predictions}, lineups: ${counts.lineups}, stats: ${counts.stats}`);
}

main().catch(err => {
  console.error('[details] fatal:', err.message);
  process.exit(1);
});
