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
const { classifyTier, dedupeConflicts } = require('./lib/signalTier');
const { marketQualifies, isEarlyPayout } = require('./lib/earlyPayout');
const { goalTimelineFromEvents, fetchFixtureEvents } = require('./lib/apiFootballEvents');

// Clean-slate epoch: performance is tracked ONLY for signals detected on or
// after this instant — the go-live of the Prime-only + conflict-deduped
// structure. Everything before it was generated under the old rules and must
// not count. Override with PERFORMANCE_EPOCH if the slate is ever reset again.
const PERFORMANCE_EPOCH = process.env.PERFORMANCE_EPOCH || '2026-07-03T18:30:00Z';

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

/**
 * Resolves a market selection against a FINAL scoreline, RESPECTING THE MARKET.
 * The old code compared the 1X2 result to sig.outcome directly, so any secondary
 * selection ('btts_yes', 'over', …) could never equal 'home'/'draw'/'away' and
 * was always marked a loss. This resolves each market from the goals alone:
 *   h2h     → match result
 *   btts    → did both teams score
 *   totals  → total goals vs the .5 line
 *   corners / bookings → not derivable from goals; returns null (unsettleable)
 * Returns 'win' | 'loss' | null (null = missing goals, or unsettleable market).
 *
 * Pure and stateless so it can settle from EITHER the API fixture payload or the
 * authoritative matches.goals columns, and so reconcileSettledSignals can replay
 * it over already-settled rows.
 */
function resultFromGoals(hg, ag, market, outcome, line) {
  if (hg == null || ag == null) return null;

  const oc = (outcome ?? '').toLowerCase();
  const mk = (market ?? 'h2h').toLowerCase();

  if (mk === 'h2h' || oc === 'home' || oc === 'draw' || oc === 'away') {
    const res = hg > ag ? 'home' : hg < ag ? 'away' : 'draw';
    return res === oc ? 'win' : 'loss';
  }
  if (mk === 'btts' || oc.includes('btts') || oc === 'yes' || oc === 'no') {
    const both = hg > 0 && ag > 0;
    if (oc.includes('yes')) return both ? 'win' : 'loss';
    if (oc.includes('no'))  return both ? 'loss' : 'win';
    return null;
  }
  if (mk === 'totals') {
    // Guard null/'' explicitly — Number(null) is 0, which would silently settle
    // against a phantom 0.5-style line. A totals signal with no line is unsettleable.
    const L = (line == null || line === '') ? NaN : Number(line);
    if (!Number.isFinite(L)) return null;
    const total = hg + ag;
    if (oc === 'over')  return total > L ? 'win' : 'loss';
    if (oc === 'under') return total < L ? 'win' : 'loss';
    return null;
  }
  // corners / bookings — needs the statistics endpoint, not goals. Leave pending.
  return null;
}

/**
 * Settles a single value signal against a finished API fixture. Thin wrapper:
 * gates on the fixture being finished, then defers to resultFromGoals.
 * Returns 'win' | 'loss' | null (null = not finished, or unsettleable market).
 */
function settleSignal(fx, market, outcome, line) {
  const status = fx?.fixture?.status?.short;
  if (!['FT', 'AET', 'PEN'].includes(status)) return null; // not finished
  return resultFromGoals(fx?.goals?.home, fx?.goals?.away, market, outcome, line);
}

// ---------------------------------------------------------------------------
// Match status settlement
//
// fetchResults historically only settled value_signals — it never updated
// matches.status. Once a match kicked off it stayed 'scheduled' forever, so
// computeValues/computeApiValues (WHERE status IN ('scheduled','live')) kept
// recomputing dead fixtures indefinitely, polluting Market Pulse with games
// that already finished. This routine flips finished matches to 'completed'.
//
// Settles by EXACT API-Football fixture id (matches.external_id), so no fuzzy
// name matching is needed.
// ---------------------------------------------------------------------------

