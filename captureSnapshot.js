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
const { pageAll, inChunks, IN_CHUNK, PAGE_SIZE } = require('./lib/pagedRead');

const CLOSING_WINDOW_MIN = 60;
const SIGNAL_EDGE        = parseFloat(process.env.SIGNAL_EDGE || '0.02'); // 2 pp minimum

/** Epoch ms for a timestamp, or -Infinity if it cannot be read as one. */
function tsOf(v) {
  const t = v == null ? NaN : new Date(v).getTime();
  return Number.isFinite(t) ? t : -Infinity;
}

/**
 * One odds_snapshots row.
 *
 * `stamp` carries the three fields every row in a cycle shares — the tag, the
 * bucket and the instant — so a call site cannot supply two of them and forget
 * the third. That is not hypothetical: `captured_at` was missing from both
 * payloads for the life of the file, which left the upsert updating the price
 * and the tag while the timestamp stayed at the row's first write.
 */
function snapshotRow({ matchId, marketType, selection, bookmaker, odds, stamp }) {
  return {
    match_id:      matchId,
    market_type:   marketType,
    selection,
    bookmaker,
    odds,
    snapshot_type: stamp.snapType,
    hour_bucket:   stamp.hourBucket,
    captured_at:   stamp.capturedAt,
  };
}

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
  // `id` and not `captured_at`: a whole cycle's rows share a timestamp to the
  // millisecond, so paging on it would straddle a tie at every boundary.
  const data = await inChunks(matchIds, 'id', 'prefetchSnapshotExistence',
    (chunk) => supabase
      .from('odds_snapshots')
      .select('id, match_id')
      .in('match_id', chunk)
      .gte('captured_at', since7dIso));

  // Deduplicate in JS — we only need existence, not row count.
  return new Set(data.map(r => r.match_id));
}

/**
 * Latest h2h odds row per (match_id, bookmaker) for all provided matches.
 *
 * Fetches all h2h rows from the last 48 hours and keeps the latest per
 * (match_id, bookmaker). 48 hours is sufficient because ingestOdds runs at
 * least hourly.
 *
 * IT COMPARES `fetched_at` RATHER THAN TRUSTING ARRIVAL ORDER. This used to
 * take the first occurrence of each key out of a `fetched_at DESC` result,
 * which is only "latest" while the server's order survives to here — and it
 * does not once a read is paged, because pages are walked by `id` ascending.
 * A max is correct under any arrival order, which is the property worth having
 * whatever the transport does next.
 *
 * @param {import('@supabase/supabase-js').SupabaseClient} supabase
 * @param {string[]} matchIds
 * @param {string}   since48hIso
 * @returns {Promise<Map<string, Map<string, object>>>}
 *   Outer key: matchId.  Inner key: bookmaker.  Value: odds row.
 */
