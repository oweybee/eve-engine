/**
 * captureInplaySeries.js — record the in-play market movement time-series.
 *
 * Runs on every in-play tick (see scripts/inplay-vps/loop.sh — ~30s cadence).
 * For each live match it captures, per selection, one row containing:
 *
 *   • match state    — minute + score (this is what EXPLAINS the movement)
 *   • market shape   — consensus (median) odds, best price + which book, book count
 *   • model line     — our live probability at the same instant, fair odds, edge
 *
 * That triple is what makes the live chart meaningful rather than just a price
 * squiggle: the user sees the market move, sees OUR line move, and sees the goal
 * that caused it — all on one time axis.
 *
 * The model line comes from the frozen pre-match λ (inplay_baseline) advanced to
 * the current minute/score via lib/inplayWinProb — the same maths the in-play
 * signal stages use, so the chart and the signals can never disagree.
 *
 * Idempotent-ish by design: it appends a point per tick. Duplicate ticks within
 * MIN_GAP_SECONDS of the last stored point for a match are skipped so a fast
 * loop (or an overlapping run) can't inflate the series.
 *
 * Usage:  node captureInplaySeries.js [--dry-run]
 */
'use strict';

const { getClient } = require('./lib/supabaseClient');
const { liveWinProb, goalsOverProb } = require('./lib/inplayWinProb');
const { INPLAY_ODDS_MAX_AGE_MIN } = require('./lib/inplay');

const DRY = process.argv.includes('--dry-run');
const MIN_GAP_SECONDS = parseInt(process.env.INPLAY_SERIES_MIN_GAP || '20', 10);
// Shared with computeInplayValues.js. This file has always read 10 minutes and
// the SIGNAL engine beside it read 24 hours, so the chart and the signals it
// sits under held two different beliefs about what the live price is. The
// chart was the correct one; lib/inplay owns the number now.
const ODDS_MAX_AGE_MIN = INPLAY_ODDS_MAX_AGE_MIN;
const TOTALS_LINE = 2.5;