async function settleFinishedMatches(supabase, cache) {
  const cutoff = new Date(Date.now() - SETTLE_DELAY_MS).toISOString();
  const { data: stale, error } = await supabase
    .from('matches')
    .select('id, external_id, kickoff_at, status')
    .in('status', ['scheduled', 'live'])
    .lt('kickoff_at', cutoff);

  if (error) throw new Error(`settleFinishedMatches(select): ${error.message}`);

  const matches = (stale ?? []).filter(m => /^\d+$/.test(m.external_id ?? ''));
  if (!matches.length) {
    console.log('[results] no past-kickoff matches awaiting status settlement');
    return { completed: 0, pending: 0 };
  }
  if (!API_FOOTBALL_KEY) {
    console.log(`[results] ${matches.length} match(es) past kickoff but API_FOOTBALL_KEY not set — skipping status settlement`);
    return { completed: 0, pending: matches.length };
  }

  let completed = 0, stillPending = 0;
  for (const m of matches) {
    const date = new Date(m.kickoff_at).toISOString().slice(0, 10); // UTC YYYY-MM-DD
    let fixtures;
    try {
      fixtures = await fetchFixturesForDate(date, cache);
    } catch (err) {
      // Transient API error — leave this match for the next run.
      console.warn(`  [results] status skip fixture ${m.external_id}: ${err.message}`);
      stillPending++;
      continue;
    }

    const fx      = fixtures.find(f => String(f?.fixture?.id) === m.external_id);
    const outcome = fx ? fixtureOutcome(fx) : null;
    if (!outcome) { stillPending++; continue; } // not finished yet (or not found)

    const { error: upErr } = await supabase
      .from('matches')
      .update({
        status:     'completed',
        goals_home: fx?.goals?.home ?? null,
        goals_away: fx?.goals?.away ?? null,
        result:     outcome,
      })
      .eq('id', m.id);
    if (upErr) {
      console.warn(`  [results] status update ${m.id} failed: ${upErr.message}`);
      stillPending++;
      continue;
    }
    completed++;
  }

  console.log(`[results] match status: completed ${completed}, still pending ${stillPending}`);
  return { completed, pending: stillPending };
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

async function settlePendingSignals(supabase, cache = new Map()) {
  const cutoff = new Date(Date.now() - SETTLE_DELAY_MS).toISOString();
  const { data: pending, error } = await supabase
    .from('value_signals')
    .select(`
      id, match_id, outcome, detected_odds, kickoff_at, result, market, market_line, phase,
      match:matches (
        kickoff_at, status, goals_home, goals_away,
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

  let settled = 0, unmatched = 0;

  for (const sig of pending) {
    const home = sig.match?.home_team?.name;
    const away = sig.match?.away_team?.name;
    const kickoff = sig.kickoff_at ?? sig.match?.kickoff_at;
    if (!home || !away || !kickoff) { unmatched++; continue; }

    // Prefer the AUTHORITATIVE score. settleFinishedMatches settles matches by
    // EXACT API-Football fixture id and runs before us, so matches.goals is the
    // source of truth. Settling from it (rather than a fuzzy name+date re-fetch)
    // means a signal can never be resolved against the wrong same-day fixture,
    // and the two passes can never disagree.
    let result = null;
    if (sig.match?.status === 'completed') {
      result = resultFromGoals(sig.match.goals_home, sig.match.goals_away,
                               sig.market, sig.outcome, sig.market_line);
    }

    // Fallback: matches.goals not available (e.g. non-numeric external_id that
    // settleFinishedMatches skips) — resolve via the dated fixtures fetch.
    if (result == null && sig.match?.status !== 'completed') {
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
      // Market-aware: 1X2 by result, BTTS by both-scored, totals by goal line.
      // Corners/cards return null and stay pending (not derivable from goals).
      result = fx ? settleSignal(fx, sig.market, sig.outcome, sig.market_line) : null;
    }
    if (result == null) { unmatched++; continue; }

    // CLV is undefined for in-play signals — the line already closed at kickoff,
    // so a pre-kickoff "closing" Betfair price is not a valid benchmark. Store
    // null rather than a misleading number; in-play is judged on realised yield.
    const isInplay = sig.phase === 'inplay';
    const closing  = isInplay ? null : (closingMap.get(`${sig.match_id}:${sig.outcome}`) ?? null);
    const detected = parseFloat(sig.detected_odds);
    // P0-3 fix: guard against NaN/Infinity before logarithm.
    // Invalid prices (null, ≤1, NaN) → clv = null, never a garbage number.
    const clv = (
      !isInplay &&
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
// 2b. Reconcile already-settled signals against the authoritative score
//
// Settlement used to be write-once: settlePendingSignals only ever touches
// result='pending', so any signal settled against a WRONG result stayed wrong
// forever. That bit us badly — an earlier settleSignal bug marked every
// secondary-market signal (btts/totals) a loss regardless of the score; the
// code was fixed but the already-settled rows kept their bogus 'loss',
// understating tracked performance.
//
// This pass replays resultFromGoals over every settled signal whose match has a
// final score and corrects any mismatch. It settles from matches.goals (exact
// fixture id), so it is self-healing: whatever caused a wrong settlement — old
// bug, a provisional in-play score, a fuzzy mismatch — is fixed once the true
// score is known. Only `result` is rewritten; closing_odds/clv are captured at
// the close and do not depend on the outcome.
// ---------------------------------------------------------------------------

async function reconcileSettledSignals(supabase) {
  const { data: rows, error } = await supabase
    .from('value_signals')
    .select(`
      id, outcome, market, market_line, result,
      match:matches ( status, goals_home, goals_away )
    `)
    .in('result', ['win', 'loss']);

  if (error) throw new Error(`reconcileSettledSignals(select): ${error.message}`);
  if (!rows?.length) return { corrected: 0 };

  let corrected = 0;
  for (const sig of rows) {
    const m = sig.match;
    if (!m || m.status !== 'completed' || m.goals_home == null || m.goals_away == null) continue;

    const correct = resultFromGoals(m.goals_home, m.goals_away, sig.market, sig.outcome, sig.market_line);
    if (correct == null || correct === sig.result) continue;

    const { error: upErr } = await supabase
      .from('value_signals')
      .update({ result: correct })
      .eq('id', sig.id);
    if (upErr) { console.warn(`  [results] reconcile ${sig.id} failed: ${upErr.message}`); continue; }

    corrected++;
    console.log(`  [results] reconciled ${sig.market}/${sig.outcome}: ${sig.result} → ${correct}`);
  }

  console.log(`[results] reconciled ${corrected} mis-settled signal(s)`);
  return { corrected };
}

// ---------------------------------------------------------------------------
// 2c. Early payout (2UP) flagging
//
// Bookmakers pay a 1X2 win single as a winner the moment the backed team goes
// two goals clear, even if it later draws or loses. This pass finds settled
// LOSSES that could have been early payouts and records the fact on the signal
// WITHOUT touching `result` — model accuracy stays honest; calculatePerformance
// reports the adjusted "as paid out" line separately.
//
// Bounded + idempotent: it only ever looks at losses with early_payout still
// NULL, so each loss is evaluated exactly once. Non-qualifying losses (draws,
// btts, totals) are stamped false so they're never re-scanned. One API-Football
// events call per qualifying fixture, memoised in the shared cache.
// ---------------------------------------------------------------------------

async function flagEarlyPayouts(supabase, cache = new Map()) {
  const { data: losses, error } = await supabase
    .from('value_signals')
    .select(`
      id, outcome, market, market_line,
      match:matches (
        external_id,
        home_team:teams!matches_home_team_id_fkey ( name ),
        away_team:teams!matches_away_team_id_fkey ( name )
      )
    `)
    .eq('result', 'loss')
    .is('early_payout', null);

  if (error) throw new Error(`flagEarlyPayouts(select): ${error.message}`);
  if (!losses?.length) {
    console.log('[results] no losses awaiting early-payout evaluation');
    return { flagged: 0, evaluated: 0 };
  }

  // Non-qualifying markets (draw / btts / totals / …) can never be a 2UP payout.
  // Stamp them false in one bulk write so they drop out of future scans without
  // burning an API call each.
  const nonQualifying = losses.filter(s => !marketQualifies(s.market, s.outcome));
  if (nonQualifying.length) {
    const { error: bulkErr } = await supabase
      .from('value_signals')
      .update({ early_payout: false })
      .in('id', nonQualifying.map(s => s.id));
    if (bulkErr) console.warn(`  [results] early-payout bulk-clear failed: ${bulkErr.message}`);
  }

  const qualifying = losses.filter(s => marketQualifies(s.market, s.outcome));
  if (!qualifying.length) {
    console.log(`[results] early-payout: ${nonQualifying.length} non-qualifying loss(es) cleared, 0 to check`);
    return { flagged: 0, evaluated: nonQualifying.length };
  }
  if (!API_FOOTBALL_KEY) {
    console.log(`[results] ${qualifying.length} loss(es) to check for early payout but API_FOOTBALL_KEY not set — leaving pending`);
    return { flagged: 0, evaluated: nonQualifying.length };
  }

  let flagged = 0;
  for (const sig of qualifying) {
    const fixtureId = sig.match?.external_id;
    const home = sig.match?.home_team?.name;
    const away = sig.match?.away_team?.name;

    let goals = null;
    try {
      const events = await fetchFixtureEvents(fixtureId, API_FOOTBALL_KEY, cache);
      if (events) goals = goalTimelineFromEvents(events, home, away, namesMatch);
    } catch (err) {
      // Transient API error — leave early_payout NULL so the next run retries.
      console.warn(`  [results] early-payout events skip ${home} vs ${away}: ${err.message}`);
      continue;
    }

    const ep = isEarlyPayout({ market: sig.market, outcome: sig.outcome, goals });

    const { error: upErr } = await supabase
      .from('value_signals')
      .update({ early_payout: ep })
      .eq('id', sig.id);
    if (upErr) { console.warn(`  [results] early-payout update ${sig.id} failed: ${upErr.message}`); continue; }

    if (ep) {
      flagged++;
      console.log(`  [results] EARLY PAYOUT ${home} vs ${away} (${sig.outcome}) — backed team led by 2, lost on final score`);
    }
  }

  console.log(`[results] early-payout: flagged ${flagged} of ${qualifying.length} qualifying loss(es)`);
  return { flagged, evaluated: nonQualifying.length + qualifying.length };
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
 *   roi      = Σ profit / 100u bankroll   (growth on a fixed bankroll — distinct
 *                                          from level-stakes yield)
 */
const ROI_BANKROLL_UNITS = 100;

/** Aggregate one phase's slice of value_signals into a summary object. */
function summarisePhase(rows, { includeClv }) {
  const settled = rows.filter(r => r.result === 'win' || r.result === 'loss');
  const wins   = settled.filter(r => r.result === 'win').length;
  const losses = settled.filter(r => r.result === 'loss').length;
  const profit = settled.reduce(
    (s, r) => s + (r.result === 'win' ? (parseFloat(r.detected_odds) - 1) : -1), 0);

  // Early-payout ADJUSTED view: a 2UP payout counts as a win at the backed odds
  // even though `result` is a loss. `paidWin` is a win either way (a true win, or
  // a loss the bookmaker's 2-goals-ahead rule paid out). This never alters the
  // honest `wins`/`losses`/`yield` above — it's a parallel line.
  const paidWin = r => r.result === 'win' || r.early_payout === true;
  const earlyPayouts = settled.filter(r => r.result !== 'win' && r.early_payout === true).length;
  const adjWins = settled.filter(paidWin).length;
  const adjProfit = settled.reduce(
    (s, r) => s + (paidWin(r) ? (parseFloat(r.detected_odds) - 1) : -1), 0);

  const clvs   = settled.map(r => r.clv).filter(v => v != null).map(Number);
  const edges  = rows.map(r => r.detected_edge).filter(v => v != null).map(Number);
  const messes = rows.map(r => r.detected_mes).filter(v => v != null).map(Number);

  return {
    total_signals:   rows.length,
    settled_signals: settled.length,
    wins,
    losses,
    win_rate: settled.length ? +(wins / settled.length).toFixed(4) : null,
    yield:    settled.length ? +(profit / settled.length).toFixed(4) : null,
    roi:      settled.length ? +(profit / ROI_BANKROLL_UNITS).toFixed(4) : null,
    // Early-payout adjusted aggregates (2UP wins folded in).
    early_payouts:     earlyPayouts,
    adjusted_wins:     adjWins,
    adjusted_win_rate: settled.length ? +(adjWins / settled.length).toFixed(4) : null,
    adjusted_yield:    settled.length ? +(adjProfit / settled.length).toFixed(4) : null,
    adjusted_roi:      settled.length ? +(adjProfit / ROI_BANKROLL_UNITS).toFixed(4) : null,
    // CLV is only meaningful pre-match (the close happens at kickoff). In-play
    // is judged on realised yield/strike-rate alone.
    avg_clv:  includeClv && clvs.length ? +avg(clvs).toFixed(4) : null,
    avg_edge: edges.length  ? +avg(edges).toFixed(4)  : null,
    avg_mes:  messes.length ? +avg(messes).toFixed(1) : null,
  };
}

/**
 * Recompute BOTH performance rows from the settled history:
 *   singleton_key='current' phase='prematch' — the CLV-tracked headline
 *   singleton_key='inplay'  phase='inplay'    — yield/strike-rate, no CLV
 * Keeping them separate is what stops in-play picks from skewing CLV.
 */
async function calculatePerformance(supabase) {
  const { data, error } = await supabase
    .from('value_signals')
    .select('result, early_payout, detected_odds, detected_edge, detected_mes, clv, phase, detected_at, match_id, market, market_line');
  if (error) throw new Error(`calculatePerformance(select): ${error.message}`);

  const rows = data ?? [];
  // Legacy rows (phase NULL) predate the in-play engine and were pre-match.
  const prematchRows = rows.filter(r => (r.phase ?? 'prematch') !== 'inplay');
  const inplayRows   = rows.filter(r => r.phase === 'inplay');

  // Headline performance reflects PRIME signals only — the sole tier we
  // suggest — and only those detected on/after the clean-slate epoch. Value and
  // longshot picks stay visible on the site as a tool but must never distort the
  // tracked win-rate / yield / ROI. (see lib/signalTier)
  const epochMs = new Date(PERFORMANCE_EPOCH).getTime();
  const primeRows = prematchRows.filter(r =>
    classifyTier({ odds: r.detected_odds, edge: r.detected_edge }).tier === 'prime' &&
    r.detected_at != null && new Date(r.detected_at).getTime() >= epochMs);

  // Collapse mutually-exclusive picks (e.g. home + away on the same match) to a
  // single tracked bet so opposing signals can't wash out the numbers.
  const trackedPrimes = dedupeConflicts(primeRows);

  const calculated_at = new Date().toISOString();
  const prematch = { ...summarisePhase(trackedPrimes, { includeClv: true }),
                     phase: 'prematch', singleton_key: 'current', calculated_at };
  const inplay   = { ...summarisePhase(inplayRows, { includeClv: false }),
                     phase: 'inplay', singleton_key: 'inplay', calculated_at };

  // P0-2 fix: upsert on singleton_key — one authoritative row per phase.
  const { error: insErr } = await supabase
    .from('performance_summary')
    .upsert([prematch, inplay], { onConflict: 'singleton_key' });
  if (insErr) throw new Error(`calculatePerformance(upsert): ${insErr.message}`);

  console.log('[performance] prematch', JSON.stringify(prematch));
  console.log('[performance] inplay  ', JSON.stringify(inplay));
  return { prematch, inplay };
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function run() {
  console.log(`\n[results] ${new Date().toISOString()}`);
  const supabase = getClient();

  // Shared fixtures-by-date cache across both settlement passes (one API call
  // per date covers signal settlement AND match-status settlement).
  const cache = new Map();

  try {
    await settleFinishedMatches(supabase, cache);
  } catch (err) {
    console.error('[results] match-status settlement error:', err.message);
  }

  try {
    await settlePendingSignals(supabase, cache);
  } catch (err) {
    console.error('[results] settlement error:', err.message);
  }

  try {
    await reconcileSettledSignals(supabase);
  } catch (err) {
    console.error('[results] reconcile error:', err.message);
  }

  try {
    await flagEarlyPayouts(supabase, cache);
  } catch (err) {
    console.error('[results] early-payout flagging error:', err.message);
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

module.exports = { run, calculatePerformance, settlePendingSignals, settleFinishedMatches, reconcileSettledSignals, flagEarlyPayouts, namesMatch, fixtureOutcome, settleSignal, resultFromGoals };
