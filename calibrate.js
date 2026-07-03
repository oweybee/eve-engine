/**
 * Max Edge — multi-tiered model calibration sweep.
 *
 * The raw Dixon-Coles output under-rates favourites vs the market, so all the
 * model's "value" lands on longshots and the Diamond (value AND high probability)
 * never fires. Temperature sharpening (s > 1) corrects this by pushing
 * probability mass toward the favourite. The optimal exponent differs between
 * market tiers because the edge-reference price quality varies:
 *
 *   Multi-book  (softCount >= MULTI_BOOK_THRESHOLD): 3+ independent soft prices
 *     anchor the best-odds composite, so margin noise averages out and the
 *     sharpness calibration has a stable target to fit against.
 *
 *   Single-book (softCount <  MULTI_BOOK_THRESHOLD): a single soft-book price
 *     carries its full margin unchallenged — the reference price is noisier and
 *     a lower sharpness value is expected.
 *
 * For each tier the script sweeps a grid of sharpness values and reports:
 *   MAE      — mean absolute error of model vs Betfair-implied probs (market fit)
 *   meanFav  — average max-outcome probability (how strongly favourites are rated)
 *   Diamond     — count of DIAMOND-tier signals (edge ≥ 8pp AND prob ≥ 60% AND VS ≥ 8)
 *   Value    — count of matches with at least one value-tier signal
 *
 * Run after each rating update or whenever adding new soft books:
 *   export $(cat .env | xargs) && node calibrate.js
 *
 * Copy the recommended env var values into .env / GitHub secrets:
 *   SHARPNESS_MULTI_BOOK=<optimal>
 *   SHARPNESS_SINGLE_BOOK=<optimal>
 */

'use strict';

const {
  matchProbabilities,
  ratingFor,
  isRated,
  deVig,
  getBestSoftOdds,
  fetchMatchesForComputation,
  getClient,
  SOFT_BOOKS,
  MULTI_BOOK_THRESHOLD,
} = require('./computeValues');

const { valueScore, signalTier } = require('./modelMetrics');

// ---------------------------------------------------------------------------
// Type definitions (JSDoc)
// ---------------------------------------------------------------------------

/**
 * @typedef {Object} SweepRow
 * @property {number} s        - Sharpness value tested
 * @property {number} mae      - Mean absolute error vs Betfair [0,1]
 * @property {number} meanFav  - Average max-outcome probability [0,1]
 * @property {number} diamond     - Number of DIAMOND signals across all matches
 * @property {number} value    - Number of matches with any value signal
 */

/**
 * @typedef {Object} TierData
 * @property {string}     label    - Human-readable tier name
 * @property {object[]}   usable   - Pre-processed match data for this tier
 * @property {SweepRow[]} results  - Sweep results (one per sharpness value)
 * @property {SweepRow|null} best  - Optimal sharpness row (minimum MAE)
 */

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Sharpness values to evaluate in the sweep. */
const SWEEP = [1.0, 1.2, 1.3, 1.5, 1.7, 1.9, 2.1, 2.3, 2.6, 3.0];

const OUTCOMES = /** @type {('home'|'draw'|'away')[]} */ (['home', 'draw', 'away']);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Returns Betfair Exchange de-vigged probabilities for a set of h2h odds rows,
 * or null if no Betfair Exchange row is present.
 *
 * @param {object[]} h2hRows
 * @returns {{ home: number, draw: number, away: number } | null}
 */
function betfairImplied(h2hRows) {
  const row = h2hRows
    .filter(r => r.bookmaker === 'betfair_ex_uk')
    .sort((a, b) => new Date(b.fetched_at) - new Date(a.fetched_at))[0];

  if (!row) return null;
  return deVig(
    parseFloat(row.home_odds),
    parseFloat(row.draw_odds),
    parseFloat(row.away_odds),
  );
}

/**
 * Runs the sharpness sweep across a set of pre-filtered match data.
 *
 * @param {object[]} usable - Array of { home, away, bf, soft } match records
 * @returns {SweepRow[]}
 */
function runSweep(usable) {
  return SWEEP.map(s => {
    let errSum = 0, errN = 0, favSum = 0, diamond = 0, value = 0;

    for (const u of usable) {
      const model = matchProbabilities(u.home, u.away, s);

      // MAE vs Betfair across the three outcomes
      for (const o of OUTCOMES) {
        errSum += Math.abs(model[o] - u.bf[o]);
        errN++;
      }
      favSum += Math.max(model.home, model.draw, model.away);

      // Diamond / value per outcome using soft-implied edge
      const softImplied = {
        home: 1 / u.soft.home,
        draw: 1 / u.soft.draw,
        away: 1 / u.soft.away,
      };

      let matchHasValue = false;
      for (const o of OUTCOMES) {
        const edge = model[o] - softImplied[o];
        const vs   = valueScore(edge, model[o]);
        const tier = signalTier(edge, model[o], vs);
        if (tier === 'DIAMOND') diamond++;
        if (tier) matchHasValue = true;
      }
      if (matchHasValue) value++;
    }

    return {
      s,
      mae:     errN > 0 ? errSum / errN : NaN,
      meanFav: usable.length > 0 ? favSum / usable.length : NaN,
      diamond,
      value,
    };
  });
}

