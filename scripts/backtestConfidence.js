#!/usr/bin/env node
'use strict';

/**
 * scripts/backtestConfidence.js — can component C of the MES be validated?
 *
 * SHORT ANSWER, AS AT 6 AUG 2026: NO. NOT ON THE DATA THAT EXISTS.
 *
 * Component C weights books_quoting, hours_to_kickoff and line stability at 15
 * of the 100 MES points, and it has never been shown to discriminate anything,
 * because it was pinned to a constant for every backtest that produced the
 * thresholds it feeds. The work order asks for it to be implemented and then
 * backtested separately. It is implemented (lib/marketAnchor.js `confidence()`).
 * This script is the honest answer to the second half.
 *
 * WHY IT CANNOT BE DONE YET. C needs three things per selection: how many books
 * were quoting, how long before kickoff the price was taken, and how far the
 * anchor had moved since it opened.
 *
 *   research_dc_preds — seven seasons, 16,480 matches, and the only corpus
 *     large enough to measure band separation. It carries a FIXED bookmaker
 *     panel, no capture timestamps and no intra-day line history. None of C's
 *     three inputs exist in it. Not a sample-size problem: the columns are
 *     absent.
 *
 *   odds_snapshots — has all three inputs (bookmaker, captured_at, and open
 *     against current). It covers 370 matches, of which 273 are settled with a
 *     score, and running the market-anchored gate over them yields FORTY gated
 *     selections in total.
 *
 * Forty selections cannot separate three bands. PRIME/STRONG/TRACKED would hold
 * roughly a dozen each, and a dozen bets at these prices has a yield standard
 * error near 30 percentage points — wide enough to contain every hypothesis
 * anyone might have. Any table this script printed would be a number-shaped
 * object, not a measurement, and the one thing this architecture exists to stop
 * is a column named after what it was meant to hold.
 *
 * So the script measures what it can, states the sample it had, and refuses to
 * draw the conclusion. It will become useful on its own as odds_snapshots
 * accumulates; the gating rate is about 5% of selections, so a usable sample of
 * ~400 gated selections needs roughly 2,700 more settled matches with full
 * snapshot coverage.
 *
 * WHAT TO DO IN THE MEANTIME. Treat C as unvalidated, which is what
 * `CONFIDENCE_IS_UNVALIDATED` says in lib/marketAnchor.js. Do not cite it as a
 * reason a signal scored well. Do not tune its sub-weights — there is nothing
 * to tune them against.
 *
 * Usage:  node scripts/backtestConfidence.js
 */

const ma = require('../lib/marketAnchor');
const { shinDevig } = require('../lib/devig');
const { pageAll, inChunks } = require('../lib/pagedRead');

/** Below this many gated, settled selections, band separation is not measurable. */
const MIN_SAMPLE_FOR_BAND_SEPARATION = 400;

const num = x => {
  if (x == null || x === '') return NaN;
  const n = Number(x);
  return Number.isFinite(n) ? n : NaN;
};

const SELECTIONS = ['home', 'draw', 'away'];
const BETTABLE = new Set(ma.BETTABLE_BOOKS);

// PAGED ON `id`, NOT `captured_at`. A page boundary landing inside a tie can
// skip one row and repeat another, and the ties here are large: 45 rows share a
// single timestamp to the microsecond, and a whole cycle shares one instant now
// that captured_at is the cycle's own stamp. Nothing downstream needs the order.
const fetchSnapshots = (supabase) => pageAll(() => supabase
  .from('odds_snapshots')
  .select('id, match_id, bookmaker, selection, odds, snapshot_type, captured_at')
  .eq('market_type', 'h2h'), 'id', 'odds_snapshots');

