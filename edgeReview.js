'use strict';

/**
 * EVE / Max Edge — Daily edge review
 *
 * Answers two questions every morning, from results rather than from a hunch:
 *
 *   1. What settled yesterday, and how did each tier do?
 *   2. Given everything that has now settled, is the PRIME edge band still the
 *      right band — and if not, what does the evidence say it should be?
 *
 * WHY THIS EXISTS. The PRIME box in lib/signalTier.js (odds 1.40-3.00, edge
 * 4-10%) was chosen as the best cell of a matrix computed over Jun 15 - Jul 3.
 * That is a legitimate way to form a hypothesis and a terrible way to hold one:
 * the maximum of a set of noisy estimates is biased upward, so a band picked
 * that way is expected to look worse afterwards even if it is genuinely the
 * best band. Until the box is re-measured on results it did not come from, its
 * edge numbers are an estimate wearing the costume of a finding.
 *
 * WHAT IT WILL NOT DO. It never edits a threshold. Moving the PRIME box is a
 * human edit to lib/signalTier.js, and this job's entire output is the evidence
 * for or against making it. A band that re-fits itself nightly would chase
 * every bad weekend and would stop being a band at all.
 *
 * Read-only against value_signals; writes one snapshot row per day to
 * edge_calibration (migration 045) so the answer's DRIFT is visible — which is
 * more informative than any single day's answer.
 *
 * Usage:
 *   export $(cat .env | xargs) && node edgeReview.js
 *   node edgeReview.js --days=7          # widen the "what settled" window
 *   node edgeReview.js --no-write        # print only, no snapshot row
 *   node edgeReview.js --json            # machine-readable dump
 */

const { getClient } = require('./lib/supabaseClient');
const { classifyTier, THRESHOLDS } = require('./lib/signalTier');
const {
  summarise,
  applyBox,
  edgeBandTable,
  oddsBandTable,
  sweepBoxes,
  recommend,
  profitOf,
  CURRENT_BOX,
} = require('./lib/edgeCalibration');

// The window the current PRIME box was fitted on ends here. Rows detected at or
// after this instant are out-of-sample for that box and are the only rows that
// can confirm it. Shared with fetchResults.js's performance epoch on purpose:
// it is the same clean-slate line, and having two would guarantee they drift.
const PERFORMANCE_EPOCH = process.env.PERFORMANCE_EPOCH || '2026-07-03T18:30:00Z';

const PAGE = 1000;
const RULE = '='.repeat(78);
const SUB = '-'.repeat(78);

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

function parseArgs(argv) {
  const flag = name => argv.includes(`--${name}`);
  const val = (name, dflt) => {
    const hit = argv.find(a => a.startsWith(`--${name}=`));
    return hit ? hit.slice(name.length + 3) : dflt;
  };
  return {
    days: Math.max(1, Number(val('days', 1)) || 1),
    write: !flag('no-write'),
    json: flag('json'),
    includeSupermodel: flag('include-supermodel'),
    minSample: Number(val('min-sample', 100)) || 100,
    confirmSample: Number(val('confirm-sample', 200)) || 200,
  };
}

// ---------------------------------------------------------------------------
// Formatting
// ---------------------------------------------------------------------------

const pct = (v, dp = 1) => (v == null ? '   —  ' : `${v >= 0 ? '+' : ''}${(v * 100).toFixed(dp)}%`);
const rate = (v, dp = 1) => (v == null ? '  — ' : `${(v * 100).toFixed(dp)}%`);
const dec = (v, dp = 2) => (v == null ? ' — ' : v.toFixed(dp));

const edgeLabel = (lo, hi) =>
  `${(lo * 100).toFixed(0)}%${hi == null ? '+' : `–${(hi * 100).toFixed(0)}%`}`;

const oddsLabel = (lo, hi) =>
  `${lo.toFixed(2)}${Number.isFinite(hi) ? `–${hi.toFixed(2)}` : '+'}`;

/** Renders rows as a fixed-width table. `cols` = [{head, width, align, get}]. */
function table(rows, cols) {
  const pad = (s, w, align) => {
    s = String(s);
    if (s.length > w) s = s.slice(0, w);
    return align === 'l' ? s.padEnd(w) : s.padStart(w);
  };
  const head = cols.map(c => pad(c.head, c.width, c.align ?? 'r')).join('  ');
  const line = cols.map(c => '-'.repeat(c.width)).join('  ');
  const body = rows.map(r => cols.map(c => pad(c.get(r), c.width, c.align ?? 'r')).join('  '));
  return [head, line, ...body].map(l => `  ${l}`).join('\n');
}

