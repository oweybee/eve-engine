/**
 * fetchResults.js — settles value signals and refreshes the performance summary.
 *
 * 1. Finds value_signals with result = 'pending' whose kickoff was > 2h ago.
 * 2. Looks up the actual match result from API-Football (API-Sports) and sets
 *   result = 'win' | 'loss' on each signal, plus closing_odds and CLV where a
 *    closing Betfair price is available.
 *      CLV = ln(detected_odds) − ln(closing_odds)   (positive = beat the close)
 * 3. Recomputes performance_summary (win rate, yield, ROI, avg CLV, …) from the
 *    full settled history.
 *
 * Runs after computeValues.js in the GitHub Actions workflow. If API_FOOTBALL_KEY is
 * not set it skips settlement (no-op) but still refreshes the summary so the
 * pipeline never fails just because results aren't wired up yet.
 */

'use strict';

const { createClient } = require('@supabase/supabase-js');

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const API_FOOTBALL_KEY = process.env.API_FOOTBALL_KEY;

const API_FOOTBALL_HOST = 'v3.football.api-sports.io';
const SETTLE_DELAY_MS = 2 * 60 * 60 * 1000; // only settle signals 2h+ past kickoff

function getClient() {
  if (!SUPABASE_URL || !SUPABASE_KEY) {
    throw new Error('Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY');
  }
  return createClient(SUPABASE_URL, SUPABASE_KEY);
}

// Normalise a team name for fuzzy matching across data sources.
function norm(s) {
  return (s ?? '')
    .toLowerCase()
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .replace(/\b(fc|cf|afc|sc|fk)\b/g, '')
    .replace(/[^a-z0-9]/g, '');
}

// A few known DB ↔ API-Football name differences.
const NAME_ALIASES = {
  southkorea: 'korearepublic',
  usa: 'unitedstates',
  ussr: 'russia',
};
function aliasNorm(s) {
  const n = norm(s);
  return NAME_ALIASES[n] ?? n;
}
function namesMatch(a, b) {
  const na = aliasNorm(a), nb = aliasNorm(b);
  return na === nb || na.includes(nb) || nb.includes(na);
}

// ---------------------------------------------------------------------------
// API-Football: fetch all fixtures for a UTC date (one call per date, cached)
// ---------------------------------------------------------------------------

async function fetchFixturesForDate(date, cache) {
  if (cache.has(date)) return cache.get(date);
  const url = `https://${API_FOOTBALL_HOST}/fixtures?date=${date}`;
  // P0-3 upstream: do NOT cache on error — a transient 5xx would permanently
  // mark every signal that day as unmatched. Let the caller retry on the next run.
  const res = await fetch(url, {
    headers: { 'x-apisports-key': API_FOOTBALL_KEY },
  });
  if (!res.ok) {
    throw new Error(`API-Football ${date}: HTTP ${res.status}`);
  }
  const json = await res.json();
  const fixtures = json?.response ?? [];
  cache.set(date, fixtures);
  return fixtures;
}

// Maps a finished fixture to the winning outcome: 'home' | 'draw' | 'away' | null.
function fixtureOutcome(fx) {
  const status = fx?.fixture?.status?.short;
  if (!['FT', 'AET', 'PEN'].includes(status)) return null; // not finished
  const hg = fx?.goals?.home, ag = fx?.goals?.away;
  if (hg == null || ag == null) return null;
  if (hg > ag) return 'home';
  if (hg < ag) return 'away';
  return 'draw';
}

// ---------------------------------------------------------------------------
// Closing Betfair price for CLV (best-effort)
// ---------------------------------------------------------------------------

const OUTCOME_TO_ODDS_COL = { home: 'home_odds', draw: 'draw_odds', away: 'away_odds' };

/**
 * Best-effort closing price: a 'closing' odds_snapshot if captured, otherwise the
 * latest Betfair Exchange price we recorded for the match before kickoff.
 */
/**
 * Bulk-prefetch closing odds for all pending signals in 2 queries instead of
 * 2×N serial round-trips. Returns Map<`${matchId}:${outcome}`, number|null>.
 */
