'use strict';

/**
 * lib/disagreementFit — the model-vs-market scorecard, computed rather than
 * remembered.
 *
 * WHY THIS EXISTS AT ALL. `disagreement_calibration` held two row sets produced
 * two different ways. DIXON_COLES came from `refresh_disagreement_calibration()`
 * in migration 054 — which has been BROKEN since 075 made the table per-model,
 * because it still inserts without `model` and conflicts on `(gap_bucket)`
 * alone, a key that no longer exists. ELO came from a DO block that ran once,
 * whose working tables `elo_prematch` and `elo_eval` were dropped afterwards
 * (docs/ELO_CALIBRATION.md §8): its five rows are LITERALS in migration 075 and
 * nothing in the repo or the database reproduces them.
 *
 * So the numbers the product quotes on every match card could not be recomputed
 * by anyone. This module is the missing half.
 *
 * THE MATH IS THE ENGINE'S OWN, NOT A SECOND COPY. The Elo replay uses
 * lib/elo.js's `updatePair` and its K/home-advantage/default constants, the
 * 1X2 vector comes from lib/eloProbs.js with the fitted parameters read from
 * `goal_model_params`, and the market side is lib/devig.js's Shin. Implementing
 * any of those here — or in SQL — would be the third copy of the draw model
 * that eve-frontend's CLAUDE.md warns about, and the whole point of the
 * scorecard is that it describes the model that actually runs.
 *
 * THE BANDS ARE A PARAMETER. `bandsOf(width)` cuts at whatever granularity is
 * asked for, so the fit can be reproduced at the published 3/6/10/15pp cuts
 * — which is how it is verified — and then re-cut per point without a second
 * implementation appearing.
 *
 * "RIGHT" MEANS STRICTLY CLOSER, which is the definition the published rows
 * use and is deliberately NOT a proper scoring rule. Brier is reported beside
 * it precisely because the two disagree, and that contradiction is what sets
 * each model's publishable bar.
 */

const { ELO_K, ELO_HOME_ADV, ELO_DEFAULT, updatePair } = require('./elo');
const { eloProbs } = require('./eloProbs');
const { shinDevig } = require('./devig');

/** The published cuts, as a width list. Kept so the fit can be verified. */
const LEGACY_EDGES = [0.03, 0.06, 0.10, 0.15];

/**
 * Band edges at a fixed width in probability points, up to `maxPp`.
 * `width = null` returns the published irregular cuts.
 */
function bandsOf(width, maxPp = 40) {
  if (width == null) return LEGACY_EDGES.slice();
  const edges = [];
  for (let pp = width; pp < maxPp; pp += width) edges.push(pp / 100);
  return edges;
}

/** Which band a gap falls in: closed below, open above, matching the SQL. */
function bandFor(gap, edges) {
  const g = Math.abs(gap);
  // No edges at all is ONE open band. Without this the fall-through reads
  // edges[-1] and hands back an undefined lower bound, which labels as "NaNpp+"
  // and sorts arbitrarily.
  if (edges.length === 0) return { min: 0, max: null };
  for (let i = 0; i < edges.length; i++) {
    if (g < edges[i]) {
      return { min: i === 0 ? 0 : edges[i - 1], max: edges[i] };
    }
  }
  return { min: edges[edges.length - 1], max: null };
}

/**
 * Per-point bands for as long as the sample holds, then ONE open-ended tail.
 *
 * WHY THE TAIL IS BANDED. Cut at single points the whole way, the record stops
 * being a record: measured 20 Aug 2026, ELO reads 51.0% at 11pp, 57.7% at 14pp
 * and back to 53.1% at 22pp, so a reader comparing two fixtures would see the
 * WIDER disagreement quoted as the safer one. At 37pp it lands on an exact
 * 50/50 over 16 selections and the copy states a coin flip as a finding. The
 * premise the sentence rests on — the further we diverge, the more often the
 * market wins — is a property of the population, and below a few hundred
 * selections a point estimate is noise wearing its clothes.
 *
 * The cut is made on SAMPLE SIZE rather than on a hand-picked gap, so it moves
 * with the corpus instead of ageing into a magic number.
 *
 * @param {Array} selections
 * @param {number} width band width in probability points
 * @param {number} minN  the smallest per-point sample that may stand alone
 */
function edgesWithMinSample(selections, width, minN) {
  const full = bandsOf(width);
  const bands = aggregate(selections, full);
  // The first CLOSED band too thin to stand alone; everything from its lower
  // bound upward is merged into the open tail.
  const thin = bands.find(b => b.gap_max != null && b.n < minN);
  if (!thin) return full;
  // KEEP THE EDGE AT the thin band's lower bound. Dropping it starts the tail
  // one band too low and swallows the last well-sampled point — 40 selections
  // at 1pp disappearing into a "1pp+" tail in the first version of this.
  return full.filter(e => e <= thin.gap_min + 1e-12);
}

