'use strict';

/**
 * fetchTeamStats.js — per-team rolling form & market inputs from API-Football.
 *
 * Drives the match-detail "Team Stats" panel AND the data-driven corners/cards
 * models. Built on the team's last-N fixtures across ALL competitions so it
 * mirrors the "All Competitions (last 10)" view:
 *
 *   GET /fixtures?team={id}&last={N}      → results, goals, referee per match
 *   GET /fixtures/statistics?fixture={f}  → corners, expected_goals, cards
 *
 * Aggregates to: form, clean-sheet %, failed-to-score %, avg goals for/against,
 * avg xG for/against, avg corners for/against, avg cards, avg booking points
 * (10·yellow + 25·red). Referee card rates are accumulated from the same fixtures.
 *
 * Cached: a team is re-fetched at most once per REFRESH_HOURS to stay well inside
 * the API budget (~11 calls/team). Stats inputs only move match-to-match.
 *
 * Required env: API_FOOTBALL_KEY, SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY
 * Usage: node fetchTeamStats.js [--dry-run]
 */

const https         = require('https');
const { getClient } = require('./lib/supabaseClient');

const API_FOOTBALL_KEY = process.env.API_FOOTBALL_KEY;
const API_HOST         = 'v3.football.api-sports.io';
const DRY_RUN          = process.argv.includes('--dry-run');
const LAST_N           = parseInt(process.env.TEAM_STATS_LAST_N || '10', 10);
const REFRESH_HOURS    = parseFloat(process.env.TEAM_STATS_REFRESH_HOURS || '20');

const YELLOW_POINTS = 10;   // Betfair booking-points convention
const RED_POINTS    = 25;

// ── HTTP ─────────────────────────────────────────────────────────────────────
function httpGet(path) {
  if (!API_FOOTBALL_KEY) throw new Error('API_FOOTBALL_KEY not set');
  return new Promise((resolve, reject) => {
    https.request({ method: 'GET', hostname: API_HOST, path, headers: { 'x-apisports-key': API_FOOTBALL_KEY } },
      res => {
        let body = '';
        res.on('data', c => { body += c; });
        res.on('end', () => {
          if (res.statusCode !== 200) return reject(new Error(`HTTP ${res.statusCode}: ${body.slice(0, 200)}`));
          try { resolve(JSON.parse(body)); } catch (e) { reject(new Error(`JSON parse: ${e.message}`)); }
        });
      }).on('error', reject).end();
  });
}

// ── Pure parsing / aggregation (unit-tested) ─────────────────────────────────

/** Reads one /fixtures item from the target team's perspective. */
function parseFixtureResult(fx, teamId) {
  const homeId = fx?.teams?.home?.id;
  const awayId = fx?.teams?.away?.id;
  const isHome = homeId === teamId;
  if (!isHome && awayId !== teamId) return null;

  const gf = isHome ? fx?.goals?.home : fx?.goals?.away;
  const ga = isHome ? fx?.goals?.away : fx?.goals?.home;
  if (gf == null || ga == null) return null;   // unplayed / abandoned

  return {
    fixtureId:     fx?.fixture?.id,
    result:        gf > ga ? 'W' : gf < ga ? 'L' : 'D',
    gf, ga,
    cleanSheet:    ga === 0,
    failedToScore: gf === 0,
    referee:       fx?.fixture?.referee ?? null,
  };
}

/** Pulls a numeric stat value by type label from a /fixtures/statistics team block. */
function statValue(statsArr, type) {
  const row = (statsArr ?? []).find(s => String(s.type).toLowerCase() === type.toLowerCase());
  if (!row || row.value == null) return null;
  const n = parseFloat(String(row.value).replace('%', ''));
  return Number.isFinite(n) ? n : null;
}