/**
 * A flag on any cell whose sample cannot support a conclusion. Printed rather
 * than hidden: a table of tiny cells looks exactly like a table of real ones,
 * and that resemblance is how a 2-bet band at +180% ends up in a decision.
 */
const thin = n => (n < 30 ? ' ·thin' : '');

// ---------------------------------------------------------------------------
// Fetch
// ---------------------------------------------------------------------------

/** Pages through a table — Supabase caps an unranged select at 1000 rows. */
async function fetchAll(supabase, build) {
  const out = [];
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await build().range(from, from + PAGE - 1);
    if (error) throw new Error(error.message);
    out.push(...(data ?? []));
    if (!data || data.length < PAGE) break;
  }
  return out;
}

const SIGNAL_COLUMNS =
  'id, match_id, outcome, market, market_line, phase, model_architecture, ' +
  'detected_at, detected_odds, detected_edge, detected_mes, result, clv, ' +
  'no_vig_clv, kickoff_at, signal_category';

async function fetchSettled(supabase) {
  return fetchAll(supabase, () =>
    supabase
      .from('value_signals')
      .select(SIGNAL_COLUMNS)
      .in('result', ['win', 'loss'])
      .order('detected_at', { ascending: true }));
}

/** The review window, with team names — a separate, narrow query on purpose. */
async function fetchWindow(supabase, sinceIso) {
  const { data, error } = await supabase
    .from('value_signals')
    .select(`${SIGNAL_COLUMNS}, match:matches (
      home_team:teams!matches_home_team_id_fkey ( name ),
      away_team:teams!matches_away_team_id_fkey ( name )
    )`)
    .in('result', ['win', 'loss'])
    .gte('kickoff_at', sinceIso)
    .order('kickoff_at', { ascending: true });
  if (error) throw new Error(error.message);
  return data ?? [];
}

// ---------------------------------------------------------------------------
// Section 1 — what actually settled
// ---------------------------------------------------------------------------

const fixtureOf = r => {
  const h = r.match?.home_team?.name ?? '?';
  const a = r.match?.away_team?.name ?? '?';
  return `${h} v ${a}`;
};

const selectionOf = r => {
  const line = r.market_line != null ? ` ${r.market_line}` : '';
  return `${r.market ?? 'h2h'}:${r.outcome}${line}`;
};

function printSettledWindow(rows, days) {
  console.log(`\n📋 SETTLED IN THE LAST ${days === 1 ? '24 HOURS' : `${days} DAYS`} — ${rows.length} signal(s)\n`);
  if (!rows.length) {
    console.log('  Nothing settled in the window. Nothing to learn from today.');
    return;
  }

  const withTier = rows.map(r => ({
    ...r,
    tier: classifyTier(r).tier ?? 'below-floor',
    profit: profitOf(r),
  }));

  console.log(table(withTier, [
    { head: 'Fixture', width: 30, align: 'l', get: fixtureOf },
    { head: 'Selection', width: 18, align: 'l', get: selectionOf },
    { head: 'Odds', width: 6, get: r => dec(Number(r.detected_odds)) },
    { head: 'Edge', width: 7, get: r => pct(Number(r.detected_edge)) },
    { head: 'Tier', width: 11, align: 'l', get: r => r.tier },
    { head: 'Result', width: 6, align: 'l', get: r => r.result },
    { head: 'P&L', width: 7, get: r => (r.profit == null ? ' — ' : (r.profit > 0 ? '+' : '') + r.profit.toFixed(2)) },
    { head: 'CLV', width: 7, get: r => (r.clv == null ? '  — ' : pct(Number(r.clv))) },
  ]));

  // Per-tier day summary. The PRIME line is the one that counts toward tracked
  // performance; the rest are shown so a bad day in an untracked tier is not
  // mistaken for a bad day for the product.
  console.log('\n  By tier (this window):\n');
  const tiers = ['prime', 'value', 'longshot', 'below-floor'];
  const perTier = tiers
    .map(t => ({ tier: t, ...summarise(withTier.filter(r => r.tier === t)) }))
    .filter(t => t.n > 0);
  console.log(table(perTier, [
    { head: 'Tier', width: 12, align: 'l', get: r => r.tier },
    { head: 'N', width: 4, get: r => r.n },
    { head: 'W', width: 4, get: r => r.wins },
    { head: 'Strike', width: 7, get: r => rate(r.strike) },
    { head: 'P&L', width: 8, get: r => (r.profit >= 0 ? '+' : '') + r.profit.toFixed(2) },
    { head: 'Yield', width: 8, get: r => pct(r.yield) },
    { head: 'Avg CLV', width: 8, get: r => pct(r.avgClv) },
  ]));
}