async function main() {
  const { getClient } = require('../lib/supabaseClient');
  const supabase = getClient();

  // SNAPSHOTS FIRST, THEN THE MATCHES THEY NAME — and that order is the fix.
  //
  // This used to select every completed match and then filter the snapshots
  // down to them. `matches` holds 92,511 completed rows against PostgREST's
  // silent 1,000-row cap, so it received an ARBITRARY 1.1% of the table, and
  // the ~347 fixtures that actually carry an h2h snapshot would almost all
  // have been filtered away against it. The script would have printed a
  // sample of near zero and called it the state of the corpus.
  //
  // Fetching the other way round is both correct and far cheaper: the
  // snapshot table names its own fixtures, so only those are looked up, in
  // IN_CHUNK-sized batches that are themselves paged.
  const allSnaps = await fetchSnapshots(supabase);
  const snapMatchIds = [...new Set(allSnaps.map(s => s.match_id).filter(Boolean))];

  const matches = await inChunks(snapMatchIds, 'id', 'matches', (chunk) => supabase
    .from('matches')
    .select('id, kickoff_at, status, goals_home, goals_away')
    .in('id', chunk)
    .eq('status', 'completed')
    .not('goals_home', 'is', null));

  const byId = new Map(matches.map(m => [m.id, m]));
  const snaps = allSnaps.filter(s => byId.has(s.match_id));

  // Latest price per (match, book, selection, snapshot_type).
  const latest = new Map();
  for (const s of snaps) {
    const k = `${s.match_id}|${s.bookmaker}|${s.selection}|${s.snapshot_type}`;
    const prev = latest.get(k);
    if (!prev || s.captured_at > prev.captured_at) latest.set(k, s);
  }

  const perMatch = new Map();
  for (const s of latest.values()) {
    if (!perMatch.has(s.match_id)) perMatch.set(s.match_id, []);
    perMatch.get(s.match_id).push(s);
  }

  const gated = [];
  for (const [matchId, rows] of perMatch) {
    const m = byId.get(matchId);
    const pick = (book, sel, type) =>
      num(rows.find(r => r.bookmaker === book && r.selection === sel && r.snapshot_type === type)?.odds);

    const anchorNow = SELECTIONS.map(s => pick('pinnacle', s, 'current'));
    const anchorOpen = SELECTIONS.map(s => pick('pinnacle', s, 'open'));
    const fairNow = shinDevig(anchorNow);
    if (fairNow.probs === null) continue;
    const fairOpen = shinDevig(anchorOpen);

    const result = m.goals_home > m.goals_away ? 'home'
                 : m.goals_home < m.goals_away ? 'away' : 'draw';

    SELECTIONS.forEach((sel, i) => {
      const quotes = rows
        .filter(r => r.selection === sel && r.snapshot_type === 'current' && BETTABLE.has(r.bookmaker))
        .map(r => ({ bookmaker: r.bookmaker, odds: r.odds }));
      const best = ma.bestBettablePrice(quotes);
      if (best.price === null) return;

      const captured = rows.find(r => r.selection === sel && r.snapshot_type === 'current')?.captured_at;
      const hoursToKickoff = (captured && m.kickoff_at)
        ? (new Date(m.kickoff_at) - new Date(captured)) / 3_600_000
        : undefined;
      const drift = fairOpen.probs ? fairNow.probs[i] - fairOpen.probs[i] : undefined;

      const ev = ma.evaluate({
        fairProb: fairNow.probs[i],
        bestPrice: best.price,
        bestBook: best.book,
        booksQuoting: best.booksQuoting,
        hoursToKickoff,
        fairProbDriftSinceOpen: drift,
      });
      if (!ev.passes) return;
      gated.push({ ...ev, won: result === sel, price: best.price });
    });
  }

  console.log(`\nSettled matches with snapshots : ${perMatch.size}`);
  console.log(`Gated selections               : ${gated.length}`);
  console.log(`Needed for band separation     : ${MIN_SAMPLE_FOR_BAND_SEPARATION}\n`);

  const byBand = {};
  for (const g of gated) (byBand[g.band] ??= []).push(g);
  for (const band of ['PRIME', 'STRONG']) {
    const list = byBand[band] ?? [];
    const y = list.length
      ? (100 * list.reduce((t, s) => t + (s.won ? s.price - 1 : -1), 0) / list.length).toFixed(2)
      : '—';
    // Yield standard error, so the width of the claim is visible next to it.
    const se = list.length
      ? (100 * Math.sqrt(list.reduce((t, s) => {
          const p = s.won ? s.price - 1 : -1;
          return t + p * p;
        }, 0) / list.length) / Math.sqrt(list.length)).toFixed(1)
      : '—';
    console.log(`  ${band.padEnd(7)} n=${String(list.length).padStart(4)}  yield ${String(y).padStart(8)}%  ±${se}pp (1 s.e.)`);
  }

  if (gated.length < MIN_SAMPLE_FOR_BAND_SEPARATION) {
    console.log(`\n  ⚠ SAMPLE TOO SMALL. ${gated.length} gated selections cannot separate bands.`);
    console.log('    Component C remains UNVALIDATED. Do not tune its sub-weights against');
    console.log('    this output, and do not cite it as a reason a signal scored well.');
    console.log('    Re-run when odds_snapshots has accumulated materially more settled');
    console.log('    coverage; the gating rate is ~5% of selections.\n');
    process.exitCode = 0;   // not a failure — a correct report of insufficient data
  } else {
    console.log('\n  Sample is now large enough. Compare band yields above, and re-read');
    console.log('  whether C earns its 15 points before leaving it in the score.\n');
  }
}

if (require.main === module) {
  main().catch(err => { console.error(err.message); process.exit(1); });
}
