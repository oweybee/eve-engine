'use strict';

/**
 * paperTradeTotals.js — log and settle MARKET_ANCHORED_TOTALS paper trades.
 *
 * Writes `paper_trades` and NOTHING ELSE. Not `value_signals`, not
 * `computed_values`: several aggregates read every settled `value_signals` row
 * with no architecture filter (band_calibration, bookmaker_prime_performance,
 * compute_performance_summary), so a row there is surfaced whatever `publish`
 * says. See migration 150 for the measurement.
 *
 *   1. LOG    every fresh (fixture, half-goal line, side) where the best
 *             takeable price beats Pinnacle's Shin-de-vigged fair line —
 *             lib/marketAnchorTotals.js decides — via insert_paper_trade().
 *             The dedup index keeps the FIRST sighting, which is the honest
 *             entry price.
 *   2. SETTLE every pending trade whose match is completed, via
 *             settle_paper_trade(). Also re-settles a recent row that settled
 *             before its close was captured, so a late close still lands
 *             (settle_paper_trade is idempotent).
 *
 * Never fails the pipeline: one bad fixture is logged and skipped.
 */

const { getClient } = require('./lib/supabaseClient');
const { evaluateFixture, ARCHITECTURE } = require('./lib/marketAnchorTotals');
const { IN_CHUNK, PAGE_SIZE } = require('./lib/pagedRead');

const MODEL_VERSION = 'v1';
const HORIZON_DAYS = parseInt(process.env.TOTALS_HORIZON_DAYS || '7', 10);
const RESETTLE_DAYS = 7;

async function pageRows(build, label) {
  const out = [];
  for (let from = 0; ; from += PAGE_SIZE) {
    const { data, error } = await build().range(from, from + PAGE_SIZE - 1);
    if (error) throw new Error(`${label}: ${error.message}`);
    if (!data?.length) break;
    out.push(...data);
    if (data.length < PAGE_SIZE) break;
  }
  return out;
}

