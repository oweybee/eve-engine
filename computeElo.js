'use strict';

/**
 * computeElo.js — rebuild the team_elo ladder from completed match history.
 *
 * Walks every completed fixture in chronological (kickoff) order and applies the
 * same ELO update the supermodel was trained on (lib/elo.js: K=30, home-adv=80,
 * default 1500), then upserts the final rating + games-played per team into
 * team_elo. Idempotent: a full recompute each run keeps ratings correct after
 * back-fills or out-of-order settlement.
 *
 * Runs after fetchResults.js (which flips finished matches to 'completed' and
 * writes their result), so newly settled games fold into the ladder next run.
 *
 * READS `elo_corpus`, NOT `matches`. The same real fixture arrives under three
 * id namespaces (a historical datahub import, API-Football, Betfair) and
 * `matches` upserts on external_id, so 6.6% of completed rows were the same
 * game twice and every one of them applied its ELO update twice. The view also
 * merges clubs the feeds spell differently — "Tottenham Hotspur" and
 * "Tottenham" were two ladder entries. See migration 076.
 *
 * Required: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY.
 * Usage: node computeElo.js [--dry-run]
 */

const { getClient } = require('./lib/supabaseClient');
const { ELO_DEFAULT, updatePair } = require('./lib/elo');
const { teamKey } = require('./lib/teamKey');

const DRY_RUN = process.argv.includes('--dry-run');
const FORCE   = process.argv.includes('--force');
// Self-gate so the active 5-min engine pipeline doesn't fully rebuild the ladder
// every tick. ELO only changes when results settle, so a few hours is ample;
// in-play reads a pre-match snapshot anyway. Mirrors fetchTeamStats' self-cache.
const ELO_REFRESH_HOURS = parseFloat(process.env.ELO_REFRESH_HOURS || '6');

const RESULT_CODE = { home: 'H', draw: 'D', away: 'A' };
const PAGE_SIZE = 1000; // PostgREST hard caps responses; page past it.

async function fetchCompletedMatches(supabase, from = 0) {
  const { data, error } = await supabase
    // NOT `matches` — that table holds 6,104 duplicate completed fixtures
    // (6.6%), each of which applied its rating update twice, and splits ~57
    // clubs across two rows apiece. `elo_corpus` (migration 076) is the same
    // history deduplicated with club identities merged.
    .from('elo_corpus')
    .select('id, kickoff_at, result, home_key, away_key')
    // Chronological order is REQUIRED for ELO correctness — ratings flow forward
    // in time. id breaks ties so pagination is stable.
    .order('kickoff_at', { ascending: true })
    .order('id', { ascending: true })
    .range(from, from + PAGE_SIZE - 1);
  if (error) throw new Error(`fetchCompletedMatches: ${error.message}`);
  return data ?? [];
}

/**
 * Fetch ALL completed matches, paging past PostgREST's default 1000-row cap —
 * otherwise ELO is built from only the oldest 1000 fixtures (silently wrong).
 */
async function fetchAllCompletedMatches(supabase) {
  const all = [];
  for (let from = 0; ; from += PAGE_SIZE) {
    const page = await fetchCompletedMatches(supabase, from);
    all.push(...page);
    if (page.length < PAGE_SIZE) break;
  }
  return all;
}

/**
 * Fold a chronological list of completed matches into a ratings map.
 * Pure (no I/O) so it is unit-testable.
 *
 * @returns {Map<string, {team_name:string, elo:number, games:number}>}
 */
function buildLadder(matches) {
  const ladder = new Map();
  const get = (key) => {
    let r = ladder.get(key);
    if (!r) { r = { team_name: key, elo: ELO_DEFAULT, games: 0 }; ladder.set(key, r); }
    return r;
  };

  for (const m of matches) {
    const code = RESULT_CODE[m.result];
    if (!code) continue;
    // elo_corpus already emits the canonical key; teamKey() is applied anyway
    // so buildLadder stays a pure function of whatever rows it is handed and
    // the unit tests can drive it with plain names.
    const hKey = m.home_key ?? teamKey(m.home_team?.name);
    const aKey = m.away_key ?? teamKey(m.away_team?.name);
    if (!hKey || !aKey) continue;

    const h = get(hKey);
    const a = get(aKey);
    const next = updatePair(h.elo, a.elo, code);
    h.elo = next.home; a.elo = next.away;
    h.games += 1; a.games += 1;
  }
  return ladder;
}

async function run() {
  console.log(`\n[elo] ${new Date().toISOString()}${DRY_RUN ? ' [DRY RUN]' : ''}`);
  const supabase = getClient();

  // Freshness gate: skip the full recompute if the ladder was refreshed recently.
  if (!FORCE && !DRY_RUN && ELO_REFRESH_HOURS > 0) {
    const { data: last } = await supabase
      .from('team_elo')
      .select('updated_at')
      .order('updated_at', { ascending: false })
      .limit(1);
    const ts = last?.[0]?.updated_at ? new Date(last[0].updated_at).getTime() : 0;
    const ageH = (Date.now() - ts) / 3_600_000;
    if (ts && ageH < ELO_REFRESH_HOURS) {
      console.log(`[elo] ladder fresh (${ageH.toFixed(1)}h < ${ELO_REFRESH_HOURS}h) — skipping`);
      return;
    }
  }

  const matches = await fetchAllCompletedMatches(supabase);
  console.log(`[elo] ${matches.length} completed match(es) in history`);

  const ladder = buildLadder(matches);
  console.log(`[elo] ${ladder.size} team(s) rated`);

  if (!ladder.size) return;

  const rows = [...ladder.values()].map(r => ({
    team_name:  r.team_name,
    elo:        +r.elo.toFixed(2),
    games:      r.games,
    updated_at: new Date().toISOString(),
  }));

  if (DRY_RUN) {
    const top = [...rows].sort((a, b) => b.elo - a.elo).slice(0, 5);
    console.log('[elo] top 5:', top.map(r => `${r.team_name}=${r.elo}(${r.games})`).join(', '));
    return;
  }

  const { error } = await supabase
    .from('team_elo')
    .upsert(rows, { onConflict: 'team_name' });
  if (error) throw new Error(`team_elo upsert: ${error.message}`);

  // Upsert alone never removes a key, so a club that changes spelling — or that
  // the alias table has just merged away — leaves its old rating behind
  // forever. Those orphans are not read by name, but they inflate every count
  // taken over this table, which is how the ladder looked bigger and less
  // mature than it was. team_elo is wholly derived from the corpus, so pruning
  // is safe: the next run rebuilds anything wrongly dropped.
  const live = rows.map(r => r.team_name);
  const { data: stale, error: staleErr } = await supabase
    .from('team_elo')
    .select('team_name')
    .not('team_name', 'in', `(${live.map(n => `"${n.replace(/"/g, '""')}"`).join(',')})`);
  if (staleErr) {
    console.warn(`[elo] could not check for stale rows: ${staleErr.message}`);
  } else if (stale?.length) {
    const { error: delErr } = await supabase
      .from('team_elo').delete().in('team_name', stale.map(r => r.team_name));
    if (delErr) console.warn(`[elo] could not prune stale rows: ${delErr.message}`);
    else console.log(`[elo] pruned ${stale.length} stale rating(s)`);
  }

  console.log(`[elo] upserted ${rows.length} rating(s)`);
}

if (require.main === module) {
  run().catch(err => { console.error('[elo] fatal:', err.message); process.exit(1); });
}

module.exports = { run, buildLadder };