/** "10-15pp", "12pp", "15pp+", "<3pp" — the same spellings the table holds. */
function labelFor({ min, max }) {
  const pp = (v) => Math.round(v * 100);
  if (max == null) return `${pp(min)}pp+`;
  if (min <= 0) return `<${pp(max)}pp`;
  if (pp(max) - pp(min) === 1) return `${pp(min)}pp`;
  return `${pp(min)}-${pp(max)}pp`;
}

/**
 * Point-in-time pre-match Elo for every row, replayed chronologically.
 *
 * ORDER BY (match_date, id) and the pre-match pair is recorded BEFORE the
 * fixture is applied — a rating that has already seen the result it is about to
 * predict is not a forecast. Mirrors docs/ELO_CALIBRATION.md §8 step 1 and the
 * same rule computeElo.js follows.
 *
 * @param {Array} rows joined research rows, each { id, match_date, home_tid,
 *   away_tid, ftr }
 * @returns {Map<number, {eloHome:number, eloAway:number, homePlayed:number, awayPlayed:number}>}
 */
function replayElo(rows) {
  const rating = new Map();
  const played = new Map();
  const get = (tid) => (rating.has(tid) ? rating.get(tid) : ELO_DEFAULT);
  const games = (tid) => played.get(tid) ?? 0;

  const ordered = [...rows].sort((a, b) => {
    const d = String(a.match_date).localeCompare(String(b.match_date));
    return d !== 0 ? d : Number(a.id) - Number(b.id);
  });

  const out = new Map();
  for (const r of ordered) {
    if (r.home_tid == null || r.away_tid == null) continue;
    const eloHome = get(r.home_tid);
    const eloAway = get(r.away_tid);
    // Recorded BEFORE the update.
    out.set(r.id, {
      eloHome, eloAway,
      homePlayed: games(r.home_tid), awayPlayed: games(r.away_tid),
    });

    // updatePair TAKES THE RESULT LETTER and RETURNS {home, away}. Passing a
    // numeric score makes every result read as an away win (=== 'H' and
    // === 'D' are both false), and destructuring the object as an array yields
    // undefined ratings — two silent ways to replay a completely wrong ladder.
    if (!['H', 'D', 'A'].includes(r.ftr)) continue;
    const next = updatePair(eloHome, eloAway, r.ftr, ELO_K, ELO_HOME_ADV);
    rating.set(r.home_tid, next.home);
    rating.set(r.away_tid, next.away);
    played.set(r.home_tid, games(r.home_tid) + 1);
    played.set(r.away_tid, games(r.away_tid) + 1);
  }
  return out;
}

/** Shin de-vig of one named closing triple, or null if it cannot supply one. */
function devigTriple(odds, h, d, a) {
  const ch = Number(odds?.[h]), cd = Number(odds?.[d]), ca = Number(odds?.[a]);
  if (!(ch > 1 && cd > 1 && ca > 1)) return null;
  const r = shinDevig([ch, cd, ca]);
  return r?.probs ?? null;
}

/**
 * The market's closing fair line: Pinnacle, Shin-de-vigged.
 *
 * This is the BENCHMARK for a forecasting model — DIXON_COLES and ELO are
 * measured against it. MARKET_ANCHORED cannot be: Pinnacle is its own model
 * side, so it is measured against the consensus instead. See consensusFair.
 */
function closingFair(odds) {
  return devigTriple(odds, 'PSCH', 'PSCD', 'PSCA');
}

/**
 * The broad market's closing fair line: the AVERAGE across books, de-vigged.
 *
 * NOT THE BEST PRICE, and that is a measurement decision rather than a
 * convenience. Measured on the corpus 20 Aug 2026: the max-across-books vector
 * carries a mean overround of 1.0072 and **4,448 of 14,940 sum to BELOW ONE** —
 * a real arbitrage, which Shin refuses. Those refusals are not missing at
 * random: books disagree most where the price is hardest, which is exactly the
 * wide-gap rows this table exists to describe. Calibrating on what survived
 * would quietly bias it toward agreement.
 *
 * The average (mean overround 1.0619) is a proper de-viggable vector and is the
 * honest reading of "what does the broad market think", which is the thing the
 * sharp book is being claimed to beat.
 */
function consensusFair(odds) {
  return devigTriple(odds, 'AvgCH', 'AvgCD', 'AvgCA');
}