async function logTrades(sb) {
  const now = new Date();
  const matches = await pageRows(() => sb.from('matches')
    .select('id, kickoff_at')
    .eq('status', 'scheduled')
    .gt('kickoff_at', now.toISOString())
    .lt('kickoff_at', new Date(now.getTime() + HORIZON_DAYS * 86_400_000).toISOString())
    .order('id', { ascending: true }), 'matches');
  const kickoff = new Map(matches.map(m => [m.id, m.kickoff_at]));
  const ids = [...kickoff.keys()];

  // Only fixtures Pinnacle is quoting totals on right now — narrows the
  // soft-book read to the ~600 fixtures that can possibly qualify.
  const freshCut = new Date(now.getTime() - 60 * 60_000).toISOString();
  const anchored = new Set();
  for (let i = 0; i < ids.length; i += IN_CHUNK) {
    const rows = await pageRows(() => sb.from('odds_latest')
      .select('match_id, market_line')
      .eq('bookmaker', 'pinnacle').eq('market', 'totals')
      .gte('confirmed_at', freshCut)
      .in('match_id', ids.slice(i, i + IN_CHUNK))
      .order('match_id').order('market_line'), 'odds_latest pinnacle');
    rows.forEach(r => anchored.add(r.match_id));
  }

  const quotes = new Map();
  const anchoredIds = [...anchored];
  for (let i = 0; i < anchoredIds.length; i += IN_CHUNK) {
    const rows = await pageRows(() => sb.from('odds_latest')
      .select('match_id, bookmaker, market, market_line, home_odds, away_odds, confirmed_at')
      .eq('market', 'totals')
      .gte('confirmed_at', freshCut)
      .in('match_id', anchoredIds.slice(i, i + IN_CHUNK))
      .order('match_id').order('bookmaker').order('market_line'), 'odds_latest totals');
    for (const r of rows) {
      if (!quotes.has(r.match_id)) quotes.set(r.match_id, []);
      quotes.get(r.match_id).push(r);
    }
  }

  const tally = { fixtures: anchored.size, hits: 0, inserted: 0, duplicate: 0, rejected: 0 };
  for (const [matchId, rows] of quotes) {
    let hits;
    try { hits = evaluateFixture(rows, { now: now.getTime() }); }
    catch (e) { console.warn(`[totals] ${matchId}: ${e.message}`); continue; }
    for (const h of hits) {
      tally.hits++;
      const { data, error } = await sb.rpc('insert_paper_trade', {
        p_match_id: matchId,
        p_kickoff_at: kickoff.get(matchId),
        p_model: ARCHITECTURE,
        p_model_version: MODEL_VERSION,
        p_market: 'totals',
        p_selection: h.selection,
        p_model_prob: h.model_prob,
        p_price_taken: h.price,
        p_market_line: h.market_line,
        p_book_taken: h.book,
        p_books_quoting: h.books_quoting,
        p_price_avg: h.price_avg,
        p_model_sigma: h.model_sigma,
        p_mxs: h.mxs,
        p_notes: `pinnacle ${h.anchor_odds.over}/${h.anchor_odds.under} fair ${h.fair_odds} edge ${h.edge}`,
      });
      if (error) { tally.rejected++; console.warn(`[totals] insert ${matchId}: ${error.message}`); continue; }
      const r = data?.[0];
      if (r?.status === 'inserted') {
        tally.inserted++;
        // insert_paper_trade has no market_prob parameter; the score's market
        // side goes on the row it just wrote.
        const { error: e2 } = await sb.from('paper_trades')
          .update({ market_prob: h.market_prob, prob_gap: h.prob_gap, mxs_band: h.mxs_band })
          .eq('id', r.trade_id);
        if (e2) console.warn(`[totals] market_prob ${r.trade_id}: ${e2.message}`);
      } else if (r?.status === 'duplicate') tally.duplicate++;
      else { tally.rejected++; console.warn(`[totals] ${matchId}: ${r?.status} ${r?.reason}`); }
    }
  }
  return tally;
}

async function settleTrades(sb) {
  const since = new Date(Date.now() - RESETTLE_DAYS * 86_400_000).toISOString();
  const open = await pageRows(() => sb.from('paper_trades')
    .select('id, match_id')
    .eq('model', ARCHITECTURE)
    .or(`result.eq.pending,and(no_vig_clv.is.null,settled_at.gte.${since})`)
    .order('id'), 'paper_trades open');
  if (!open.length) return { settled: 0, open: 0 };

  const ids = [...new Set(open.map(r => r.match_id))];
  const done = new Map();
  for (let i = 0; i < ids.length; i += IN_CHUNK) {
    const rows = await pageRows(() => sb.from('matches')
      .select('id, goals_home, goals_away')
      .eq('status', 'completed')
      .not('goals_home', 'is', null).not('goals_away', 'is', null)
      .in('id', ids.slice(i, i + IN_CHUNK))
      .order('id'), 'matches completed');
    rows.forEach(m => done.set(m.id, m.goals_home + m.goals_away));
  }

  let settled = 0;
  for (const t of open) {
    if (!done.has(t.match_id)) continue;
    const { error } = await sb.rpc('settle_paper_trade', {
      p_id: t.id, p_closing_price: null, p_actual_value: done.get(t.match_id),
    });
    if (error) console.warn(`[totals] settle ${t.id}: ${error.message}`);
    else settled++;
  }
  return { settled, open: open.length };
}

async function main() {
  const sb = getClient();
  const logged = await logTrades(sb);
  console.log(`[totals] logged: ${JSON.stringify(logged)}`);
  const settled = await settleTrades(sb);
  console.log(`[totals] settled: ${JSON.stringify(settled)}`);
}

if (require.main === module) {
  main().catch(e => { console.error(`[totals] ${e.message}`); process.exit(1); });
}

module.exports = { logTrades, settleTrades };
