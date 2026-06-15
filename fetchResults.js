/**
 * fetchResults.js — settles value signals and refreshes the performance summary.
 *
 * 1. Finds value_signals with result = 'pending' whose kickoff was > 2h ago.
 * 2. Looks up the actual match result from API-Football (RapidAPI) and sets
 *    result = 'win' | 'loss' on each signal, plus closing_odds and CLV where a
 *    closing Betfair price is available.
 *      CLV = ln(detected_odds) − ln(closing_odds)   (positive = beat the close)
 * 3. Recomputes performance_summary (win rate, yield, ROI, avg CLV, …) from the
 *    full settled history.
 *
 * Runs after computeValues.js in the GitHub Actions workflow. If RAPIDAPI_KEY is
 * not set it skips settlement (no-op) but still refreshes the summary so the
 * pipeline never fails just because results aren't wired up yet.
 */

'use strict';

const { createClient } = require('@supabase/supabase-js');

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const RAPIDAPI_KEY = process.env.RAPIDAPI_KEY;

const RAPIDAPI_HOST = 'api-football-v1.p.rapidapi.com';
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
  const url = `https://${RAPIDAPI_HOST}/v3/fixtures?date=${date}`;
  try {
    const res = await fetch(url, {
      headers: { 'X-RapidAPI-Key': RAPIDAPI_KEY, 'X-RapidAPI-Host': RAPIDAPI_HOST },
    });
    if (!res.ok) {
      console.warn(`  [results] API-Football ${date}: HTTP ${res.status}`);
      cache.set(date, []);
      return [];
    }
    const json = await res.json();
    const fixtures = json?.response ?? [];
    cache.set(date, fixtures);
    return fixtures;
  } catch (err) {
    console.warn(`  [results] API-Football ${date} fetch failed: ${err.message}`);
    cache.set(date, []);
    return [];
  }
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
async function closingOddsFor(supabase, matchId, outcome) {
  // 1. Dedicated closing snapshot
  const snap = await supabase
    .from('odds_snapshots')
    .select('odds, captured_at')
    .eq('match_id', matchId).eq('selection', outcome).eq('snapshot_type', 'closing')
    .order('captured_at', { ascending: false }).limit(1);
  if (!snap.error && snap.data?.length) return parseFloat(snap.data[0].odds);

  // 2. Latest Betfair Exchange price from the odds table
  const col = OUTCOME_TO_ODDS_COL[outcome];
  if (!col) return null;
  const odds = await supabase
    .from('odds')
    .select(`${col}, fetched_at`)
    .eq('match_id', matchId).eq('bookmaker', 'betfair_ex_uk')
    .order('fetched_at', { ascending: false }).limit(1);
  if (!odds.error && odds.data?.length) {
    const v = parseFloat(odds.data[0][col]);
    return Number.isFinite(v) && v > 1 ? v : null;
  }
  return null;
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

  if (!RAPIDAPI_KEY) {
    console.log(`[results] ${pending.length} signal(s) pending but RAPIDAPI_KEY not set — skipping settlement`);
    return { settled: 0, unmatched: pending.length };
  }

  const cache = new Map();
  let settled = 0, unmatched = 0;

  for (const sig of pending) {
    const home = sig.match?.home_team?.name;
    const away = sig.match?.away_team?.name;
    const kickoff = sig.kickoff_at ?? sig.match?.kickoff_at;
    if (!home || !away || !kickoff) { unmatched++; continue; }

    const date = new Date(kickoff).toISOString().slice(0, 10); // UTC YYYY-MM-DD
    const fixtures = await fetchFixturesForDate(date, cache);

    const fx = fixtures.find(f =>
      namesMatch(home, f?.teams?.home?.name) && namesMatch(away, f?.teams?.away?.name)
    );
    const actual = fx ? fixtureOutcome(fx) : null;
    if (!actual) { unmatched++; continue; }

    const result = actual === sig.outcome ? 'win' : 'loss';
    const closing = await closingOddsFor(supabase, sig.match_id, sig.outcome);
    const detected = parseFloat(sig.detected_odds);
    const clv = (closing && closing > 1 && detected > 1)
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

  const { error: insErr } = await supabase.from('performance_summary').insert(summary);
  if (insErr) throw new Error(`calculatePerformance(insert): ${insErr.message}`);

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