/**
 * Prints a formatted sweep table for one tier to stdout.
 *
 * @param {TierData} tier
 */
function printTierTable(tier) {
  if (!tier.usable.length) {
    console.log('  (no usable matches in this tier)\n');
    return;
  }

  console.log('  s      MAE          meanFav    Diamond   Value');
  console.log('  ----   ----------   --------   ----   -----');

  const bestS = tier.best?.s;
  for (const row of tier.results) {
    const marker = row.s === bestS ? '  ← optimal' : '';
    console.log(
      `  ${row.s.toFixed(1)}    ` +
      `${(row.mae * 100).toFixed(2).padStart(6)}pp     ` +
      `${(row.meanFav * 100).toFixed(1).padStart(5)}%      ` +
      `${String(row.diamond).padStart(3)}    ` +
      `${String(row.value).padStart(3)}` +
      marker,
    );
  }
  console.log('');
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function run() {
  const supabase = getClient();
  const matches  = await fetchMatchesForComputation(supabase);

  // Pre-filter: rated teams + exchange odds + at least 1 soft book priced.
  // Using softCount >= 1 (not the production threshold) so both tiers are
  // populated — the threshold split happens below.
  /** @type {{ home: string, away: string, bf: object, soft: object, softCount: number }[]} */
  const allUsable = [];

  for (const m of matches) {
    const home = m.home_team?.name;
    const away = m.away_team?.name;
    if (!isRated(home) && !isRated(away)) continue;

    const h2h       = m.odds.filter(r => (r.market ?? 'h2h') === 'h2h');
    const bf        = betfairImplied(h2h);
    const soft      = getBestSoftOdds(h2h);
    const softCount = new Set(
      h2h.filter(r => SOFT_BOOKS.has(r.bookmaker)).map(r => r.bookmaker),
    ).size;

    if (!bf || !soft || softCount < 1) continue;
    allUsable.push({ home, away, bf, soft, softCount });
  }

  console.log(`\n[calibrate] ${allUsable.length} usable matches (rated + exchange + ≥1 soft book)`);
  console.log(`[calibrate] MULTI_BOOK_THRESHOLD=${MULTI_BOOK_THRESHOLD} (from env or default)\n`);

  const multiBook  = allUsable.filter(u => u.softCount >= MULTI_BOOK_THRESHOLD);
  const singleBook = allUsable.filter(u => u.softCount <  MULTI_BOOK_THRESHOLD);

  /** @type {TierData[]} */
  const tiers = [
    {
      label:   `Multi-book tier  (softCount ≥ ${MULTI_BOOK_THRESHOLD}) — ${multiBook.length} match(es)`,
      usable:  multiBook,
      results: [],
      best:    null,
    },
    {
      label:   `Single-book tier (softCount <  ${MULTI_BOOK_THRESHOLD}) — ${singleBook.length} match(es)`,
      usable:  singleBook,
      results: [],
      best:    null,
    },
  ];

  for (const tier of tiers) {
    tier.results = runSweep(tier.usable);

    if (tier.usable.length > 0) {
      // Best = lowest MAE; tie-break on more Diamond signals (higher model utility).
      tier.best = tier.results.reduce((a, b) => {
        if (Math.abs(b.mae - a.mae) < 0.0001) return b.diamond > a.diamond ? b : a;
        return b.mae < a.mae ? b : a;
      });
    }

    console.log(`[calibrate] ${tier.label}`);
    printTierTable(tier);
  }

  const [multi, single] = tiers;

  console.log('[calibrate] Recommendations (set in .env / GitHub secrets):');
  if (multi.best) {
    console.log(`  SHARPNESS_MULTI_BOOK=${multi.best.s}    (MAE ${(multi.best.mae * 100).toFixed(2)}pp, ${multi.best.diamond} diamond, ${multi.usable.length} matches)`);
  } else {
    console.log('  SHARPNESS_MULTI_BOOK=1.7    (default — no multi-book matches in calibration set)');
  }
  if (single.best) {
    console.log(`  SHARPNESS_SINGLE_BOOK=${single.best.s}   (MAE ${(single.best.mae * 100).toFixed(2)}pp, ${single.best.diamond} diamond, ${single.usable.length} matches)`);
  } else {
    console.log('  SHARPNESS_SINGLE_BOOK=1.0   (default — no single-book matches in calibration set)');
  }
  console.log(`  MULTI_BOOK_THRESHOLD=${MULTI_BOOK_THRESHOLD}        (books required for multi-book tier)\n`);
}

run().catch(err => {
  console.error('[calibrate] fatal:', err.message);
  process.exit(1);
});
