/**
 * Max Edge — Snapshot & CLV capture (Features #1 CLV, #7 Market Movement)
 *
 * Run this on a schedule (every 15–30 min, and crucially in the final hour
 * before each kickoff). Each run:
 *   1. Snapshots current best soft odds per outcome into odds_snapshots, tagging
 *      the row 'open' (first ever for the match), 'closing' (<60 min to kickoff),
 *      or 'current' otherwise.
 *   2. Creates a recommendation row for any outcome currently flagged as value
 *      that we haven't already recorded — freezing the signal odds + edge.
 *   3. Back-fills CLV on recommendations whose match now has a closing price.
 *
 * DB efficiency (P2-1 fix): 3 parallel bulk reads before the loop replace
 * 120+ serial round-trips per run:
 *   Bulk 1 — prefetchSnapshotExistence : Set<matchId>         (snap type: open vs current)
 *   Bulk 2 — prefetchLatestOdds        : Map<matchId, byBook> (depth row source)
 *   Bulk 3 — prefetchRecommendations   : existingRecsMap + openRecsForClv
 * Inside the loop every lookup is O(1). The only remaining DB round-trips are
 * write operations (upserts and updates) which cannot be avoided.
 *
 * CLV % = ((recommended_odds − closing_odds) / closing_odds) × 100
 *
 * Usage: export $(cat .env | xargs) && node captureSnapshot.js
 */

'use strict';

const { getClient } = require('./lib/supabaseClient');

const CLOSING_WINDOW_MIN = 60;
const SIGNAL_EDGE        = parseFloat(process.env.SIGNAL_EDGE || '0.02'); // 2 pp minimum

const OUTCOMES = ['home', 'draw', 'away'];
const ODDS_COL = { home: 'home_odds', draw: 'draw_odds', away: 'away_odds' };

// Secondary markets are stored as a single best price per selection in
// computed_values (not per-book), so we snapshot one row per selection under a
// synthetic 'best' bookmaker. market_type matches the detail page / value_signals
// taxonomy (totals | btts | corners | bookings). This builds the price history
// the secondary-market charts read via fetchMarketSeries.
const SECONDARY_SNAP = [
  { market: 'totals',   selection: 'over',     col: 'over_odds' },
  { market: 'totals',   selection: 'under',    col: 'under_odds' },
  { market: 'btts',     selection: 'btts_yes', col: 'btts_yes_odds' },
  { market: 'btts',     selection: 'btts_no',  col: 'btts_no_odds' },
  { market: 'corners',  selection: 'over',     col: 'corners_over_odds' },
  { market: 'corners',  selection: 'under',    col: 'corners_under_odds' },
  { market: 'bookings', selection: 'over',     col: 'bookings_over_odds' },
  { market: 'bookings', selection: 'under',    col: 'bookings_under_odds' },
];

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function edgeBucket(edge) {
  const pp = edge * 100;
  if (pp < 2)  return '0-2';
  if (pp < 4)  return '2-4';
  if (pp < 6)  return '4-6';
  if (pp < 10) return '6-10';
  return '10+';
}

// ---------------------------------------------------------------------------
// Bulk prefetch functions (each fires exactly one query)
// ---------------------------------------------------------------------------

/**
 * Which of the given match_ids have at least one existing odds_snapshot?
 *
 * A 7-day window is used because computed_values only contains upcoming
 * matches whose kickoffs are in the near future — any match with an existing
 * snapshot will have had it captured within the past week.
 *
 * @param {import('@supabase/supabase-js').SupabaseClient} supabase
 * @param {string[]} matchIds
 * @param {string}   since7dIso  — ISO timestamp 7 days ago
 * @returns {Promise<Set<string>>}
 */
async function prefetchSnapshotExistence(supabase, matchIds, since7dIso) {
  const { data, error } = await supabase
    .from('odds_snapshots')
    .select('match_id')
    .in('match_id', matchIds)
    .gte('captured_at', since7dIso);
  if (error) throw new Error(`prefetchSnapshotExistence: ${error.message}`);

  // Deduplicate in JS — we only need existence, not row count.
  return new Set((data ?? []).map(r => r.match_id));
}