/**
 * Aggregate one model's selections into bands.
 *
 * @param {Array<{modelP:number, marketP:number, y:0|1}>} selections
 * @param {number[]} edges
 */
function aggregate(selections, edges) {
  const byLabel = new Map();
  for (const s of selections) {
    const band = bandFor(s.modelP - s.marketP, edges);
    const label = labelFor(band);
    if (!byLabel.has(label)) {
      byLabel.set(label, { label, min: band.min, max: band.max, n: 0,
                           marketCloser: 0, modelCloser: 0, seModel: 0, seMarket: 0 });
    }
    const b = byLabel.get(label);
    const eModel = (s.modelP - s.y) ** 2;
    const eMarket = (s.marketP - s.y) ** 2;
    b.n += 1;
    if (eMarket < eModel) b.marketCloser += 1;
    if (eModel < eMarket) b.modelCloser += 1;
    b.seModel += eModel;
    b.seMarket += eMarket;
  }

  return [...byLabel.values()]
    .sort((a, b) => a.min - b.min)
    .map(b => ({
      gap_bucket: b.label,
      gap_min: b.min,
      gap_max: b.max,
      n: b.n,
      market_right_pct: round1(100 * b.marketCloser / b.n),
      model_right_pct: round1(100 * b.modelCloser / b.n),
      brier_model: round4(b.seModel / b.n),
      brier_market: round4(b.seMarket / b.n),
    }));
}

const round1 = (x) => Math.round(x * 10) / 10;
const round4 = (x) => Math.round(x * 10000) / 10000;

/**
 * Build both models' selections from the joined research corpus.
 *
 * @param {Array} rows  research_dc_preds ⨝ research_match_ratings on id
 * @param {object} eloParams from loadEloParams()
 * @param {object} [opts]
 * @param {number} [opts.minGames=30] prior games each club needs before its
 *   Elo rating is mature enough to evaluate. Applies to ELO only —
 *   DIXON_COLES carries no such notion and its published rows include
 *   everything.
 */
function selectionsFrom(rows, eloParams, { minGames = 30 } = {}) {
  const prematch = replayElo(rows);
  const dixon = [];
  const elo = [];
  const anchored = [];

  for (const r of rows) {
    if (!['H', 'D', 'A'].includes(r.ftr)) continue;
    const fair = closingFair(r.odds);
    if (!fair) continue;
    const y = ['H', 'D', 'A'].map(k => (r.ftr === k ? 1 : 0));

    const dc = [r.p_home, r.p_draw, r.p_away].map(Number);
    if (dc.every(Number.isFinite)) {
      for (let i = 0; i < 3; i++) dixon.push({ modelP: dc[i], marketP: fair[i], y: y[i] });
    }

    // MARKET_ANCHORED — market vs market, no forecast anywhere in it. The
    // SHARP book's own de-vigged line is the model side and the CONSENSUS is
    // the market side, which is the architecture's whole claim: that Pinnacle
    // prices the outcome better than the crowd does. Measured on the same
    // realised results and bucketed the same way, so its record sits beside
    // the forecasting models' on one scale.
    const consensus = consensusFair(r.odds);
    if (consensus) {
      for (let i = 0; i < 3; i++) {
        anchored.push({ modelP: fair[i], marketP: consensus[i], y: y[i] });
      }
    }

    const pm = prematch.get(r.id);
    // MATURITY, the filter the published fit applied and this did not.
    // docs/ELO_CALIBRATION.md §8 fits on home_games_pre >= 30 and
    // away_games_pre >= 30, and evaluating on a wider cohort than the fit was
    // built for is measuring a different model. Without it the recomputed
    // scorecard came out at 44,820 selections against the published 38,784 —
    // exactly 2,012 extra fixtures — with every band 0.2-0.8pp off. A rating
    // with four games behind it produces a big disagreement out of IGNORANCE,
    // which is the row this whole table exists to distrust.
    if (pm && pm.homePlayed >= minGames && pm.awayPlayed >= minGames) {
      const v = eloProbs(pm.eloHome, pm.eloAway, eloParams);
      // eloProbs guards its own contract and returns null if the vector escapes
      // (0,1). A null is a real refusal, not a shrug — the row is skipped.
      //
      // IT RETURNS { pHome, pDraw, pAway }, NOT { home, draw, away }. Reading
      // the wrong names yields undefined, `undefined - number` is NaN, and
      // `NaN < edge` is false for every band — so every selection fell through
      // to the open-ended top band and the whole model reported
      // "market 0% / model 0% / brier NaN". A wrong field name does not throw
      // here; it produces a full, plausible-shaped, entirely empty scorecard.
      if (v) {
        const ev = [v.pHome, v.pDraw, v.pAway];
        if (ev.every(Number.isFinite)) {
          for (let i = 0; i < 3; i++) elo.push({ modelP: ev[i], marketP: fair[i], y: y[i] });
        }
      }
    }
  }

  return { DIXON_COLES: dixon, ELO: elo, MARKET_ANCHORED: anchored };
}

