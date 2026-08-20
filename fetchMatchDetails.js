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
const { inChunks, pageAll } = require('./lib/pagedRead');

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

/**
 * Wall-clock budget, seconds. MUST stay under the step's `timeout-minutes`,
 * because being killed is not the same as stopping.
 *
 * This ran 191 matches at ~2s each — two API calls with a 300ms sleep apiece —
 * against a 2-minute step timeout, so it was SIGKILLed every run partway
 * through. Two things live after the loop and were therefore discarded every
 * time: the summary line, so nothing recorded that it happened, and the
 * `engine_plan.details_calls_used` increment, so quota reporting has never once
 * been updated by this script. Identical to the referee-aggregate loss in
 * fetchTeamStats.
 */
const BUDGET_SECONDS = parseFloat(process.env.DETAILS_BUDGET_SECONDS || '100');

/**
 * How long each kind of detail stays fresh, in minutes.
 *
 * Without this the budget is spent re-fetching the nearest fixtures every 15
 * minutes and the rest of the window is never reached at all. The three differ
 * because the underlying data does: a predictions model barely moves, a lineup
 * changes right up to kickoff, and a finished match's stats are final.
 */
const TTL_MIN = {
  predictions: parseFloat(process.env.DETAILS_TTL_PREDICTIONS_MIN || '720'),  // 12h
  lineups:     parseFloat(process.env.DETAILS_TTL_LINEUPS_MIN     || '20'),
  stats:       Infinity,   // final once written
};

/** fixture_id → fetched_at ms, for one detail table. Paged and chunked. */
async function prefetchFreshness(supabase, table, fixtureIds) {
  const rows = await inChunks(fixtureIds, 'fixture_id', table, (chunk) => supabase
    .from(table).select('fixture_id, fetched_at').in('fixture_id', chunk));
  const map = new Map();
  for (const r of rows) {
    const t = r.fetched_at ? new Date(r.fetched_at).getTime() : NaN;
    if (!Number.isFinite(t)) continue;
    const prev = map.get(r.fixture_id);
    if (prev == null || t > prev) map.set(r.fixture_id, t);   // newest wins
  }
  return map;
}

/** Is this fixture's `kind` still inside its TTL? Absent = never fetched. */
function isFresh(map, fixtureId, kind, now) {
  const t = map.get(Number(fixtureId)) ?? map.get(String(fixtureId));
  if (t == null) return false;
  return now - t < TTL_MIN[kind] * 60_000;
}

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

  // ORDERED BY KICKOFF, and the order is the priority. Recently-completed
  // fixtures sort first (their kickoff is in the past) and they are the only
  // time-limited work here — a 6h window to collect final stats. Then upcoming
  // fixtures nearest-first, which is both the most useful order and a
  // self-healing one: a fixture 47h out that the budget never reaches today is
  // near the front tomorrow.
  //
  // Paged, because the read was unbounded. 191 rows today, under the 1,000-row
  // cap — but so was computed_values once.
  const data = await pageAll(() => supabase
    .from('matches')
    .select('id, external_id, kickoff_at, status')
    .not('external_id', 'is', null)
    .or(
      `and(status.in.(scheduled,live),kickoff_at.lte.${in48h}),` +
      `and(status.eq.completed,kickoff_at.gte.${ago6h})`
    ), 'kickoff_at', 'queryMatches');

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
      team_colors:             teamEntry?.team?.colors?.player ?? null,
      coach:                   teamEntry?.coach?.name ?? null,
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

  const started  = Date.now();
  const deadline = started + BUDGET_SECONDS * 1000;

  // Freshness in three bulk reads, not one per fixture. Without it the budget
  // is spent re-fetching the nearest fixtures every cycle and the rest of the
  // 48h window is never reached.
  const ids = matches.map(m => Number(m.external_id));
  const [predFresh, lineFresh, statFresh] = await Promise.all([
    prefetchFreshness(supabase, 'match_predictions', ids),
    prefetchFreshness(supabase, 'lineups', ids),
    prefetchFreshness(supabase, 'match_stats', ids),
  ]);

  console.log(`[details] processing ${matches.length} match(es), nearest kickoff first`);

  const counts = { predictions: 0, lineups: 0, stats: 0, errors: 0, skippedFresh: 0 };
  let processed = 0;
  let budgetStopped = false;

  for (const match of matches) {
    // STOP, DO NOT GET KILLED. The summary and the engine_plan quota update
    // below are the whole reason: a SIGKILL discards both, and has every run.
    if (Date.now() >= deadline) {
      budgetStopped = true;
      console.log(`  [budget] ${BUDGET_SECONDS}s spent — stopping after ${processed}/${matches.length} `
                + `match(es); the rest are nearest-first next run`);
      break;
    }
    processed++;

    const fixtureId = match.external_id;
    const now = Date.now();

    if (isUpcoming(match)) {
      // Predictions
      try {
        if (isFresh(predFresh, fixtureId, 'predictions', now)) {
          counts.skippedFresh++;
        } else {
        const prediction = await fetchPredictions(fixtureId);
        await sleep(300);
        if (prediction) {
          await upsertPrediction(supabase, fixtureId, prediction);
          counts.predictions++;
        }
        }
      } catch (err) {
        counts.errors++;
        console.warn(`  [warn] predictions(${fixtureId}): ${err.message}`);
      }

      // Lineups (API returns both teams in the same response)
      try {
        if (isFresh(lineFresh, fixtureId, 'lineups', now)) {
          counts.skippedFresh++;
        } else {
          const lineupTeams = await fetchLineups(fixtureId);
          await sleep(300);
          for (const teamEntry of lineupTeams) {
            await upsertLineup(supabase, fixtureId, teamEntry);
            counts.lineups++;
          }
        }
      } catch (err) {
        counts.errors++;
        console.warn(`  [warn] lineups(${fixtureId}): ${err.message}`);
      }

    } else if (isRecentlyCompleted(match)) {
      // Match stats (API returns home team first, then away)
      try {
        // Final once written — a completed match's stats never change.
        if (isFresh(statFresh, fixtureId, 'stats', now)) {
          counts.skippedFresh++;
        } else {
          const statTeams = await fetchStats(fixtureId);
          await sleep(300);
          const sides = ['home', 'away'];
          for (let i = 0; i < statTeams.length && i < 2; i++) {
            await upsertMatchStats(supabase, fixtureId, statTeams[i], sides[i]);
            counts.stats++;
          }
        }
      } catch (err) {
        counts.errors++;
        console.warn(`  [warn] stats(${fixtureId}): ${err.message}`);
      }
    }
  }

  const totalCalls = counts.predictions + counts.lineups + counts.stats;
  const secs = Math.round((Date.now() - started) / 1000);
  console.log(
    `[details] done in ${secs}s — ${processed}/${matches.length} match(es), ` +
    `predictions: ${counts.predictions}, lineups: ${counts.lineups}, ` +
    `stats: ${counts.stats}, skippedFresh: ${counts.skippedFresh}, ` +
    `api_calls: ${totalCalls}, errors: ${counts.errors}, budgetStopped: ${budgetStopped}`
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

// Only self-execute when run directly, so the pure helpers above are testable.
if (require.main === module) {
  main().catch(err => {
    console.error('[details] fatal:', err.message);
    process.exit(1);
  });
}

module.exports = { isFresh, prefetchFreshness, isUpcoming, isRecentlyCompleted, TTL_MIN, BUDGET_SECONDS };