/**
 * Latest h2h odds row per (match_id, bookmaker) for all provided matches.
 *
 * Fetches all h2h rows from the last 48 hours in descending fetched_at order.
 * The first occurrence of each (match_id, bookmaker) key in the result is the
 * most recent row — this is the JavaScript equivalent of DISTINCT ON.
 * 48 hours is sufficient because ingestOdds runs at least hourly.
 *
 * @param {import('@supabase/supabase-js').SupabaseClient} supabase
 * @param {string[]} matchIds
 * @param {string}   since48hIso
 * @returns {Promise<Map<string, Map<string, object>>>}
 *   Outer key: matchId.  Inner key: bookmaker.  Value: odds row.
 */
async function prefetchLatestOdds(supabase, matchIds, since48hIso) {
  const { data, error } = await supabase
    .from('odds')
    .select('match_id, bookmaker, home_odds, draw_odds, away_odds, fetched_at')
    .in('match_id', matchIds)
    .eq('market', 'h2h')
    .gte('fetched_at', since48hIso)
    .order('fetched_at', { ascending: false });
  if (error) throw new Error(`prefetchLatestOdds: ${error.message}`);

  const map = new Map();
  for (const row of data ?? []) {
    if (!map.has(row.match_id)) map.set(row.match_id, new Map());
    const byBook = map.get(row.match_id);
    // First occurrence = latest (DESC order). Never overwrite.
    if (!byBook.has(row.bookmaker)) byBook.set(row.bookmaker, row);
  }
  return map;
}

/**
 * All recommendations for the given matches in one query.
 * Builds two structures simultaneously:
 *
 *   existingRecsMap  Map<matchId, Set<selection>>
 *     — O(1) lookup for "has this (match, outcome) already been signalled?"
 *
 *   openRecsForClv   Map<matchId, rec[]>
 *     — CLV backfill candidates: recs with clv_pct IS NULL whose match is
 *       now in the closing window.
 *
 * @param {import('@supabase/supabase-js').SupabaseClient} supabase
 * @param {string[]} matchIds
 * @returns {Promise<{existingRecsMap: Map<string, Set<string>>, openRecsForClv: Map<string, object[]>}>}
 */