/**
 * MEASURED PROBABILITY ERROR — sigma_p, on the reliability curve.
 *
 * THIS IS NOT A NEW DEFINITION. It is migration 048's `calibration_report()`
 * estimator, statement for statement, in JavaScript:
 *
 *   bin the forecast into deciles, keep bins with at least `minBin` rows,
 *   sigma_hat = sqrt( sum(n_i (obs_i - p_i)^2) / sum(n_i)
 *                     - sum(p_i (1 - p_i)) / sum(n_i) )
 *
 * The first term is how far the realised rate sat from the forecast; the second
 * is the binomial variance a PERFECTLY calibrated model would produce anyway at
 * these sample sizes. Subtracting it is the whole point — without it every
 * model measures a sigma made of its own sample size, and a small sample would
 * be rewarded with a large one.
 *
 * WHY IT LIVES HERE AND NOT IN SQL. `calibration_report()` reads
 * `value_signals` — rows a model BET on. ELO has never written one: it writes
 * `elo_forecasts`, and that table is forward-looking (created 19 Aug 2026, 49
 * settled fixtures). Measuring ELO from it would put a sigma on the product's
 * most-rendered forecast off fifty games. The research corpus this module
 * already replays holds 38,787 evaluated ELO selections, which is the sample
 * the disagreement scorecard is built on — so the sigma is measured on the same
 * rows, by the same estimator, as everything else the model claims.
 *
 * VERIFIED AGAINST THE SQL rather than argued to match it: run over
 * `value_signals` this returns the same figures the migration's expression
 * does, including the zeros. See `engine.disagreementfit.test.js`.
 *
 * A ZERO IS A RESULT, NOT A FAILURE. Three architectures measure exactly 0.0000
 * today, because their "model probability" is a restatement of the market price
 * and a restatement cannot miscalibrate. That is why `model_calibration` holds
 * a 3pp FLOOR for them and says `sigma_source = 'floor'` — the floor is a
 * resolution limit, not a measurement, and this function never applies it. The
 * caller decides.
 *
 * @param {{modelP: number, y: number}[]} selections
 * @param {{bins?: number, minBin?: number}} [opts]
 * @returns {{sigmaHat: number|null, nUsed: number, nBins: number, curve: object[]}}
 */
function calibrationSigma(selections, { bins = 10, minBin = 5 } = {}) {
  const acc = new Map();
  for (const s of selections) {
    const p = Number(s.modelP);
    const y = Number(s.y);
    if (!Number.isFinite(p) || !Number.isFinite(y)) continue;
    // width_bucket(p, 0, 1, bins): 1..bins inside [0,1), bins+1 at exactly 1.
    // Clamped rather than dropped, so a vector that touches an endpoint is
    // counted in the end bin instead of vanishing from the sample.
    const b = Math.min(bins, Math.max(1, Math.floor(p * bins) + 1));
    const cur = acc.get(b) ?? { n: 0, sumP: 0, sumY: 0 };
    cur.n += 1; cur.sumP += p; cur.sumY += y;
    acc.set(b, cur);
  }

  const kept = [];
  for (const [bucket, v] of [...acc.entries()].sort((a, b) => a[0] - b[0])) {
    if (v.n < minBin) continue;
    kept.push({ bucket, n: v.n, pBar: v.sumP / v.n, obs: v.sumY / v.n });
  }
  if (!kept.length) return { sigmaHat: null, nUsed: 0, nBins: 0, curve: [] };

  const nUsed = kept.reduce((t, b) => t + b.n, 0);
  const miss = kept.reduce((t, b) => t + b.n * (b.obs - b.pBar) ** 2, 0) / nUsed;
  const noise = kept.reduce((t, b) => t + b.pBar * (1 - b.pBar), 0) / nUsed;
  return {
    sigmaHat: Math.sqrt(Math.max(0, miss - noise)),
    nUsed,
    nBins: kept.length,
    curve: kept,
  };
}

module.exports = {
  bandsOf, bandFor, labelFor, replayElo, closingFair, consensusFair, aggregate,
  selectionsFrom, calibrationSigma,
  edgesWithMinSample, LEGACY_EDGES,
};
