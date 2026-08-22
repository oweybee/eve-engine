/**
 * fetchMatchDetails.js — fetches lineups, predictions and match stats from
 * API-Football v3 and upserts into Supabase.
 *
 * Called after computeValues.js in the engine pipeline, under a 2-minute step
 * timeout, and it now stops itself before that fires.
 *
 * THE WORK LIST IS BOUNDED AT BOTH ENDS AND ORDERED BY URGENCY (22 Aug 2026).
 * It used to be bounded at one end only, which is why this script had captured
 * a confirmed XI before kickoff exactly 26 times in 1,362 rows. See
 * PAST_GRACE_HOURS below for the measurement; see fetchTeamStats.js for the
 * same bug, found in the next step down two days earlier.
 *
 * Window: scheduled/live or completed with kickoff inside [now-6h, now+48h].
 * Lineups are asked for ONLY inside the lineup window, first, and once.
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

const https             = require('https');
const { getClient }      = require('./lib/supabaseClient');
const { beginWatchdog }  = require('./lib/watchdog');

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

const API_FOOTBALL_KEY  = process.env.API_FOOTBALL_KEY;
const API_FOOTBALL_HOST = 'v3.football.api-sports.io';

// ---------------------------------------------------------------------------
// Work-list bounds
//
// THE SAME BUG WAS FOUND IN THE STEP BELOW THIS ONE ON 20 AUG 2026 AND NEVER
// CARRIED UP HERE. See the HORIZON_DAYS and BUDGET_SECONDS notes in
// fetchTeamStats.js: an unbounded work list against a 2-minute step timeout
// spends its whole budget on fixtures that do not matter and then dies before
// the ones that do.
// ---------------------------------------------------------------------------

/**
 * How far back a still-`scheduled` fixture may sit and still be asked about.
 *
 * IT USED TO BE UNBOUNDED. queryMatches asked for
 *     status in (scheduled,live) AND kickoff_at <= now()+48h
 * with NO LOWER BOUND, so every fixture the feed never settled stayed in the
 * work list for ever — 47 of them on 22 Aug 2026, the oldest kicking off
 * 23 Oct 2022. That is the same zombie cohort the board drops silently.
 *
 * They are not free, and that is the part that made this invisible.
 * API-Football happily serves the historical XI for a game played in 2022, so
 * each one is a SUCCESSFUL call writing a row nobody will ever read. On the
 * 10:49 run of 22 Aug every one of the 18 lineups written was for a fixture
 * from 2022, 2023 or 2025, while not one of the 25 fixtures kicking off inside
 * the hour got theirs. Measured over the whole table: 1,336 of 1,362 lineup
 * rows were fetched AFTER kickoff, on average 11.4 days after.
 */
const PAST_GRACE_HOURS = parseFloat(process.env.DETAILS_PAST_GRACE_HOURS || '6');

/** How far ahead to look. Predictions are the only thing useful this far out. */
const AHEAD_HOURS = parseFloat(process.env.DETAILS_AHEAD_HOURS || '48');

/**
 * The lineup window. A confirmed XI does not exist until roughly an hour
 * before kickoff, so asking for one two days out is a guaranteed empty
 * response — and before this change the budget was being spent everywhere
 * except inside the window where the call can actually succeed.
 */
const LINEUP_WINDOW_MINUTES = parseFloat(process.env.DETAILS_LINEUP_WINDOW_MINUTES || '120');

/**
 * Predictions barely move and NOTHING reads them (lib/matchIntel dropped the
 * round trip), so they are refreshed at most this often. They were re-fetched
 * on every tick for every fixture in range — 192 of them on the 10:49 run —
 * which is what consumed the budget the lineups needed.
 */
const PREDICTION_REFRESH_HOURS = parseFloat(process.env.DETAILS_PREDICTION_REFRESH_HOURS || '12');