async function prefetchLatestOdds(supabase, matchIds, since48hIso) {
  const data = await inChunks(matchIds, 'id', 'prefetchLatestOdds',
    (chunk) => supabase
      .from('odds')
      .select('id, match_id, bookmaker, home_odds, draw_odds, away_odds, fetched_at')
      .in('match_id', chunk)
      .eq('market', 'h2h')
      .gte('fetched_at', since48hIso));

  const map = new Map();
  for (const row of data) {
    if (!map.has(row.match_id)) map.set(row.match_id, new Map());
    const byBook = map.get(row.match_id);
    const held = byBook.get(row.bookmaker);
    // Keep the later quote. An unparseable timestamp loses to a real one and
    // ties keep the incumbent, so the map never holds a row we cannot date.
    if (!held || tsOf(row.fetched_at) > tsOf(held.fetched_at)) {
      byBook.set(row.bookmaker, row);
    }
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
  // 451 rows across the whole table today, well under the cap — paged anyway,
  // because "small enough right now" is exactly what `computed_values` was
  // until it passed a thousand rows and started dropping them in silence.
  const data = await inChunks(matchIds, 'id', 'prefetchRecommendations',
    (chunk) => supabase
      .from('recommendations')
      .select('id, match_id, selection, recommended_odds, clv_pct')
      .in('match_id', chunk));

  const existingRecsMap = new Map();
  const openRecsForClv  = new Map();

  for (const rec of data) {
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
  const rows = await pageAll(() => supabase
    .from('computed_values')
    .select(`
      id, match_id, best_outcome, confidence_score, max_edge_score,
      best_home_odds, best_draw_odds, best_away_odds,
      best_home_book, best_draw_book, best_away_book,
      home_edge, draw_edge, away_edge,
      home_value, draw_value, away_value,
      over_odds, under_odds,
      btts_yes_odds, btts_no_odds,
      corners_over_odds, corners_under_odds,
      bookings_over_odds, bookings_under_odds,
      match:matches ( kickoff_at, league:leagues ( name ) )
    `), 'id', 'computed_values');

  if (!rows?.length) {
    console.log('[snapshot] no computed_values rows — nothing to snapshot');
    return { snaps: 0, recs: 0, clvUpdated: 0, writeErrors: 0 };
  }

  // hour_bucket: UTC epoch ms / ms-per-hour, truncated to integer.
  // Date.now() is always UTC epoch milliseconds — this calculation is
  // timezone-independent on any server locale, including local macOS runners.
  const now        = Date.now();
  const hourBucket = Math.floor(now / 3_600_000);

  // THE ROW'S TIMESTAMP MUST BE THE ROW'S TIMESTAMP.
  //
  // `captured_at` was a column default, so it was written on INSERT and never
  // again — while `odds` and `snapshot_type` ARE overwritten, because the
  // upsert below conflicts on (match, book, selection, market, hour_bucket)
  // and every re-run inside the same hour lands on the same physical row. The
  // row therefore carried the LATEST price under the FIRST time it was seen,
  // and nothing about it looked wrong.
  //
  // It cost two false readings on 20 Aug 2026, in opposite directions. A cycle
  // that promoted 22 fixtures from `open` to `current` in place reported "5
  // fixtures written", because only 5 rows were new. And a query asking when
  // each fixture first reached `current` answered 12:25–12:27 for all of them,
  // which is when the ROWS were created, not when they were tagged — evidence
  // that looked strong enough to retract a correct result over.
  //
  // Stamped from the SAME `now` that derives hour_bucket, deliberately, and
  // not from a DB trigger's now(): a batch that crosses the hour boundary
  // would otherwise stamp a row into the next hour while its bucket says this
  // one, and those two fields have to agree.
  //
  // NOT BACKFILLED. Every existing row's last-write time is unrecoverable, and
  // inventing one would put noise on the only price history the product has —
  // the same ruling as `gap_basis`. Rows written before this change mean
  // "first seen"; rows after mean "last confirmed".
  const capturedAt = new Date(now).toISOString();

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

    // What every row this fixture writes shares. snapType varies per fixture;
    // the bucket and the instant are the cycle's and are the same throughout.
    const stamp = { snapType, hourBucket, capturedAt };

    // ── 2. Depth rows — O(1) Map lookup, zero DB calls ───────────────────────
    const byBook    = latestOddsMap.get(r.match_id) ?? new Map();
    const depthRows = [];

    for (const o of OUTCOMES) {
      for (const [, br] of byBook) {
        const px = parseFloat(br[ODDS_COL[o]]);
        if (!Number.isFinite(px) || px <= 1) continue;
        depthRows.push(snapshotRow({
          matchId: r.match_id, marketType: 'h2h', selection: o,
          bookmaker: br.bookmaker, odds: px, stamp,
        }));
      }
    }

    // Secondary markets — one best-price row per selection (see SECONDARY_SNAP).
    for (const s of SECONDARY_SNAP) {
      const px = parseFloat(r[s.col]);
      if (!Number.isFinite(px) || px <= 1) continue;
      depthRows.push(snapshotRow({
        matchId: r.match_id, marketType: s.market, selection: s.selection,
        bookmaker: 'best', odds: px, stamp,
      }));
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

module.exports = {
  run, edgeBucket, inChunks, IN_CHUNK, pageAll, PAGE_SIZE, prefetchLatestOdds,
  snapshotRow,
};
