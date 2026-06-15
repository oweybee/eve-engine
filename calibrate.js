/**
 * Max Edge — model calibration sweep.
 *
 * The raw Dixon-Coles output under-rates favourites vs the market, so all the
 * model's "value" lands on longshots and Ruby (value AND high probability)
 * never fires. This sweeps the temperature-sharpening exponent and reports,
 * for each value:
 *   - MAE of model vs Betfair-implied probabilities (market agreement)
 *   - mean favourite probability (how strong the model rates favourites)
 *   - Ruby signal count (edge>=8% & prob>=60% & valueScore>=8)
 *   - total value signals
 *
 * Usage: export $(cat .env | xargs) && node calibrate.js
 */

'use strict';

const {
  matchProbabilities, ratingFor, isRated, deVig, getBestSoftOdds,
  fetchMatchesForComputation, getClient, SOFT_BOOKS,
} = require('./computeValues');
const { valueScore, signalTier } = require('./modelMetrics');

const OUTCOMES = ['home', 'draw', 'away'];
const SWEEP = [1.0, 1.3, 1.5, 1.7, 1.9, 2.1, 2.3, 2.6, 3.0];

function betfairImplied(h2hRows) {
  const row = h2hRows
    .filter(r => r.bookmaker === 'betfair_ex_uk')
    .sort((a, b) => new Date(b.fetched_at) - new Date(a.fetched_at))[0];
  if (!row) return null;
  return deVig(parseFloat(row.home_odds), parseFloat(row.draw_odds), parseFloat(row.away_odds));
}

async function run() {
  const supabase = getClient();
  const matches = await fetchMatchesForComputation(supabase);

  // Pre-filter to the matches we'd actually score (rated, exchange, 3+ soft).
  const usable = [];
  for (const m of matches) {
    const home = m.home_team?.name, away = m.away_team?.name;
    if (!isRated(home) && !isRated(away)) continue;
    const h2h = m.odds.filter(r => (r.market ?? 'h2h') === 'h2h');
    const bf = betfairImplied(h2h);
    const soft = getBestSoftOdds(h2h);
    const softCount = new Set(h2h.filter(r => SOFT_BOOKS.has(r.bookmaker)).map(r => r.bookmaker)).size;
    if (!bf || !soft || softCount < 3) continue;
    usable.push({ home, away, bf, soft });
  }

  console.log(`\n[calibrate] ${usable.length} World Cup matches with exchange + 3+ soft books\n`);
  console.log('  s     MAE(model vs Betfair)   meanFavProb   Ruby   Value');
  console.log('  ----  ---------------------   -----------   ----   -----');

  const results = [];
  for (const s of SWEEP) {
    let errSum = 0, errN = 0, favSum = 0, ruby = 0, value = 0;
    for (const u of usable) {
      const model = matchProbabilities(u.home, u.away, s);
      // MAE vs Betfair across the three outcomes
      for (const o of OUTCOMES) { errSum += Math.abs(model[o] - u.bf[o]); errN++; }
      favSum += Math.max(model.home, model.draw, model.away);
      // Ruby / value per outcome using soft-implied edge
      const softImplied = { home: 1 / u.soft.home, draw: 1 / u.soft.draw, away: 1 / u.soft.away };
      let matchHasValue = false;
      for (const o of OUTCOMES) {
        const edge = model[o] - softImplied[o];
        const vs = valueScore(edge, model[o]);
        const tier = signalTier(edge, model[o], vs);
        if (tier === 'RUBY') ruby++;
        if (tier) matchHasValue = true;
      }
      if (matchHasValue) value++;
    }
    const mae = errSum / errN;
    const meanFav = favSum / usable.length;
    results.push({ s, mae, meanFav, ruby, value });
    console.log(`  ${s.toFixed(1)}   ${(mae * 100).toFixed(2).padStart(6)}pp              ${(meanFav * 100).toFixed(1)}%        ${String(ruby).padStart(3)}    ${String(value).padStart(3)}`);
  }

  const best = results.reduce((a, b) => (b.mae < a.mae ? b : a));
  console.log(`\n[calibrate] best market fit: sharpness=${best.s} (MAE ${(best.mae*100).toFixed(2)}pp, ${best.ruby} ruby, ${best.value} value)\n`);
}

run().catch(err => { console.error('[calibrate] fatal:', err.message); process.exit(1); });