/**
 * The winners' edge distribution — the literal question asked of this job:
 * "what edge did the things that actually won carry?"
 *
 * On its own it proves nothing (losers have an edge distribution too, and if
 * the two are identical the edge is uninformative), so the losers' distribution
 * is printed beside it. The gap between the two columns IS the signal; the
 * winners' column alone is the classic way to talk yourself into a band.
 */
function printWinnerEdges(rows) {
  const settled = rows.filter(r => r.result === 'win' || r.result === 'loss');
  if (!settled.length) return;
  const wins = settled.filter(r => r.result === 'win');
  const losses = settled.filter(r => r.result === 'loss');
  const avg = xs => (xs.length ? xs.reduce((s, x) => s + Number(x.detected_edge), 0) / xs.length : null);
  const avgOdds = xs => (xs.length ? xs.reduce((s, x) => s + Number(x.detected_odds), 0) / xs.length : null);

  console.log('\n  Edge carried by winners vs losers (whole settled book):\n');
  console.log(table([
    { label: 'Winners', rows: wins },
    { label: 'Losers', rows: losses },
  ], [
    { head: 'Outcome', width: 10, align: 'l', get: r => r.label },
    { head: 'N', width: 5, get: r => r.rows.length },
    { head: 'Avg edge', width: 9, get: r => pct(avg(r.rows)) },
    { head: 'Avg odds', width: 9, get: r => dec(avgOdds(r.rows)) },
  ]));
  const gap = (avg(wins) ?? 0) - (avg(losses) ?? 0);
  console.log(
    `\n  Winners carried ${pct(gap)} ${gap >= 0 ? 'more' : 'less'} edge than losers. ` +
    `A gap near zero means the edge number is not yet separating outcomes —\n` +
    '  which is a finding about the model, not a reason to move the band.');
}

/**
 * A CLV column with values past ±100% is reporting a broken closing price, not
 * a spectacular one. Clamping keeps the tables readable; printing the count
 * keeps the fault from being laundered into a clean-looking number.
 */
function printClvHealth(rows) {
  const all = summarise(rows);
  if (!all.clvOutliers) return;
  console.log(
    `\n  ⚠️  ${all.clvOutliers} of ${all.clvN} settled rows carry a CLV beyond ±100% — a closing price\n` +
    '     that moved more than double against the bet. Those are almost certainly bad closes,\n' +
    '     not real value: they are clamped to ±100% for every figure above so a handful of\n' +
    '     them cannot swing a band\'s CLV by tens of points. Worth fixing at the source in\n' +
    '     fetchResults.js, since CLV is the fastest read available on whether a band is real.');
}

// ---------------------------------------------------------------------------
// Section 2 — the edge response
// ---------------------------------------------------------------------------

function printEdgeTable(title, bands, note) {
  console.log(`\n${title}\n`);
  console.log(table(bands, [
    { head: 'Edge band', width: 11, align: 'l', get: r => edgeLabel(r.edgeMin, r.edgeMax) },
    { head: 'N', width: 5, get: r => r.n },
    { head: 'W', width: 4, get: r => r.wins },
    { head: 'Strike', width: 7, get: r => rate(r.strike) },
    { head: 'Yield', width: 8, get: r => pct(r.yield) },
    { head: '90% CI', width: 17, get: r => (r.yieldLo == null ? '        —' : `${pct(r.yieldLo)} .. ${pct(r.yieldHi)}`) },
    { head: 'Avg odds', width: 8, get: r => dec(r.avgOdds) },
    { head: 'CLV', width: 7, get: r => pct(r.avgClv) },
    { head: '', width: 6, align: 'l', get: r => thin(r.n) },
  ]));
  if (note) console.log(`\n  ${note}`);
}