/** Extracts the target team's for/against stats from a /fixtures/statistics response. */
function extractFixtureStats(statsResponse, teamId) {
  const teamBlock = (statsResponse ?? []).find(b => b?.team?.id === teamId);
  const oppBlock  = (statsResponse ?? []).find(b => b?.team?.id !== teamId);
  if (!teamBlock) return null;
  return {
    corners_for:     statValue(teamBlock.statistics, 'Corner Kicks'),
    corners_against: oppBlock ? statValue(oppBlock.statistics, 'Corner Kicks') : null,
    xg_for:          statValue(teamBlock.statistics, 'expected_goals'),
    xg_against:      oppBlock ? statValue(oppBlock.statistics, 'expected_goals') : null,
    yellow:          statValue(teamBlock.statistics, 'Yellow Cards'),
    red:             statValue(teamBlock.statistics, 'Red Cards'),
  };
}

/** Mean of the finite values in an array, or null if none. */
function avg(values) {
  const v = values.filter(x => Number.isFinite(x));
  return v.length ? v.reduce((a, b) => a + b, 0) / v.length : null;
}
const round2 = x => (x == null ? null : Math.round(x * 100) / 100);

/**
 * Aggregate a team's last-N fixtures (+ their per-fixture stats) into a
 * team_statistics row.
 * @param {object[]} results  parseFixtureResult outputs (newest first)
 * @param {object[]} fxStats  extractFixtureStats outputs, aligned to results
 */
function aggregateTeamStats(results, fxStats) {
  const played = results.length;
  if (!played) return null;

  const cards = fxStats.map(s => (s ? (s.yellow ?? 0) + (s.red ?? 0) : null));
  const bookingPts = fxStats.map(s => (s ? (s.yellow ?? 0) * YELLOW_POINTS + (s.red ?? 0) * RED_POINTS : null));

  return {
    scope:               `last${played}`,
    form:                results.map(r => r.result).join(''),
    played,
    clean_sheet_pct:     round2((results.filter(r => r.cleanSheet).length / played) * 100),
    failed_to_score_pct: round2((results.filter(r => r.failedToScore).length / played) * 100),
    goals_for_avg:       round2(avg(results.map(r => r.gf))),
    goals_against_avg:   round2(avg(results.map(r => r.ga))),
    xg_for_avg:          round2(avg(fxStats.map(s => s?.xg_for))),
    xg_against_avg:      round2(avg(fxStats.map(s => s?.xg_against))),
    corners_for_avg:     round2(avg(fxStats.map(s => s?.corners_for))),
    corners_against_avg: round2(avg(fxStats.map(s => s?.corners_against))),
    cards_avg:           round2(avg(cards)),
    booking_points_avg:  round2(avg(bookingPts)),
  };
}

// ── Orchestration ────────────────────────────────────────────────────────────

/**
 * Resolve API-Football team ids (and the referee) for upcoming matches from the
 * fixture endpoint — works days ahead, before lineups are confirmed. Betfair-
 * created matches (external_id like 'bf_123') are skipped; their API twin is
 * resolved via its numeric fixture id.
 * @returns {Promise<Map<number, string>>} teamId → teamName
 */
async function resolveUpcomingTeams(supabase) {
  const { data, error } = await supabase
    .from('matches').select('id, external_id, status').in('status', ['scheduled', 'live']);
  if (error) throw new Error(`resolveUpcomingTeams: ${error.message}`);

  const teams = new Map();
  for (const m of data ?? []) {
    if (!m.external_id || !/^\d+$/.test(String(m.external_id))) continue;   // skip bf_* etc.
    try {
      const j  = await httpGet(`/fixtures?id=${m.external_id}`);
      const fx = j.response?.[0];
      if (!fx) continue;
      const ref = fx.fixture?.referee ?? null;
      if (ref && !DRY_RUN) await supabase.from('matches').update({ referee: ref }).eq('id', m.id);
      for (const side of ['home', 'away']) {
        const t = fx.teams?.[side];
        if (t?.id) teams.set(t.id, t.name ?? null);
      }
      await sleep(120);
    } catch (e) { console.warn(`  [warn] resolve fixture ${m.external_id}: ${e.message}`); }
  }
  return teams;
}

async function isFresh(supabase, teamId) {
  const { data } = await supabase
    .from('team_statistics').select('updated_at').eq('team_id', teamId).maybeSingle();
  if (!data?.updated_at) return false;
  return Date.now() - new Date(data.updated_at).getTime() < REFRESH_HOURS * 3_600_000;
}

