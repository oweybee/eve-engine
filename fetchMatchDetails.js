/**
 * fetchMatchDetails.js — fetches lineups, predictions and match stats from
 * API-Football v3 and upserts into Supabase.
 *
 * Called after computeValues.js in the engine pipeline.
 * Safe to call every 15 min — only fetches for matches within 48h (predictions/
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
//
// Two OR branches, both explicit and(...):
//   1. Upcoming/live: status IN (scheduled, live) AND kickoff within next 48h
//   2. Recently completed: status=completed AND kickoff within last 6h (stats)
//
// 48h window ensures June 27-28 fixtures (once they receive numeric
// external_ids from planDay.js) are captured in the same tick.
// ---------------------------------------------------------------------------

async function queryMatches(supabase) {
  const now   = new Date();
  const in48h = new Date(now.getTime() + 48 * 60 * 60 * 1000).toISOString();
  const ago6h = new Date(now.getTime() -  6 * 60 * 60 * 1000).toISOString();

  const { data, error } = await supabase
    .from('matches')
    .select('id, external_id, kickoff_at, status')
    .not('external_id', 'is', null)
    .or(
      `and(status.in.(scheduled,live),kickoff_at.lte.${in48h}),` +
      `and(status.eq.completed,kickoff_at.gte.${ago6h})`
    );

  if (error) throw new Error(`queryMatches: ${error.message}`);
  // Only numeric external_ids are valid API-Football fixture IDs
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
// Probability parsing
//
// API-Football returns percent values as strings like "55%", "25%", "20%".
// Strip the % sign, parse as float, divide by 100, store as decimal string
// (e.g. "0.5500") to match the TEXT column type in match_predictions.
// ---------------------------------------------------------------------------

function parsePct(raw) {
  if (raw == null) return null;
  const n = parseFloat(String(raw).replace('%', '').trim());
  return Number.isFinite(n) ? String((n / 100).toFixed(4)) : null;
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
      winner_team:             preds?.winner?.name    ?? null,
      winner_comment:          preds?.winner?.comment ?? null,
      under_over:              preds?.under_over ?? null,
      goals_home:              String(preds?.goals?.home ?? ''),
      goals_away:              String(preds?.goals?.away ?? ''),
      advice:                  preds?.advice ?? null,
      pct_home:                parsePct(pct.home),
      pct_draw:                parsePct(pct.draw),
      pct_away:                parsePct(pct.away),
      fetched_at:              new Date().toISOString(),
    }, { onConflict: 'fixture_id' });

  if (error) throw new Error(`upsertPrediction(${fixtureId}): ${error.message}`);
}

async function upsertLineup(supabase, fixtureId, teamEntry) {
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
//
// Gate on DB status rather than wall-clock kickoff_at: our DB can have
// matches stuck as 'scheduled' past their nominal kickoff time until
// fetchResults.js settles them, so a clock-based check would silently
// skip valid pre/in-match fetch windows.
// ---------------------------------------------------------------------------

function isUpcoming(match) {
  return match.status === 'scheduled' || match.status === 'live';
}

function isRecentlyCompleted(match) {
  if (match.status !== 'completed' || !match.kickoff_at) return false;
  const ko = new Date(match.kickoff_at).getTime();
  return ko >= Date.now() - 6 * 60 * 60 * 1000;
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

  const counts = { predictions: 0, lineups: 0, stats: 0, errors: 0 };

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
        counts.errors++;
        console.warn(`  [warn] predictions(${fixtureId}): ${err.message}`);
      }

      // Lineups (API returns both teams in the same response)
      try {
        const lineupTeams = await fetchLineups(fixtureId);
        await sleep(300);
        for (const teamEntry of lineupTeams) {
          await upsertLineup(supabase, fixtureId, teamEntry);
          counts.lineups++;
        }
      } catch (err) {
        counts.errors++;
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
        counts.errors++;
        console.warn(`  [warn] stats(${fixtureId}): ${err.message}`);
      }
    }
  }

  const totalCalls = counts.predictions + counts.lineups + counts.stats;
  console.log(
    `[details] predictions: ${counts.predictions}, lineups: ${counts.lineups}, ` +
    `stats: ${counts.stats}, api_calls: ${totalCalls}, errors: ${counts.errors}`
  );

  // Increment details_calls_used in today's engine_plan for quota reporting
  if (totalCalls > 0) {
    const today = new Date().toISOString().slice(0, 10);
    const { data: plan } = await supabase
      .from('engine_plan').select('details_calls_used').eq('date', today).maybeSingle();
    if (plan != null) {
      await supabase.from('engine_plan')
        .update({ details_calls_used: (plan.details_calls_used ?? 0) + totalCalls })
        .eq('date', today);
    }
  }
}

main().catch(err => {
  console.error('[details] fatal:', err.message);
  process.exit(1);
});