function printOddsTable(bands) {
  console.log('\n📐 BY PRICE (edge ≥ 2% visibility floor)\n');
  console.log(table(bands, [
    { head: 'Odds band', width: 11, align: 'l', get: r => oddsLabel(r.oddsMin, r.oddsMax) },
    { head: 'N', width: 5, get: r => r.n },
    { head: 'W', width: 4, get: r => r.wins },
    { head: 'Strike', width: 7, get: r => rate(r.strike) },
    { head: 'Yield', width: 8, get: r => pct(r.yield) },
    { head: '90% CI', width: 17, get: r => (r.yieldLo == null ? '        —' : `${pct(r.yieldLo)} .. ${pct(r.yieldHi)}`) },
    { head: 'Avg edge', width: 8, get: r => pct(r.avgEdge) },
    { head: '', width: 6, align: 'l', get: r => thin(r.n) },
  ]));
}

// ---------------------------------------------------------------------------
// Section 3 — the box, in and out of sample
// ---------------------------------------------------------------------------

function printBoxHealth(inSample, outSample, all) {
  const box = CURRENT_BOX;
  const rowsFor = rows => summarise(applyBox(rows, box));
  const cells = [
    { label: 'Fitting window (pre-epoch)', ...rowsFor(inSample) },
    { label: 'Out-of-sample (post-epoch)', ...rowsFor(outSample) },
    { label: 'Whole book', ...rowsFor(all) },
  ];

  console.log(`\n🎯 THE CURRENT PRIME BOX — odds ${THRESHOLDS.PRIME_ODDS_MIN.toFixed(2)}–` +
    `${THRESHOLDS.PRIME_ODDS_MAX.toFixed(2)}, edge ${(THRESHOLDS.PRIME_EDGE_MIN * 100).toFixed(0)}%–` +
    `${(THRESHOLDS.PRIME_EDGE_MAX * 100).toFixed(0)}%\n`);
  console.log(table(cells, [
    { head: 'Window', width: 27, align: 'l', get: r => r.label },
    { head: 'N', width: 5, get: r => r.n },
    { head: 'W', width: 4, get: r => r.wins },
    { head: 'Strike', width: 7, get: r => rate(r.strike) },
    { head: 'Yield', width: 8, get: r => pct(r.yield) },
    { head: '90% CI', width: 17, get: r => (r.yieldLo == null ? '        —' : `${pct(r.yieldLo)} .. ${pct(r.yieldHi)}`) },
    { head: 'CLV', width: 7, get: r => pct(r.avgClv) },
    { head: '', width: 6, align: 'l', get: r => thin(r.n) },
  ]));

  const fit = cells[0], oos = cells[1];
  if (fit.n && oos.n && fit.yield != null && oos.yield != null) {
    const decay = fit.yield - oos.yield;
    console.log(
      `\n  In-sample minus out-of-sample: ${pct(decay)}. This gap is the cost of having ` +
      'chosen the box\n  by looking for the best cell. Some decay is expected and does not ' +
      'condemn the box —\n  a gap that keeps widening as the sample grows does.');
  }
  if (oos.n && oos.n < 30) {
    console.log(
      `\n  ⚠️  Only ${oos.n} out-of-sample PRIME bets. That is far too few to judge the box on. ` +
      `The\n     estimate needs roughly ${oos.needForFivePoints ?? '—'} settled bets to pin yield to ±5 points.`);
  }
}

// ---------------------------------------------------------------------------
// Section 4 — sweep + verdict
// ---------------------------------------------------------------------------

function printSweep(sweep, verdict) {
  console.log('\n🔎 EDGE-BAND SWEEP (odds window held at the current PRIME box)\n');
  console.log(
    `  ${sweep.tested} boxes tested, ${sweep.eligible} cleared the minimum sample. Ranked by the ` +
    'LOWER bound\n  of yield, never by yield — ranking on the point estimate is how the current box ' +
    'was\n  chosen, and is precisely the step being re-examined here. The bound is Šidák-corrected\n' +
    `  for picking a best-of-${sweep.eligible} (per-test α = ${sweep.perTestAlpha.toExponential(2)}, ` +
    `z = ${sweep.z.toFixed(2)}), so a band has to\n  clear a far higher bar than a single pre-registered ` +
    'hypothesis would.\n');

  const top = sweep.candidates.slice(0, 8).map((c, i) => ({ ...c, rank: i + 1 }));
  if (!top.length) {
    console.log('  No band cleared the minimum sample. Nothing to propose.');
  } else {
    console.log(table(top, [
      { head: '#', width: 2, get: r => r.rank },
      { head: 'Edge band', width: 11, align: 'l', get: r => edgeLabel(r.box.edgeMin, r.box.edgeMax) },
      { head: 'N', width: 5, get: r => r.n },
      { head: 'Strike', width: 7, get: r => rate(r.strike) },
      { head: 'Yield', width: 8, get: r => pct(r.yield) },
      { head: 'Adj lo bd', width: 9, get: r => pct(r.yieldLoAdj) },
      { head: 'CLV', width: 7, get: r => pct(r.avgClv) },
      { head: '', width: 6, align: 'l', get: r => thin(r.n) },
    ]));
  }

  const icon = { insufficient: '⏳', hold: '✋', advisory: '👀', shift: '✅' }[verdict.status];
  console.log(`\n${SUB}\n`);
  console.log(`${icon}  VERDICT: ${verdict.status.toUpperCase()}\n`);
  console.log(`  ${verdict.reason}`);
  if (verdict.betsNeeded) {
    console.log(`\n  Settled bets still needed before this could change: ~${verdict.betsNeeded}.`);
  }
  console.log(
    '\n  This job never edits a threshold. If the verdict is SHIFT, the change is a human\n' +
    '  edit to lib/signalTier.js — and the numbers above are the case for making it.');
}

