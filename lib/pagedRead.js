'use strict';

/**
 * lib/pagedRead — bounding a PostgREST read, both ways.
 *
 * TWO CAPS, INDEPENDENT, BOTH SILENT. A filter is a URL, so an `.in(...)` list
 * has a LENGTH limit; and a response has a 1,000-ROW limit. Neither announces
 * itself: an over-long request line is rejected by the transport before
 * Postgres sees it, and an over-large result is simply truncated. Both have
 * taken multi-day outages in this repo, and the second took two — the driving
 * query in captureSnapshot, and then its three prefetches, which were chunked
 * and therefore looked bounded.
 *
 * Extracted here because a second caller appeared. Two copies of a rule is how
 * the MODEL_SIGMA hand-copy failed twice in production without either copy
 * throwing.
 */

/**
 * Rows per `.in(...)` filter.
 *
 * A PostgREST filter is a URL. `.in('match_id', ids)` inlines every id, and a
 * uuid costs ~39 bytes once quoted and comma-separated — so 821 matches is a
 * ~32KB request line, which the transport rejects outright before Postgres ever
 * sees it. That is exactly what stopped this script: on 19 Aug 2026 it printed
 * its banner and then died in the prefetch stage on every single run, and
 * `odds_snapshots` had not been written since 18 Aug 14:17.
 *
 * 200 keeps a batch under ~8KB. The convention already existed in this repo —
 * captureIndependentLines.js slices, backfillMatchStats.js chunks, and
 * computeValues.js has a comment explaining the same hazard — this script just
 * never got it.
 */
const IN_CHUNK = 200;

/** PostgREST's own default cap. Pages are requested exactly this size so a
 *  short page is an unambiguous end-of-data signal. */
const PAGE_SIZE = 1000;

/**
 * PostgREST caps a response at 1000 rows and says nothing about it.
 *
 * THIS IS NOT A PERFORMANCE KNOB. `computed_values` held 1,509 rows against
 * that cap, so 509 were silently dropped on EVERY run — with no `order by`,
 * an arbitrary 509 — and only 96 of the 1,509 were upcoming fixtures. The
 * visible symptom was elsewhere entirely: `odds_snapshots` carried a `current`
 * h2h row for 11 of 65 board fixtures, so /api/match-card and /api/match-reads
 * had no anchor price to compare a forecast against on most of the board.
 *
 * ORDERED, because paging without one is not paging. Postgres may return rows
 * in any order between statements, so an unordered `.range()` walk can skip a
 * row and repeat another — the same failure the computeElo prune had. Page on
 * a UNIQUE column: a walk ordered by a column with ties has that same hazard
 * at every page boundary that lands inside a tie.
 *
 * @param {() => object} query builds a FRESH query — it is called once per page
 * @param {string} orderBy a stable, unique column to page on
 * @param {string} label   names the read in an error, so a throw is placeable
 */
async function pageAll(query, orderBy, label = 'paged read') {
  const out = [];
  for (let from = 0; ; from += PAGE_SIZE) {
    const { data, error } = await query()
      .order(orderBy, { ascending: true })
      .range(from, from + PAGE_SIZE - 1);
    if (error) throw new Error(`${label}: ${error.message}`);
    if (!data?.length) break;
    out.push(...data);
    if (data.length < PAGE_SIZE) break;
  }
  return out;
}

/**
 * Run a query over `ids` in IN_CHUNK-sized batches, PAGING EACH BATCH, and
 * concatenate the rows.
 *
 * THE TWO CAPS ARE INDEPENDENT AND BOTH BITE HERE. Chunking answers the URL
 * length limit — 200 ids keeps a request line under ~8KB. It says nothing
 * about how many ROWS come back, and these tables hold many rows per match:
 * measured 20 Aug 2026, one 200-match chunk of `odds_snapshots` over 7 days is
 * ~8,900 rows against a 1,000-row cap, so 86% of the existence data was being
 * discarded on every run. That Set is what decides `open` vs `current`, so 22
 * board fixtures could never graduate out of `open` however many times the
 * loop ran — and /api/match-card and /api/match-reads read `current` only.
 *
 * Chunking a read is therefore not evidence it is bounded. Bound it both ways.
 *
 * @param {string[]} ids
 * @param {string}   orderBy unique column to page each chunk on
 * @param {string}   label   names the read in an error
 * @param {(chunk: string[]) => object} buildQuery builds a FRESH query per page
 */
async function inChunks(ids, orderBy, label, buildQuery) {
  const out = [];
  for (let i = 0; i < ids.length; i += IN_CHUNK) {
    const chunk = ids.slice(i, i + IN_CHUNK);
    out.push(...await pageAll(() => buildQuery(chunk), orderBy, label));
  }
  return out;
}


module.exports = { pageAll, inChunks, IN_CHUNK, PAGE_SIZE };
