'use strict';

/**
 * lib/edgeTable — clubs measured against their own closing prices, for the
 * Discord #edge-table card.
 *
 * THIS IS A PORT, AND IT SAYS SO. The site's /leagues page is drawn by
 * eve-frontend `lib/edgeTable.ts`, which is the source of truth for the
 * arithmetic and carries the reasoning behind every ruling below at length.
 * Discord posts from this repo, so the arithmetic is repeated here statement
 * for statement rather than re-derived, over the SAME view
 * (`settled_match_prices`, migration 083) and the SAME Shin de-vig
 * (`lib/devig`, which is the engine's copy of the identical algorithm).
 * engine.edgetable.test.js pins the figures a change on either side must keep.
 *
 * The rulings, in one line each:
 *   1. Expectation is the SHIN-de-vigged probability of winning, never 1/odds.
 *   2. Money is settled at the QUOTED close, margin in it.
 *   3. A season is not a sample, so z is a first-class column.
 *   4. The bar is Bonferroni over the rows actually ranked, not a fixed 2.
 *   5. An unpriceable match is counted, never dropped.
 *
 * Pure, no I/O.
 */

const { shinDevig } = require('./devig');

const DIVISION_NAMES = {
  E0: 'Premier League', E1: 'Championship', E2: 'League One', E3: 'League Two',
  EC: 'National League', F1: 'Ligue 1', D1: 'Bundesliga', I1: 'Serie A',
  N1: 'Eredivisie', SP1: 'La Liga',
};
const divisionLabel = div => DIVISION_NAMES[div] ?? div;

/** A club needs this many priced matches before it is ranked. Same as the site. */
const MIN_RANKED_MATCHES = 6;
const NOMINAL_Z = 2;
const BEYOND_CHANCE_ALPHA = 0.05;

function toPrice(x) {
  const n = typeof x === 'number' ? x : (typeof x === 'string' && x.trim() ? Number(x) : NaN);
  return Number.isFinite(n) && n > 1 ? n : null;
}

/** Home and away fair win probabilities for one settled match, or null. */
function devigMatch(row) {
  const h = toPrice(row?.close_home), d = toPrice(row?.close_draw), a = toPrice(row?.close_away);
  if (h == null || d == null || a == null) return null;
  const { probs } = shinDevig([h, d, a]);
  if (!probs || probs.length !== 3) return null;
  const [ph, , pa] = probs;
  if (!Number.isFinite(ph) || !Number.isFinite(pa)) return null;
  return { home: ph, away: pa };
}

function buildEdgeTable(rows) {
  const tallies = new Map();
  let matches = 0, unpriceable = 0;
  for (const r of rows ?? []) {
    if (!r?.home_team || !r?.away_team || !r?.ftr) continue;
    matches += 1;
    const probs = devigMatch(r);
    if (!probs) unpriceable += 1;
    const prices = { home: toPrice(r.close_home), away: toPrice(r.close_away) };
    for (const side of ['home', 'away']) {
      const team = side === 'home' ? r.home_team : r.away_team;
      const key = `${r.season}|${r.div}|${team}`;
      let t = tallies.get(key);
      if (!t) {
        t = { team, div: r.div, country: r.country ?? null, season: r.season,
          played: 0, wins: 0, draws: 0, losses: 0, expectedWins: 0, variance: 0,
          priceSum: 0, profitUnits: 0, unpriced: 0 };
        tallies.set(key, t);
      }
      const won = r.ftr === (side === 'home' ? 'H' : 'A');
      const drew = r.ftr === 'D';
      t.played += 1;
      if (won) t.wins += 1; else if (drew) t.draws += 1; else t.losses += 1;
      const p = probs ? probs[side] : null;
      const price = prices[side];
      if (p == null || price == null) { t.unpriced += 1; continue; }
      t.expectedWins += p;
      t.variance += p * (1 - p);
      t.priceSum += price;
      t.profitUnits += won ? price - 1 : -1;
    }
  }
  const teams = [...tallies.values()].map(finish)
    .sort((a, b) => b.edgePoints - a.edgePoints || a.team.localeCompare(b.team));
  return { teams, matches, unpriceable };
}