// ---------------------------------------------------------------------------
// Snapshot
// ---------------------------------------------------------------------------

const round = (v, dp = 4) => (v == null || !Number.isFinite(v) ? null : Number(v.toFixed(dp)));

function buildSnapshot({ all, inSample, outSample, edgeBands, oddsBands, sweep, verdict, days }) {
  const prime = summarise(applyBox(all, CURRENT_BOX));
  const primeOos = summarise(applyBox(outSample, CURRENT_BOX));
  const best = verdict.candidate;
  const detectedAts = all.map(r => r.detected_at).filter(Boolean).sort();

  return {
    as_of_date: new Date().toISOString().slice(0, 10),
    calculated_at: new Date().toISOString(),
    phase: 'prematch',
    epoch_at: PERFORMANCE_EPOCH,
    sample_from: detectedAts[0] ?? null,
    sample_to: detectedAts[detectedAts.length - 1] ?? null,
    settled_n: all.length,

    prime_n: prime.n,
    prime_wins: prime.wins,
    prime_strike: round(prime.strike),
    prime_yield: round(prime.yield),
    prime_yield_lo: round(prime.yieldLo),
    prime_yield_hi: round(prime.yieldHi),
    prime_yield_lo_adj: round(verdict.current.yieldLoAdj),
    prime_avg_clv: round(prime.avgClv),
    clv_outliers: summarise(all).clvOutliers,

    prime_oos_n: primeOos.n,
    prime_oos_yield: round(primeOos.yield),

    best_edge_min: best ? round(best.box.edgeMin) : null,
    best_edge_max: best && best.box.edgeMax != null ? round(best.box.edgeMax) : null,
    best_n: best ? best.n : null,
    best_yield: best ? round(best.yield) : null,
    best_yield_lo: best ? round(best.yieldLoAdj) : null,
    best_oos_n: best?.outOfSample ? best.outOfSample.n : null,
    best_oos_yield: best?.outOfSample ? round(best.outOfSample.yield) : null,
    boxes_tested: sweep.tested,
    boxes_eligible: sweep.eligible,
    per_test_alpha: round(sweep.perTestAlpha, 8),
    sweep_z: round(sweep.z, 4),

    recommendation: verdict.status,
    reason: verdict.reason,
    bets_needed: verdict.betsNeeded ?? null,

    edge_bands: edgeBands.map(b => ({
      edge_min: b.edgeMin, edge_max: b.edgeMax, n: b.n, wins: b.wins,
      strike: round(b.strike), yield: round(b.yield),
      yield_lo: round(b.yieldLo), yield_hi: round(b.yieldHi),
      avg_odds: round(b.avgOdds, 3), avg_clv: round(b.avgClv),
    })),
    odds_bands: oddsBands.map(b => ({
      odds_min: b.oddsMin, odds_max: Number.isFinite(b.oddsMax) ? b.oddsMax : null,
      n: b.n, wins: b.wins, strike: round(b.strike), yield: round(b.yield),
      yield_lo: round(b.yieldLo), yield_hi: round(b.yieldHi), avg_edge: round(b.avgEdge),
    })),
    top_candidates: sweep.candidates.slice(0, 10).map(c => ({
      edge_min: c.box.edgeMin, edge_max: c.box.edgeMax,
      n: c.n, strike: round(c.strike), yield: round(c.yield),
      yield_lo: round(c.yieldLo), yield_lo_adj: round(c.yieldLoAdj), avg_clv: round(c.avgClv),
    })),
    review_window_days: days,
  };
}