/**
 * Wall-clock budget, seconds. MUST stay under the workflow step's
 * `timeout-minutes: 2`, for the reason fetchTeamStats.js states in as many
 * words: being killed is not the same as stopping. A killed run prints no
 * summary, so nothing records how far it got — which is exactly why a pipeline
 * that has never once captured a Premier League XI on time looked healthy.
 */
const BUDGET_SECONDS = parseFloat(process.env.DETAILS_BUDGET_SECONDS || '90');

/** A PostgREST filter is a URL; eve-engine has taken silent outages from oversized .in() lists. */
const ID_CHUNK = 60;

// ---------------------------------------------------------------------------
// Supabase
// ---------------------------------------------------------------------------

function getSupabase() {
  return getClient();
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

/**
 * The run's own deadline, in epoch ms. Set by main(); null outside a run.
 *
 * THE RETRY USED TO BE ABLE TO OUTLIVE THE STEP. A single 429 slept 60s and a
 * second slept 120s, against a `timeout-minutes: 2` — so one rate-limited call
 * guaranteed a SIGKILL, which writes nothing and prints no summary. A backoff
 * longer than the budget it is running inside is not a backoff, it is a kill
 * with extra steps.
 */
let deadlineAt = null;

function budgetRemainingMs() {
  return deadlineAt == null ? Infinity : deadlineAt - Date.now();
}

async function httpGet(path, retries = 3, baseDelayMs = 60_000) {
  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      return await httpGetOnce(path);
    } catch (err) {
      if (err.is429 && attempt < retries) {
        const wanted    = baseDelayMs * attempt;
        const remaining = budgetRemainingMs();
        // Leave a second for the caller to record what happened.
        if (remaining <= 1_000 || wanted > remaining - 1_000) {
          throw Object.assign(
            new Error(`429 and no budget left to wait (${Math.max(0, Math.round(remaining / 1000))}s)`),
            { is429: true, outOfBudget: true },
          );
        }
        console.warn(`[details] 429 on attempt ${attempt}/${retries} — waiting ${wanted / 1000}s before retry`);
        await sleep(wanted);
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
// ONE BOUNDED RANGE, ORDERED BY URGENCY. Both of the old OR branches survive
// inside [now-6h, now+48h]: a scheduled/live fixture in that span is the
// pre-match work, and a completed one is the stats work (a completed fixture
// cannot have a future kickoff, so the upper bound never bites it).
//
// The ORDER is the other half of the fix. PostgREST returns rows in whatever
// physical order it likes, so with a work list longer than the budget it was
// arbitrary which fixtures got asked — and on 22 Aug the dice landed on 2022.
// Nearest kickoff first, because a lineup that is missed is not late, it is
// gone: the XI is only news until the whistle.
// ---------------------------------------------------------------------------

async function queryMatches(supabase) {
  const now   = Date.now();
  const ahead = new Date(now + AHEAD_HOURS * 3_600_000).toISOString();
  const past  = new Date(now - PAST_GRACE_HOURS * 3_600_000).toISOString();

  const { data, error } = await supabase
    .from('matches')
    .select('id, external_id, kickoff_at, status')
    .not('external_id', 'is', null)
    .in('status', ['scheduled', 'live', 'completed'])
    .gte('kickoff_at', past)      // <- THE BOUND THAT DID NOT EXIST
    .lte('kickoff_at', ahead)
    .order('kickoff_at', { ascending: true })
    .limit(1000);

  if (error) throw new Error(`queryMatches: ${error.message}`);

  // Only numeric external_ids are valid API-Football fixture IDs
  const rows = (data ?? []).filter(m => /^\d+$/.test(m.external_id ?? ''));

  // Urgency, not chronology: anything inside the lineup window goes first,
  // because that is the only work with a deadline attached to it.
  return rows.sort((a, b) => {
    const ua = inLineupWindow(a) ? 0 : 1;
    const ub = inLineupWindow(b) ? 0 : 1;
    if (ua !== ub) return ua - ub;
    return new Date(a.kickoff_at).getTime() - new Date(b.kickoff_at).getTime();
  });
}

function chunk(arr, n) {
  const out = [];
  for (let i = 0; i < arr.length; i += n) out.push(arr.slice(i, i + n));
  return out;
}

/**
 * What we already hold, so the budget is not spent re-asking.
 *
 * A confirmed lineup is FINAL — the XI does not change once it is announced —
 * so a fixture that has one is never asked again. A prediction is refreshed on
 * a clock because it drifts, slowly, and nothing reads it.
 */
async function loadHeld(supabase, ids) {
  const predFresh  = new Set();
  const haveLineup = new Set();
  const since = new Date(Date.now() - PREDICTION_REFRESH_HOURS * 3_600_000).toISOString();

  for (const ids60 of chunk(ids, ID_CHUNK)) {
    const { data: preds } = await supabase
      .from('match_predictions').select('fixture_id')
      .in('fixture_id', ids60).gte('fetched_at', since);
    for (const r of preds ?? []) predFresh.add(String(r.fixture_id));

    const { data: lines } = await supabase
      .from('lineups').select('fixture_id')
      .in('fixture_id', ids60).eq('confirmed', true);
    for (const r of lines ?? []) haveLineup.add(String(r.fixture_id));
  }
  return { predFresh, haveLineup };
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

/**
 * Is this fixture close enough to kickoff for an XI to exist?
 *
 * Gated on the CLOCK and not on status, deliberately, and it is the one place
 * in this file that must be: production has never written `status='live'`, and
 * a fixture sits at 'scheduled' until fetchResults settles it, so a
 * status-based test would never open the window at all.
 */
function inLineupWindow(match) {
  if (!isUpcoming(match) || !match.kickoff_at) return false;
  const ko = new Date(match.kickoff_at).getTime();
  if (!Number.isFinite(ko)) return false;
  return ko - Date.now() <= LINEUP_WINDOW_MINUTES * 60_000;
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

  const startedAt = Date.now();
  const spent     = () => (Date.now() - startedAt) / 1000;
  deadlineAt      = startedAt + BUDGET_SECONDS * 1000;

  // The census is declared before the watchdog so the last-gasp reporter can
  // print it. A killed run used to print NOTHING, which is how a step that had
  // never captured an XI on time went a whole season looking healthy.
  const c = {
    predictions: 0, predSkipped: 0,
    lineupCalls: 0, lineupRows: 0, lineupEmpty: 0,
    lineupHeld: 0, lineupOutOfWindow: 0,
    stats: 0, errors: 0, unprocessed: 0, stoppedOnBudget: false,
  };
  const dog = beginWatchdog('fetchMatchDetails.js', {
    onTerminate: () => console.error(
      `[details] partial: ${c.lineupRows} lineup rows from ${c.lineupCalls} calls, ` +
      `${c.predictions} predictions, ${c.stats} stats`),
  });
  dog.stage('query');

  const supabase  = getSupabase();

  let matches;
  try {
    matches = await queryMatches(supabase);
  } catch (err) {
    console.error(`[details] failed to query matches: ${err.message}`);
    dog.finish();
    process.exit(1);
  }

  if (!matches.length) {
    console.log('[details] no matches in window');
    dog.finish();
    return;
  }

  let held = { predFresh: new Set(), haveLineup: new Set() };
  try {
    held = await loadHeld(supabase, matches.map(m => m.external_id));
  } catch (err) {
    // Degrade to re-asking rather than skipping: a failed freshness read must
    // not be indistinguishable from "we already have everything".
    console.warn(`[details] freshness read failed, will re-ask: ${err.message}`);
  }

  const windowCount = matches.filter(inLineupWindow).length;
  console.log(
    `[details] ${matches.length} in range (${windowCount} inside the ${LINEUP_WINDOW_MINUTES}m lineup window), ` +
    `budget ${BUDGET_SECONDS}s`
  );

  // AN EMPTY LINEUPS TABLE HAS FOUR CAUSES AND THEY ARE INDISTINGUISHABLE FROM
  // OUTSIDE: nothing near kickoff, already held, the API has not published the
  // XI yet, or we ran out of budget before asking. Same principle as
  // /api/inplay's `source` block — a silence that does not say which is a
  // silence somebody will read as the feed going quiet. `c` is declared above,
  // beside the watchdog that reports it on a kill.
  dog.stage('fetch');

  for (let i = 0; i < matches.length; i++) {
    if (spent() >= BUDGET_SECONDS) {
      c.stoppedOnBudget = true;
      c.unprocessed = matches.length - i;
      break;
    }

    const match     = matches[i];
    const fixtureId = match.external_id;

    if (isUpcoming(match)) {
      // ---- Lineups FIRST. This is the ordering the whole fix turns on: the
      // XI is the only thing here with a deadline, and it was queued behind a
      // prediction call for every fixture in a 48-hour range.
      if (!inLineupWindow(match)) {
        c.lineupOutOfWindow++;
      } else if (held.haveLineup.has(String(fixtureId))) {
        c.lineupHeld++;
      } else {
        try {
          const lineupTeams = await fetchLineups(fixtureId);
          c.lineupCalls++;
          await sleep(300);
          if (!lineupTeams.length) {
            c.lineupEmpty++;               // not published yet — ask again next tick
          } else {
            for (const teamEntry of lineupTeams) {
              await upsertLineup(supabase, fixtureId, teamEntry);
              c.lineupRows++;
            }
          }
        } catch (err) {
          c.errors++;
          console.warn(`  [warn] lineups(${fixtureId}): ${err.message}`);
        }
      }

      // ---- Predictions, on a refresh clock and only with budget to spare.
      if (held.predFresh.has(String(fixtureId))) {
        c.predSkipped++;
      } else if (spent() >= BUDGET_SECONDS) {
        c.predSkipped++;
      } else {
        try {
          const prediction = await fetchPredictions(fixtureId);
          await sleep(300);
          if (prediction) {
            await upsertPrediction(supabase, fixtureId, prediction);
            c.predictions++;
          }
        } catch (err) {
          c.errors++;
          console.warn(`  [warn] predictions(${fixtureId}): ${err.message}`);
        }
      }

    } else if (isRecentlyCompleted(match)) {
      try {
        const statTeams = await fetchStats(fixtureId);
        await sleep(300);
        const sides = ['home', 'away'];
        for (let j = 0; j < statTeams.length && j < 2; j++) {
          await upsertMatchStats(supabase, fixtureId, statTeams[j], sides[j]);
          c.stats++;
        }
      } catch (err) {
        c.errors++;
        console.warn(`  [warn] stats(${fixtureId}): ${err.message}`);
      }
    }
  }

  console.log(
    `[details] lineups: ${c.lineupRows} rows from ${c.lineupCalls} calls ` +
    `(${c.lineupEmpty} not published yet, ${c.lineupHeld} already held, ${c.lineupOutOfWindow} outside the window)`
  );
  console.log(
    `[details] predictions: ${c.predictions} (${c.predSkipped} still fresh), ` +
    `stats: ${c.stats}, errors: ${c.errors}, ${spent().toFixed(1)}s`
  );
  if (c.stoppedOnBudget) {
    console.log(`[details] STOPPED ON BUDGET at ${BUDGET_SECONDS}s — ${c.unprocessed} fixture(s) not reached`);
  }

  const totalCalls = c.predictions + c.lineupCalls + c.stats;
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

  dog.finish();
}

if (require.main === module) {
  main().catch(err => {
    console.error('[details] fatal:', err.message);
    process.exit(1);
  });
}

module.exports = {
  inLineupWindow, isUpcoming, isRecentlyCompleted, chunk, parsePct,
  PAST_GRACE_HOURS, AHEAD_HOURS, LINEUP_WINDOW_MINUTES,
  PREDICTION_REFRESH_HOURS, BUDGET_SECONDS, ID_CHUNK,
};
