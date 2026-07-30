/**
 * fetchLiveStats.js — lean in-play statistics fetcher.
 *
 * WHY NOT fetchMatchDetails.js
 * That script pulls predictions + lineups + statistics (3 calls per fixture) for
 * every scheduled AND live match. On a 30-second worker loop that's both far too
 * expensive and mostly wasted: lineups and predictions don't change once a match
 * kicks off — only the statistics do.
 *
 * This fetches ONLY /fixtures/statistics, ONLY for live matches, and gates each
 * fixture behind LIVE_STATS_REFRESH_SECONDS so a fast loop doesn't re-pull data
 * that hasn't moved. In-play stats update on the order of a minute, so polling
 * faster buys nothing but quota.
 *
 * Budget: ~15 live fixtures at a 90s gate ≈ 10 calls/min ≈ 5k over a full
 * matchday — comfortable inside the 75k/day Ultra allowance alongside odds.
 *
 * Writes the raw statistics array to match_stats (fixture_id, team_side), the
 * same shape fetchMatchDetails uses, so the frontend has one contract to read.
 *
 * Usage: node fetchLiveStats.js [--dry-run]
 */
'use strict';

const https = require('https');
const { getClient } = require('./lib/supabaseClient');

const API_KEY = process.env.API_FOOTBALL_KEY;
const DRY = process.argv.includes('--dry-run');
const REFRESH_SECONDS = parseInt(process.env.LIVE_STATS_REFRESH_SECONDS || '90', 10);
const MAX_FIXTURES = parseInt(process.env.LIVE_STATS_MAX_FIXTURES || '30', 10);

function httpGet(path) {
  return new Promise((resolve, reject) => {
    https.get({
      host: 'v3.football.api-sports.io', path,
      headers: { 'x-apisports-key': API_KEY },
    }, res => {
      let body = '';
      res.on('data', d => (body += d));
      res.on('end', () => {
        if (res.statusCode >= 400) return reject(new Error(`API ${res.statusCode}: ${body.slice(0, 120)}`));
        try { resolve(JSON.parse(body)); } catch (e) { reject(new Error(`bad JSON: ${e.message}`)); }
      });
    }).on('error', reject);
  });
}

/** Live matches, oldest-stats-first so a capped run refreshes the stalest. */
async function fetchLiveMatches(supabase) {
  const { data, error } = await supabase
    .from('matches')
    .select('id, external_id, minute, goals_home, goals_away')
    .eq('status', 'live')
    .not('external_id', 'is', null);
  if (error) throw new Error(`liveStats[matches]: ${error.message}`);
  return data ?? [];
}

/** When each fixture's stats were last written, so we can skip fresh ones. */
async function lastFetched(supabase, fixtureIds) {
  if (!fixtureIds.length) return new Map();
  const { data, error } = await supabase
    .from('match_stats')
    .select('fixture_id, fetched_at')
    .in('fixture_id', fixtureIds);
  if (error) throw new Error(`liveStats[last]: ${error.message}`);
  const m = new Map();
  for (const r of data ?? []) {
    const t = new Date(r.fetched_at).getTime();
    const prev = m.get(r.fixture_id);
    if (!prev || t > prev) m.set(r.fixture_id, t);
  }
  return m;
}

async function upsertStats(supabase, fixtureId, teamEntry, side) {
  const { error } = await supabase
    .from('match_stats')
    .upsert({
      fixture_id: String(fixtureId),
      team_side: side,
      stats: teamEntry?.statistics ?? [],
      fetched_at: new Date().toISOString(),
    }, { onConflict: 'fixture_id,team_side' });
  if (error) throw new Error(`liveStats[upsert ${fixtureId}/${side}]: ${error.message}`);
}

async function run() {
  if (!API_KEY) { console.log('[liveStats] API_FOOTBALL_KEY not set — skipping'); return 0; }
  const supabase = getClient();
  const live = await fetchLiveMatches(supabase);
  if (!live.length) { console.log('[liveStats] no live matches'); return 0; }

  const ids = live.map(m => String(m.external_id));
  const last = await lastFetched(supabase, ids);
  const now = Date.now();

  // Only fixtures whose stats are stale, stalest first, capped per run.
  const due = live
    .map(m => ({ ...m, age: now - (last.get(String(m.external_id)) ?? 0) }))
    .filter(m => m.age >= REFRESH_SECONDS * 1000)
    .sort((a, b) => b.age - a.age)
    .slice(0, MAX_FIXTURES);

  console.log(`[liveStats] live=${live.length} due=${due.length} ` +
              `(gate ${REFRESH_SECONDS}s, cap ${MAX_FIXTURES})`);
  if (!due.length) return 0;

  let updated = 0, errors = 0;
  for (const m of due) {
    try {
      const json = await httpGet(`/fixtures/statistics?fixture=${m.external_id}`);
      const teams = json.response ?? [];
      if (!teams.length) continue;
      if (DRY) {
        const kinds = (teams[0].statistics ?? []).map(s => s.type).slice(0, 8);
        console.log(`  [dry] ${m.external_id}: ${teams.length} team(s), stats: ${kinds.join(', ')}`);
        continue;
      }
      // API order is [home, away]
      await upsertStats(supabase, m.external_id, teams[0], 'home');
      if (teams[1]) await upsertStats(supabase, m.external_id, teams[1], 'away');
      updated++;
    } catch (e) {
      errors++;
      console.log(`  warn ${m.external_id}: ${e.message}`);
      if (/429|quota/i.test(e.message)) break;   // stop on rate limit, don't hammer
    }
  }
  console.log(`[liveStats] updated=${updated} errors=${errors}`);
  return updated;
}

if (require.main === module) {
  run().catch(err => { console.error('[liveStats] FATAL:', err.message); process.exit(1); });
}

module.exports = { run };