async function writeSnapshot(supabase, snapshot) {
  // review_window_days is a print-time detail, not part of the record.
  const { review_window_days: _drop, ...row } = snapshot;
  const { error } = await supabase
    .from('edge_calibration')
    .upsert(row, { onConflict: 'as_of_date' });
  if (error) throw new Error(`snapshot upsert failed: ${error.message}`);
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

/**
 * @param {string[]} argv
 * @param {{supabase?: object}} deps  injection point — lets the report be run
 *   against a captured book without service-role credentials.
 */
async function run(argv = process.argv.slice(2), deps = {}) {
  const opts = parseArgs(argv);
  const supabase = deps.supabase ?? getClient();

  const raw = await fetchSettled(supabase);

  // Pre-match only: the PRIME box is a pre-kickoff filter and in-play signals
  // are judged on their own record (see fetchResults.calculatePerformance).
  // The learning model is likewise scored separately and is excluded by default
  // so an unproven forecast cannot vote on where the band belongs.
  const all = raw.filter(r =>
    (r.phase ?? 'prematch') !== 'inplay' &&
    (opts.includeSupermodel || r.model_architecture !== 'SUPERMODEL'));

  const epochMs = new Date(PERFORMANCE_EPOCH).getTime();
  const inSample = all.filter(r => new Date(r.detected_at).getTime() < epochMs);
  const outSample = all.filter(r => new Date(r.detected_at).getTime() >= epochMs);

  const sinceIso = new Date(Date.now() - opts.days * 864e5).toISOString();
  const windowRows = await fetchWindow(supabase, sinceIso);

  const edgeBandsPrimeOdds = edgeBandTable(all, {
    oddsMin: THRESHOLDS.PRIME_ODDS_MIN,
    oddsMax: THRESHOLDS.PRIME_ODDS_MAX,
  });
  const edgeBandsAllOdds = edgeBandTable(all);
  const oddsBands = oddsBandTable(all, { edgeMin: THRESHOLDS.VALUE_MIN_EDGE });

  const sweep = sweepBoxes(all);
  const verdict = recommend({
    rows: all,
    outOfSampleRows: outSample,
    sweep,
    minSample: opts.minSample,
    confirmSample: opts.confirmSample,
  });

  const snapshot = buildSnapshot({
    all, inSample, outSample,
    edgeBands: edgeBandsPrimeOdds, oddsBands, sweep, verdict,
    days: opts.days,
  });

  if (opts.json) {
    console.log(JSON.stringify({ snapshot, sweep: sweep.candidates.slice(0, 10), verdict }, null, 2));
  } else {
    console.log(RULE);
    console.log(`🧭 MAX EDGE — DAILY EDGE REVIEW · ${snapshot.as_of_date}`);
    console.log(RULE);
    console.log(
      `\n  Settled book: ${all.length} pre-match bets ` +
      `(${inSample.length} in the fitting window, ${outSample.length} after it).\n` +
      `  Fit epoch: ${PERFORMANCE_EPOCH}` +
      `${opts.includeSupermodel ? '  ·  including SUPERMODEL' : ''}`);

    printSettledWindow(windowRows, opts.days);
    printWinnerEdges(all);
    printClvHealth(all);

    console.log(`\n${SUB}`);
    printEdgeTable(
      '📊 EDGE RESPONSE — inside the PRIME odds window (1.40–3.00)',
      edgeBandsPrimeOdds,
      'A real sweet spot looks like a rise to a peak and a fall away. Scattered signs\n' +
      '  across neighbouring bands mean the sample is still reading noise.');
    printEdgeTable('📊 EDGE RESPONSE — all prices', edgeBandsAllOdds);
    printOddsTable(oddsBands);

    console.log(`\n${SUB}`);
    printBoxHealth(inSample, outSample, all);

    console.log(`\n${SUB}`);
    printSweep(sweep, verdict);
    console.log(`\n${RULE}`);
  }

  if (opts.write) {
    await writeSnapshot(supabase, snapshot);
    if (!opts.json) console.log(`\n💾 Snapshot saved to edge_calibration (${snapshot.as_of_date}).`);
  }

  return { snapshot, verdict, sweep };
}

if (require.main === module) {
  run().catch(err => {
    console.error('[edge-review] failed:', err.message);
    process.exit(1);
  });
}

module.exports = { run, parseArgs, buildSnapshot, PERFORMANCE_EPOCH };