function finish(t) {
  const priced = t.played - t.unpriced;
  const delta = t.wins - t.expectedWins;
  return {
    team: t.team, div: t.div, country: t.country, season: t.season,
    played: t.played, priced, wins: t.wins, draws: t.draws, losses: t.losses,
    expectedWins: t.expectedWins, variance: t.variance,
    edgePoints: priced > 0 ? (100 * delta) / priced : 0,
    z: t.variance > 0 ? delta / Math.sqrt(t.variance) : null,
    meanPrice: priced > 0 ? t.priceSum / priced : 0,
    profitUnits: t.profitUnits,
    roiPercent: priced > 0 ? (100 * t.profitUnits) / priced : 0,
    unpriced: t.unpriced,
  };
}

/** Φ(x), Abramowitz & Stegun 7.1.26. Same constants as the site. */
function normalCdf(x) {
  if (!Number.isFinite(x)) return NaN;
  const sign = x < 0 ? -1 : 1;
  const t = 1 / (1 + 0.3275911 * (Math.abs(x) / Math.SQRT2));
  const y = 1 - (((((1.061405429 * t - 1.453152027) * t) + 1.421413741) * t - 0.284496736) * t
    + 0.254829592) * t * Math.exp(-(x * x) / 2);
  return 0.5 * (1 + sign * y);
}
const twoSidedP = z => (Number.isFinite(z) ? 2 * (1 - normalCdf(Math.abs(z))) : NaN);
function chanceCount(n, threshold) {
  if (!Number.isFinite(n) || n <= 0 || !Number.isFinite(threshold)) return 0;
  return n * twoSidedP(threshold);
}
/** Bonferroni two-sided bar over n rows; null under two rows (nothing is marked). */
function beyondChanceBar(n, alpha = BEYOND_CHANCE_ALPHA) {
  if (!Number.isFinite(n) || n < 2) return null;
  const target = 1 - alpha / (2 * n);
  let lo = 0, hi = 10;
  for (let i = 0; i < 200 && hi - lo > 1e-9; i++) {
    const mid = (lo + hi) / 2;
    if (normalCdf(mid) < target) lo = mid; else hi = mid;
  }
  return (lo + hi) / 2;
}

/**
 * What the Discord card shows: the ranked clubs (>= MIN_RANKED_MATCHES priced),
 * the top and bottom k by edge, and the honest read of how much of it is chance.
 */
function edgeSummary(rows, { k = 5 } = {}) {
  const table = buildEdgeTable(rows);
  const ranked = table.teams.filter(t => t.priced >= MIN_RANKED_MATCHES && t.z != null);
  const n = ranked.length;
  const bar = beyondChanceBar(n);
  const clearNominal = ranked.filter(t => Math.abs(t.z) >= NOMINAL_Z).length;
  const clearBar = bar == null ? 0 : ranked.filter(t => Math.abs(t.z) >= bar).length;
  const top = ranked.slice(0, k);
  const bottom = ranked.slice(-k).reverse().filter(t => !top.includes(t));
  const throughDate = (rows ?? []).reduce((m, r) => (r?.match_date > m ? r.match_date : m), '');
  return {
    ranked: n, matches: table.matches, unpriceable: table.unpriceable,
    top, bottom,
    clearNominal, expectedByChance: chanceCount(n, NOMINAL_Z),
    bar, clearBar, throughDate: throughDate || null,
  };
}

module.exports = {
  buildEdgeTable, edgeSummary, devigMatch, beyondChanceBar, chanceCount, normalCdf,
  divisionLabel, MIN_RANKED_MATCHES, NOMINAL_Z,
};