/** Median of a numeric array (null when empty). */
function median(xs) {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

/** Best (highest) price with its bookmaker. */
function best(rows) {
  let b = null;
  for (const r of rows) if (!b || r.v > b.v) b = r;
  return b;
}

async function fetchLiveMatches(supabase) {
  const { data, error } = await supabase
    .from('matches')
    .select('id, kickoff_at, status, minute, goals_home, goals_away')
    .eq('status', 'live');
  if (error) throw new Error(`inplaySeries[matches]: ${error.message}`);
  return data ?? [];
}

async function fetchBaselines(supabase, matchIds) {
  if (!matchIds.length) return new Map();
  const { data, error } = await supabase
    .from('inplay_baseline')
    .select('match_id, lambda_home, lambda_away')
    .in('match_id', matchIds);
  if (error) throw new Error(`inplaySeries[baseline]: ${error.message}`);
  return new Map((data ?? []).map(r => [r.match_id, r]));
}

async function fetchFreshOdds(supabase, matchIds) {
  if (!matchIds.length) return new Map();
  const cutoff = new Date(Date.now() - ODDS_MAX_AGE_MIN * 60_000).toISOString();
  const rows = [];
  for (let from = 0; ; from += 1000) {
    const { data, error } = await supabase
      .from('odds')
      .select('match_id, bookmaker, market, market_line, home_odds, draw_odds, away_odds, fetched_at')
      .in('match_id', matchIds)
      .gte('fetched_at', cutoff)
      .order('id', { ascending: true })
      .range(from, from + 999);
    if (error) throw new Error(`inplaySeries[odds]: ${error.message}`);
    if (!data?.length) break;
    rows.push(...data);
    if (data.length < 1000) break;
  }
  const byMatch = new Map();
  for (const o of rows) {
    if (!byMatch.has(o.match_id)) byMatch.set(o.match_id, []);
    byMatch.get(o.match_id).push(o);
  }
  return byMatch;
}

/** Most recent stored point per match, so we can rate-limit the series. */
async function fetchLastPoints(supabase, matchIds) {
  if (!matchIds.length) return new Map();
  const since = new Date(Date.now() - 10 * 60_000).toISOString();
  const { data, error } = await supabase
    .from('inplay_market_series')
    .select('match_id, captured_at')
    .in('match_id', matchIds)
    .gte('captured_at', since)
    .order('captured_at', { ascending: false });
  if (error) throw new Error(`inplaySeries[last]: ${error.message}`);
  const last = new Map();
  for (const r of data ?? []) {
    if (!last.has(r.match_id)) last.set(r.match_id, new Date(r.captured_at).getTime());
  }
  return last;
}

/**
 * Build the rows for one live match. Exported for tests.
 * @returns {Array<object>} one row per priced selection
 */
function buildRows(match, oddsRows, baseline, now = new Date()) {
  const minute = Number.isFinite(match.minute) ? match.minute : null;
  const gh = match.goals_home ?? 0;
  const ga = match.goals_away ?? 0;

  // ── market shape per selection ────────────────────────────────────────────
  const h2h = { home: [], draw: [], away: [] };
  const tot = { over: [], under: [] };
  for (const o of oddsRows) {
    const mk = o.market ?? 'h2h';
    if (mk === 'h2h') {
      if (o.home_odds > 1) h2h.home.push({ v: +o.home_odds, b: o.bookmaker });
      if (o.draw_odds > 1) h2h.draw.push({ v: +o.draw_odds, b: o.bookmaker });
      if (o.away_odds > 1) h2h.away.push({ v: +o.away_odds, b: o.bookmaker });
    } else if (mk === 'totals' && Number(o.market_line) === TOTALS_LINE) {
      // engine convention for totals rows: home_odds=over, away_odds=under
      if (o.home_odds > 1) tot.over.push({ v: +o.home_odds, b: o.bookmaker });
      if (o.away_odds > 1) tot.under.push({ v: +o.away_odds, b: o.bookmaker });
    }
  }

  // ── model line at this instant (frozen λ advanced to minute/score) ────────
  let modelP = {};
  if (baseline && baseline.lambda_home != null && baseline.lambda_away != null && minute != null) {
    const lh = Number(baseline.lambda_home);
    const la = Number(baseline.lambda_away);
    // liveWinProb returns { home, draw, away } (already normalised)
    const wp = liveWinProb({ lambdaHome: lh, lambdaAway: la, homeGoals: gh, awayGoals: ga, minute });
    modelP.home = wp.home; modelP.draw = wp.draw; modelP.away = wp.away;
    const pOver = goalsOverProb({ lambdaHome: lh, lambdaAway: la, homeGoals: gh,
                                  awayGoals: ga, minute, line: TOTALS_LINE });
    modelP.over = pOver; modelP.under = 1 - pOver;
  }

  const rows = [];
  const push = (selection, market, line, prices) => {
    if (!prices.length) return;
    const cons = median(prices.map(p => p.v));
    const b = best(prices);
    const p = modelP[selection];
    const bestOdds = b ? +b.v.toFixed(3) : null;
    rows.push({
      match_id: match.id,
      captured_at: now.toISOString(),
      minute, goals_home: gh, goals_away: ga,
      selection, market, market_line: line,
      consensus_odds: cons != null ? +cons.toFixed(3) : null,
      best_odds: bestOdds,
      best_bookmaker: b?.b ?? null,
      book_count: prices.length,
      model_prob: p != null ? +p.toFixed(4) : null,
      model_fair_odds: p ? +(1 / p).toFixed(3) : null,
      edge: (p != null && bestOdds) ? +(p * bestOdds - 1).toFixed(4) : null,
    });
  };

  push('home', 'h2h', null, h2h.home);
  push('draw', 'h2h', null, h2h.draw);
  push('away', 'h2h', null, h2h.away);
  push('over', 'totals', TOTALS_LINE, tot.over);
  push('under', 'totals', TOTALS_LINE, tot.under);
  return rows;
}

async function run() {
  const supabase = getClient();
  const live = await fetchLiveMatches(supabase);
  if (!live.length) {
    console.log('[inplaySeries] no live matches');
    return 0;
  }
  const ids = live.map(m => m.id);
  const [baselines, oddsByMatch, lastPoints] = await Promise.all([
    fetchBaselines(supabase, ids),
    fetchFreshOdds(supabase, ids),
    fetchLastPoints(supabase, ids),
  ]);

  const now = new Date();
  const all = [];
  let skippedGap = 0, skippedNoOdds = 0, noBaseline = 0;

  for (const m of live) {
    const lastAt = lastPoints.get(m.id);
    if (lastAt && (now.getTime() - lastAt) < MIN_GAP_SECONDS * 1000) { skippedGap++; continue; }
    const odds = oddsByMatch.get(m.id) ?? [];
    if (!odds.length) { skippedNoOdds++; continue; }
    const bl = baselines.get(m.id);
    if (!bl) noBaseline++;               // still record the market side
    all.push(...buildRows(m, odds, bl, now));
  }

  console.log(`[inplaySeries] live=${live.length} rows=${all.length} ` +
              `skipped_gap=${skippedGap} skipped_no_odds=${skippedNoOdds} no_baseline=${noBaseline}`);
  if (!all.length) return 0;
  if (DRY) {
    console.log(JSON.stringify(all.slice(0, 4), null, 2));
    return all.length;
  }
  const { error } = await supabase.from('inplay_market_series').insert(all);
  if (error) throw new Error(`inplaySeries[insert]: ${error.message}`);
  return all.length;
}

if (require.main === module) {
  run()
    .then(n => console.log(`[inplaySeries] wrote ${n} point(s)`))
    .catch(err => { console.error('[inplaySeries] FATAL:', err.message); process.exit(1); });
}

module.exports = { run, buildRows, median, best };