async function prefetchClosingOdds(supabase, signals) {
  const matchIds = [...new Set(signals.map(s => s.match_id).filter(Boolean))];
  if (!matchIds.length) return new Map();

  // Query 1: closing snapshots for all match+outcome combos
  const { data: snaps } = await supabase
    .from('odds_snapshots')
    .select('match_id, selection, odds, captured_at')
    .in('match_id', matchIds)
    .eq('snapshot_type', 'closing')
    .order('captured_at', { ascending: false });

  // Query 2: latest Betfair Exchange prices for all matches
  const { data: betfairRows } = await supabase
    .from('odds')
    .select('match_id, home_odds, draw_odds, away_odds, fetched_at')
    .in('match_id', matchIds)
    .eq('bookmaker', 'betfair_ex_uk')
    .order('fetched_at', { ascending: false });

  // Build maps — first row per match_id is latest (DESC order)
  const snapMap    = new Map(); // key: `${matchId}:${outcome}`
  const betfairMap = new Map(); // key: matchId → latest row

  for (const s of snaps ?? []) {
    const key = `${s.match_id}:${s.selection}`;
    if (!snapMap.has(key)) snapMap.set(key, parseFloat(s.odds));
  }
  for (const r of betfairRows ?? []) {
    if (!betfairMap.has(r.match_id)) betfairMap.set(r.match_id, r);
  }

  // Resolve each signal to a closing price
  const result = new Map();
  for (const sig of signals) {
    const key = `${sig.match_id}:${sig.outcome}`;
    if (snapMap.has(key)) {
      result.set(key, snapMap.get(key));
      continue;
    }
    const col = OUTCOME_TO_ODDS_COL[sig.outcome];
    const row = col && betfairMap.get(sig.match_id);
    const v   = row ? parseFloat(row[col]) : NaN;
    result.set(key, Number.isFinite(v) && v > 1 ? v : null);
  }
  return result;
}

// ---------------------------------------------------------------------------
// 1+2. Settle pending signals
// ---------------------------------------------------------------------------

async function settlePendingSignals(supabase) {
  const cutoff = new Date(Date.now() - SETTLE_DELAY_MS).toISOString();
  const { data: pending, error } = await supabase
    .from('value_signals')
    .select(`
      id, match_id, outcome, detected_odds, kickoff_at, result,
      match:matches (
        kickoff_at,
        home_team:teams!matches_home_team_id_fkey ( name ),
        away_team:teams!matches_away_team_id_fkey ( name )
      )
    `)
    .eq('result', 'pending')
    .lt('kickoff_at', cutoff);

  if (error) throw new Error(`settlePendingSignals(select): ${error.message}`);
  if (!pending?.length) {
    console.log('[results] no pending signals ready to settle');
    return { settled: 0, unmatched: 0 };
  }

  if (!API_FOOTBALL_KEY) {
    console.log(`[results] ${pending.length} signal(s) pending but API_FOOTBALL_KEY not set — skipping settlement`);
    return { settled: 0, unmatched: pending.length };
  }

  // Bulk-prefetch closing odds (2 queries instead of 2×N serial round-trips)
  const closingMap = await prefetchClosingOdds(supabase, pending);

  const cache = new Map();
  let settled = 0, unmatched = 0;

  for (const sig of pending) {
    const home = sig.match?.home_team?.name;
    const away = sig.match?.away_team?.name;
    const kickoff = sig.kickoff_at ?? sig.match?.kickoff_at;
    if (!home || !away || !kickoff) { unmatched++; continue; }

    const date = new Date(kickoff).toISOString().slice(0, 10); // UTC YYYY-MM-DD
    let fixtures;
    try {
      fixtures = await fetchFixturesForDate(date, cache);
    } catch (err) {
      // Transient API error — leave this signal pending for the next run.
      console.warn(`  [results] skip ${home} vs ${away}: ${err.message}`);
      unmatched++;
      continue;
    }

    const fx = fixtures.find(f =>
      namesMatch(home, f?.teams?.home?.name) && namesMatch(away, f?.teams?.away?.name)
    );
    const actual = fx ? fixtureOutcome(fx) : null;
    if (!actual) { unmatched++; continue; }

    const result  = actual === sig.outcome ? 'win' : 'loss';
    const closing = closingMap.get(`${sig.match_id}:${sig.outcome}`) ?? null;
    const detected = parseFloat(sig.detected_odds);
    // P0-3 fix: guard against NaN/Infinity before logarithm.
    // Invalid prices (null, ≤1, NaN) → clv = null, never a garbage number.
    const clv = (
      Number.isFinite(closing) && closing > 1 &&
      Number.isFinite(detected) && detected > 1
    )
      ? +(Math.log(detected) - Math.log(closing)).toFixed(4)
      : null;

    const { error: upErr } = await supabase
      .from('value_signals')
      .update({ result, closing_odds: closing, clv })
      .eq('id', sig.id);
    if (upErr) { console.warn(`  [results] update ${sig.id} failed: ${upErr.message}`); continue; }

    settled++;
    console.log(`  [results] ${home} vs ${away} (${sig.outcome}) → ${result}${clv != null ? ` clv=${clv}` : ''}`);
  }

  console.log(`[results] settled ${settled}, unmatched ${unmatched}`);
  return { settled, unmatched };
}

