'use strict';

/**
 * computeElo.js — rebuild the team_elo ladder from completed match history.
 *
 * Walks every completed match in chronological (kickoff) order and applies the
 * same ELO update the supermodel was trained on (lib/elo.js: K=30, home-adv=80,
 * default 1500), then upserts the final rating + games-played per team into
 * team_elo. Idempotent: a full recompute each run keeps ratings correct after
 * back-fills or out-of-order settlement.
 *
 * Runs after fetchResults.js (which flips finished matches to 'completed' and
 * writes their result), so newly settled games fold into the ladder next run.
 *
 * Required: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY.
 * Usage: node computeElo.js [--dry-run]
 */

const { getClient } = require('./lib/supabaseClient');
const { ELO_DEFAULT, updatePair } = require('./lib/elo');

const DRY_RUN = process.argv.includes('--dry-run');
const FORCE   = process.argv.includes('--force');
// Self-gate so the active 5-min engine pipeline doesn't fully rebuild the ladder
// every tick. ELO only changes when results settle, so a few hours is ample;
// in-play reads a pre-match snapshot anyway. Mirrors fetchTeamStats' self-cache.
const ELO_REFRESH_HOURS = parseFloat(process.env.ELO_REFRESH_HOURS || '6');

/** Same normalisation key as fetchStatsLookups / halftimeFeatures. */
const normTeam = s => (s ?? '').toLowerCase().replace(/[^a-z0-9]/g, '');

const RESULT_CODE = { home: 'H', draw: 'D', away: 'A' };

async function fetchCompletedMatches(supabase) {
  const { data, error } = await supabase
    .from('matches')
    .select(`
      id, kickoff_at, result,
      home_team:teams!matches_home_team_id_fkey ( id, name ),
      away_team:teams!matches_away_team_id_fkey ( id, name )
    `)
    .eq('status', 'completed')
    .in('result', ['home', 'draw', 'away'])
    .order('kickoff_at', { ascending: true });
  if (error) throw new Error(`fetchCompletedMatches: ${error.message}`);
  return data ?? [];
}

/**
 * Fold a chronological list of completed matches into a ratings map.
 * Pure (no I/O) so it is unit-testable.
 *
 * @returns {Map<string, {team_id:number|null, team_name:string, elo:number, games:number}>}
 */
function buildLadder(matches) {
  const ladder = new Map();
  const get = (key, name, id) => {
    let r = ladder.get(key);
    if (!r) { r = { team_id: id ?? null, team_name: key, elo: ELO_DEFAULT, games: 0 }; ladder.set(key, r); }
    if (id != null && r.team_id == null) r.team_id = id;
    return r;
  };

  for (const m of matches) {
    const code = RESULT_CODE[m.result];
    if (!code) continue;
    const hKey = normTeam(m.home_team?.name);
    const aKey = normTeam(m.away_team?.name);
    if (!hKey || !aKey) continue;

    const h = get(hKey, hKey, m.home_team?.id);
    const a = get(aKey, aKey, m.away_team?.id);
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

  const matches = await fetchCompletedMatches(supabase);
  console.log(`[elo] ${matches.length} completed match(es) in history`);

  const ladder = buildLadder(matches);
  console.log(`[elo] ${ladder.size} team(s) rated`);

  if (!ladder.size) return;

  const rows = [...ladder.values()].map(r => ({
    team_id:    r.team_id,
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

  console.log(`[elo] upserted ${rows.length} rating(s)`);
}

if (require.main === module) {
  run().catch(err => { console.error('[elo] fatal:', err.message); process.exit(1); });
}

module.exports = { run, buildLadder };