async function prefetchRecommendations(supabase, matchIds) {
  const { data, error } = await supabase
    .from('recommendations')
    .select('id, match_id, selection, recommended_odds, clv_pct')
    .in('match_id', matchIds);
  if (error) throw new Error(`prefetchRecommendations: ${error.message}`);

  const existingRecsMap = new Map();
  const openRecsForClv  = new Map();

  for (const rec of data ?? []) {
    // Signal dedup map
    if (!existingRecsMap.has(rec.match_id)) existingRecsMap.set(rec.match_id, new Set());
    existingRecsMap.get(rec.match_id).add(rec.selection);

    // CLV candidates — only those still missing a closing price
    if (rec.clv_pct == null) {
      if (!openRecsForClv.has(rec.match_id)) openRecsForClv.set(rec.match_id, []);
      openRecsForClv.get(rec.match_id).push(rec);
    }
  }

  return { existingRecsMap, openRecsForClv };
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function run() {
  console.log(`\n[snapshot] ${new Date().toISOString()}`);
  const supabase = getClient();

  // Primary data source — all active computed_values rows with match metadata
  const { data: rows, error: cvErr } = await supabase
    .from('computed_values')
    .select(`
      match_id, best_outcome, confidence_score, max_edge_score,
      best_home_odds, best_draw_odds, best_away_odds,
      best_home_book, best_draw_book, best_away_book,
      home_edge, draw_edge, away_edge,
      home_value, draw_value, away_value,
      over_odds, under_odds,
      btts_yes_odds, btts_no_odds,
      corners_over_odds, corners_under_odds,
      bookings_over_odds, bookings_under_odds,
      match:matches ( kickoff_at, league:leagues ( name ) )
    `);
  if (cvErr) throw new Error(`computed_values fetch: ${cvErr.message}`);

  if (!rows?.length) {
    console.log('[snapshot] no computed_values rows — nothing to snapshot');
    return { snaps: 0, recs: 0, clvUpdated: 0, writeErrors: 0 };
  }

  // hour_bucket: UTC epoch ms / ms-per-hour, truncated to integer.
  // Date.now() is always UTC epoch milliseconds — this calculation is
  // timezone-independent on any server locale, including local macOS runners.
  const now        = Date.now();
  const hourBucket = Math.floor(now / 3_600_000);

  const matchIds = [...new Set(rows.map(r => r.match_id).filter(Boolean))];

  const since48hIso = new Date(now - 48 * 60 * 60 * 1000).toISOString();
  const since7dIso  = new Date(now -  7 * 24 * 60 * 60 * 1000).toISOString();

  // ── 3 parallel bulk reads — fires all three simultaneously, one network RTT ─
  const [snapshotExistsSet, latestOddsMap, { existingRecsMap, openRecsForClv }] =
    await Promise.all([
      prefetchSnapshotExistence(supabase, matchIds, since7dIso),
      prefetchLatestOdds(supabase, matchIds, since48hIso),
      prefetchRecommendations(supabase, matchIds),
    ]);

  console.log(
    `[snapshot] prefetch complete — ` +
    `${rows.length} match(es) | ` +
    `${snapshotExistsSet.size} with existing snapshots | ` +
    `${latestOddsMap.size} with recent odds`,
  );

  let snaps = 0, recs = 0, clvUpdated = 0, writeErrors = 0;

  for (const r of rows) {
    const kickoff    = r.match?.kickoff_at ? new Date(r.match.kickoff_at).getTime() : null;
    const minsToKick = kickoff != null ? (kickoff - now) / 60000 : null;
    const league     = r.match?.league?.name ?? null;

    const oddsBy = { home: r.best_home_odds, draw: r.best_draw_odds, away: r.best_away_odds };
    const bookBy = { home: r.best_home_book, draw: r.best_draw_book, away: r.best_away_book };
    const edgeBy = { home: r.home_edge,      draw: r.draw_edge,      away: r.away_edge };
    const valBy  = { home: r.home_value,     draw: r.draw_value,     away: r.away_value };

    // ── 1. Snap type — O(1) Set lookup, zero DB calls ────────────────────────
    let snapType = 'current';
    if (minsToKick != null && minsToKick <= CLOSING_WINDOW_MIN && minsToKick > -180) {
      snapType = 'closing';
    } else if (!snapshotExistsSet.has(r.match_id)) {
      snapType = 'open';
    }

    // ── 2. Depth rows — O(1) Map lookup, zero DB calls ───────────────────────
    const byBook    = latestOddsMap.get(r.match_id) ?? new Map();
    const depthRows = [];

    for (const o of OUTCOMES) {
      for (const [, br] of byBook) {
        const px = parseFloat(br[ODDS_COL[o]]);
        if (!Number.isFinite(px) || px <= 1) continue;
        depthRows.push({
          match_id:      r.match_id,
          market_type:   'h2h',
          selection:     o,
          bookmaker:     br.bookmaker,
          odds:          px,
          snapshot_type: snapType,
          hour_bucket:   hourBucket,
        });
      }
    }

    // Secondary markets — one best-price row per selection (see SECONDARY_SNAP).
    for (const s of SECONDARY_SNAP) {
      const px = parseFloat(r[s.col]);
      if (!Number.isFinite(px) || px <= 1) continue;
      depthRows.push({
        match_id:      r.match_id,
        market_type:   s.market,
        selection:     s.selection,
        bookmaker:     'best',
        odds:          px,
        snapshot_type: snapType,
        hour_bucket:   hourBucket,
      });
    }

    if (depthRows.length) {
      const { error: dErr } = await supabase
        .from('odds_snapshots')
        .upsert(depthRows, { onConflict: 'match_id,bookmaker,selection,market_type,hour_bucket' });

      if (dErr) {
        // Explicit error — not silently swallowed. Tracked so caller can exit non-zero.
        console.error(`[snapshot] odds_snapshots upsert failed (match=${r.match_id}): ${dErr.message}`);
        writeErrors++;
      } else {
        snaps += depthRows.length;
        // Mark in-memory so any second occurrence of this match_id in this
        // run gets snapType = 'current', not 'open'.
        snapshotExistsSet.add(r.match_id);
      }
    }

    // ── 3. Signal recording — O(1) Set lookup, zero DB reads ─────────────────
    // existingSelections is the live mutable set for this match_id.
    // We mutate it after each insert so duplicates within this run are caught.
    const existingSelections = existingRecsMap.get(r.match_id) ?? new Set();
    if (!existingRecsMap.has(r.match_id)) existingRecsMap.set(r.match_id, existingSelections);

    for (const o of OUTCOMES) {
      const isSignal = valBy[o] || (edgeBy[o] != null && edgeBy[o] >= SIGNAL_EDGE);
      if (!isSignal || !oddsBy[o]) continue;
      if (existingSelections.has(o)) continue; // already recorded

      const { error: rErr } = await supabase.from('recommendations').insert({
        match_id:         r.match_id,
        selection:        o,
        recommended_odds: oddsBy[o],
        bookmaker:        bookBy[o],
        edge_at_signal:   edgeBy[o],
        ai_probability:   null,
        confidence_score: r.confidence_score,
        max_edge_score:   r.max_edge_score,
        league,
        edge_bucket:      edgeBucket(edgeBy[o] ?? 0),
        current_odds:     oddsBy[o],
      });

      if (rErr) {
        console.error(`[snapshot] recommendation insert failed (match=${r.match_id} sel=${o}): ${rErr.message}`);
        writeErrors++;
      } else {
        recs++;
        existingSelections.add(o); // prevent duplicate within this run
      }
    }

    // ── 4. CLV backfill — O(1) Map lookup, writes only in closing window ─────
    if (snapType === 'closing') {
      const openRecs = openRecsForClv.get(r.match_id) ?? [];

      for (const rec of openRecs) {
        // Skip if already backfilled in a prior iteration of this run
        if (rec.clv_pct != null) continue;

        const closing     = parseFloat(oddsBy[rec.selection]);
        const detectedOdds = parseFloat(rec.recommended_odds);

        // Both prices must be valid European odds (> 1.0) — guard against
        // null/NaN propagating into the CLV calculation.
        if (!Number.isFinite(closing) || closing <= 1) continue;
        if (!Number.isFinite(detectedOdds) || detectedOdds <= 1) continue;

        const clv = ((detectedOdds - closing) / closing) * 100;

        const { error: clvErr } = await supabase
          .from('recommendations')
          .update({ closing_odds: closing, clv_pct: +clv.toFixed(2) })
          .eq('id', rec.id);

        if (clvErr) {
          console.error(`[snapshot] CLV update failed (rec=${rec.id}): ${clvErr.message}`);
          writeErrors++;
        } else {
          clvUpdated++;
          rec.clv_pct = clv; // mark as done to prevent re-processing
        }
      }
    }
  }

  const summary = { snaps, recs, clvUpdated, writeErrors };
  console.log('[snapshot] done:', summary);

  if (writeErrors > 0) {
    // Surface the error count as a fatal exit so GitHub Actions marks the
    // step failed and the on-call alert fires. All write errors are already
    // logged individually above.
    throw new Error(`[snapshot] completed with ${writeErrors} write error(s) — see logs above`);
  }

  return summary;
}

if (require.main === module) {
  run().catch(err => { console.error('[snapshot] fatal:', err.message); process.exit(1); });
}

module.exports = { run, edgeBucket };