// ---------------------------------------------------------------------------
// 3. Performance summary
// ---------------------------------------------------------------------------

function avg(arr) {
  return arr.length ? arr.reduce((s, x) => s + x, 0) / arr.length : null;
}

/**
 * Aggregates the full value_signals history into one performance_summary row.
 *   win_rate = wins / (wins + losses)
 *   yield    = Σ profit / settled        (profit = odds−1 if win else −1, 1u stake)
 *   roi      = yield (level stakes)
 */
async function calculatePerformance(supabase) {
  const { data, error } = await supabase
    .from('value_signals')
    .select('result, detected_odds, detected_edge, detected_mes, clv');
  if (error) throw new Error(`calculatePerformance(select): ${error.message}`);

  const rows = data ?? [];
  const settled = rows.filter(r => r.result === 'win' || r.result === 'loss');
  const wins = settled.filter(r => r.result === 'win').length;
  const losses = settled.filter(r => r.result === 'loss').length;

  const profit = settled.reduce(
    (s, r) => s + (r.result === 'win' ? (parseFloat(r.detected_odds) - 1) : -1), 0);

  const clvs   = settled.map(r => r.clv).filter(v => v != null).map(Number);
  const edges  = rows.map(r => r.detected_edge).filter(v => v != null).map(Number);
  const messes = rows.map(r => r.detected_mes).filter(v => v != null).map(Number);

  const summary = {
    total_signals:   rows.length,
    settled_signals: settled.length,
    wins,
    losses,
    win_rate: settled.length ? +(wins / settled.length).toFixed(4) : null,
    yield:    settled.length ? +(profit / settled.length).toFixed(4) : null,
    roi:      settled.length ? +(profit / settled.length).toFixed(4) : null,
    avg_clv:  clvs.length   ? +avg(clvs).toFixed(4)   : null,
    avg_edge: edges.length  ? +avg(edges).toFixed(4)  : null,
    avg_mes:  messes.length ? +avg(messes).toFixed(1) : null,
  };

  // P0-2 fix: upsert on singleton_key instead of blind insert.
  // Previously, every run appended a new row — performance_summary grew without
  // bound. Migration 016 added singleton_key='current' with a unique constraint.
  const { error: insErr } = await supabase
    .from('performance_summary')
    .upsert({ ...summary, singleton_key: 'current' }, { onConflict: 'singleton_key' });
  if (insErr) throw new Error(`calculatePerformance(upsert): ${insErr.message}`);

  console.log('[performance]', JSON.stringify(summary));
  return summary;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function run() {
  console.log(`\n[results] ${new Date().toISOString()}`);
  const supabase = getClient();

  try {
    await settlePendingSignals(supabase);
  } catch (err) {
    console.error('[results] settlement error:', err.message);
  }

  try {
    await calculatePerformance(supabase);
  } catch (err) {
    console.error('[results] performance error:', err.message);
  }

  console.log('[results] done');
}

if (require.main === module) {
  run().catch(err => { console.error('[results] unhandled:', err); process.exit(1); });
}

module.exports = { run, calculatePerformance, settlePendingSignals, namesMatch, fixtureOutcome };
