/**
 * Max Edge — Snapshot & CLV capture (Features #1 CLV, #7 Market Movement)
 *
 * Run this on a schedule (e.g. every 15–30 min, and crucially in the final hour
 * before each kickoff). Each run:
 *   1. Snapshots current best soft odds per outcome into odds_snapshots, tagging
 *      the row 'open' (first ever for the match), 'closing' (<60 min to kickoff),
 *      or 'current' otherwise.
 *   2. Creates a recommendation row for any outcome currently flagged as value
 *      that we haven't already recorded — freezing the signal odds + edge.
 *   3. Back-fills CLV on recommendations whose match now has a closing price.
 *
 * CLV % = ((recommended_odds - closing_odds) / closing_odds) * 100
 *
 * Usage: export $(cat .env | xargs) && node captureSnapshot.js
 */

'use strict';

const { createClient } = require('@supabase/supabase-js');

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const CLOSING_WINDOW_MIN = 60;
const SIGNAL_EDGE = parseFloat(process.env.SIGNAL_EDGE ?? '0.02'); // 2pp

function getClient() {
  if (!SUPABASE_URL || !SUPABASE_KEY) throw new Error('Missing Supabase env vars');
  return createClient(SUPABASE_URL, SUPABASE_KEY);
}

function edgeBucket(edge) {
  const pp = edge * 100;
  if (pp < 2)  return '0-2';
  if (pp < 4)  return '2-4';
  if (pp < 6)  return '4-6';
  if (pp < 10) return '6-10';
  return '10+';
}

const OUTCOMES = ['home', 'draw', 'away'];

async function run() {
  console.log(`\n[snapshot] ${new Date().toISOString()}`);
  const supabase = getClient();

  const { data: rows, error } = await supabase
    .from('computed_values')
    .select(`
      match_id, best_outcome, confidence_score, max_edge_score,
      best_home_odds, best_draw_odds, best_away_odds,
      best_home_book, best_draw_book, best_away_book,
      home_edge, draw_edge, away_edge,
      home_value, draw_value, away_value,
      match:matches ( kickoff_at, league:leagues ( name ) )
    `);

  if (error) { console.error('[snapshot] fetch failed:', error.message); process.exit(1); }

  const now = Date.now();
  let snaps = 0, recs = 0, clvUpdated = 0;

  for (const r of rows ?? []) {
    const kickoff = r.match?.kickoff_at ? new Date(r.match.kickoff_at).getTime() : null;
    const minsToKick = kickoff != null ? (kickoff - now) / 60000 : null;
    const league = r.match?.league?.name ?? null;

    const oddsBy = { home: r.best_home_odds, draw: r.best_draw_odds, away: r.best_away_odds };
    const bookBy = { home: r.best_home_book, draw: r.best_draw_book, away: r.best_away_book };
    const edgeBy = { home: r.home_edge, draw: r.draw_edge, away: r.away_edge };
    const valBy  = { home: r.home_value, draw: r.draw_value, away: r.away_value };

    // 1. Determine snapshot type
    let snapType = 'current';
    if (minsToKick != null && minsToKick <= CLOSING_WINDOW_MIN && minsToKick > -180) {
      snapType = 'closing';
    } else {
      const { count } = await supabase
        .from('odds_snapshots')
        .select('id', { count: 'exact', head: true })
        .eq('match_id', r.match_id);
      if (!count) snapType = 'open';
    }

    // Snapshot the full per-bookmaker depth this cycle (drives best/avg/Betfair
    // chart series + the market-depth panel). Latest row per book from `odds`.
    const { data: bookRows } = await supabase
      .from('odds')
      .select('bookmaker, home_odds, draw_odds, away_odds, fetched_at, market')
      .eq('match_id', r.match_id).eq('market', 'h2h')
      .order('fetched_at', { ascending: false })
      .limit(200);

    const latestByBook = {};
    for (const br of bookRows ?? []) if (!latestByBook[br.bookmaker]) latestByBook[br.bookmaker] = br;

    const oddsCol = { home: 'home_odds', draw: 'draw_odds', away: 'away_odds' };
    const depthRows = [];
    for (const o of OUTCOMES) {
      for (const br of Object.values(latestByBook)) {
        const px = parseFloat(br[oddsCol[o]]);
        if (!px || px <= 1) continue;
        depthRows.push({
          match_id: r.match_id, market_type: 'h2h', selection: o,
          bookmaker: br.bookmaker, odds: px, snapshot_type: snapType,
        });
      }
    }
    if (depthRows.length) {
      const { error: dErr } = await supabase.from('odds_snapshots').insert(depthRows);
      if (!dErr) snaps += depthRows.length;
    }

    // 2. Record new recommendations for value outcomes
    for (const o of OUTCOMES) {
      const isSignal = valBy[o] || (edgeBy[o] != null && edgeBy[o] >= SIGNAL_EDGE);
      if (!isSignal || !oddsBy[o]) continue;

      const { count } = await supabase
        .from('recommendations')
        .select('id', { count: 'exact', head: true })
        .eq('match_id', r.match_id).eq('selection', o);
      if (count) continue; // already recorded this signal

      const { error: rErr } = await supabase.from('recommendations').insert({
        match_id: r.match_id, selection: o,
        recommended_odds: oddsBy[o], bookmaker: bookBy[o],
        edge_at_signal: edgeBy[o], ai_probability: null,
        confidence_score: r.confidence_score, max_edge_score: r.max_edge_score,
        league, edge_bucket: edgeBucket(edgeBy[o] ?? 0),
        current_odds: oddsBy[o],
      });
      if (!rErr) recs++;
    }

    // 3. Back-fill CLV when a closing price exists
    if (snapType === 'closing') {
      const { data: openRecs } = await supabase
        .from('recommendations')
        .select('id, selection, recommended_odds, clv_pct')
        .eq('match_id', r.match_id);
      for (const rec of openRecs ?? []) {
        const closing = oddsBy[rec.selection];
        if (!closing || rec.clv_pct != null) continue;
        const clv = ((rec.recommended_odds - closing) / closing) * 100;
        await supabase.from('recommendations')
          .update({ closing_odds: closing, clv_pct: +clv.toFixed(2) })
          .eq('id', rec.id);
        clvUpdated++;
      }
    }
  }

  console.log(`[snapshot] done: snapshots=${snaps} newRecs=${recs} clvUpdated=${clvUpdated}`);
}

if (require.main === module) {
  run().catch(err => { console.error('[snapshot] fatal:', err.message); process.exit(1); });
}

module.exports = { run, edgeBucket };