async function fetchTeamWindow(teamId) {
  const fxJson = await httpGet(`/fixtures?team=${teamId}&last=${LAST_N}`);
  const fixtures = fxJson.response ?? [];

  const results = [];
  const fxStats = [];
  const refereeTally = new Map();   // referee → {cards, bp, n}

  for (const fx of fixtures) {
    const r = parseFixtureResult(fx, teamId);
    if (!r) continue;

    let stats = null;
    try {
      const sJson = await httpGet(`/fixtures/statistics?fixture=${r.fixtureId}`);
      stats = extractFixtureStats(sJson.response, teamId);
    } catch (e) {
      console.warn(`    [warn] stats(${r.fixtureId}): ${e.message}`);
    }
    results.push(r);
    fxStats.push(stats);

    if (r.referee && stats) {
      const cards = (stats.yellow ?? 0) + (stats.red ?? 0);
      const bp    = (stats.yellow ?? 0) * YELLOW_POINTS + (stats.red ?? 0) * RED_POINTS;
      const t = refereeTally.get(r.referee) ?? { cards: 0, bp: 0, n: 0 };
      t.cards += cards; t.bp += bp; t.n += 1;
      refereeTally.set(r.referee, t);
    }
    await sleep(120);
  }

  return { results, fxStats, refereeTally };
}

async function main() {
  if (!API_FOOTBALL_KEY) { console.log('[teamstats] API_FOOTBALL_KEY not set — skipping'); return; }
  const supabase = getClient();

  const teams = await resolveUpcomingTeams(supabase);
  if (!teams.size) { console.log('[teamstats] no upcoming team ids resolved'); return; }

  const summary = { teams: 0, skippedFresh: 0, refsUpdated: 0, errors: 0 };
  const refereeAgg = new Map();

  for (const [teamId, teamName] of teams) {
    try {
      if (!DRY_RUN && await isFresh(supabase, teamId)) { summary.skippedFresh++; continue; }

      const { results, fxStats, refereeTally } = await fetchTeamWindow(teamId);
      const agg = aggregateTeamStats(results, fxStats);
      if (!agg) { console.log(`  [skip] team ${teamId} — no completed fixtures`); continue; }

      for (const [ref, t] of refereeTally) {
        const a = refereeAgg.get(ref) ?? { cards: 0, bp: 0, n: 0 };
        a.cards += t.cards; a.bp += t.bp; a.n += t.n;
        refereeAgg.set(ref, a);
      }

      const row = { team_id: teamId, team_name: teamName, ...agg, raw: { results, fxStats }, updated_at: new Date().toISOString() };
      if (DRY_RUN) { console.log(`  [dry] ${teamName ?? teamId}:`, JSON.stringify(agg)); }
      else {
        const { error } = await supabase.from('team_statistics').upsert(row, { onConflict: 'team_id' });
        if (error) throw new Error(error.message);
      }
      summary.teams++;
      console.log(`  [team] ${teamName ?? teamId} — form ${agg.form} corners ${agg.corners_for_avg} bp ${agg.booking_points_avg}`);
    } catch (err) {
      console.error(`  [error] team ${teamId}: ${err.message}`);
      summary.errors++;
    }
  }

  // Referee tendencies (deduped across teams via matches_count weighting).
  for (const [ref, a] of refereeAgg) {
    if (!a.n) continue;
    const row = {
      referee_name: ref, matches_count: a.n,
      cards_avg: Math.round((a.cards / a.n) * 100) / 100,
      booking_points_avg: Math.round((a.bp / a.n) * 100) / 100,
      updated_at: new Date().toISOString(),
    };
    if (DRY_RUN) { console.log(`  [dry-ref] ${ref}:`, JSON.stringify(row)); }
    else {
      const { error } = await supabase.from('referee_stats').upsert(row, { onConflict: 'referee_name' });
      if (error) { console.warn(`  [warn] referee ${ref}: ${error.message}`); continue; }
    }
    summary.refsUpdated++;
  }

  console.log('[teamstats] done:', summary);
  return summary;
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

if (require.main === module) {
  main().catch(err => { console.error('[teamstats] fatal:', err.message); process.exit(1); });
}

module.exports = { parseFixtureResult, extractFixtureStats, statValue, aggregateTeamStats, avg };
