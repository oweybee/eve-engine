#!/usr/bin/env node
'use strict';

/**
 * scripts/backtestMarketAnchor.js — the harness behind every figure quoted for
 * the market-anchored architecture.
 *
 * It exists because the previous decay analysis did NOT exist as committed
 * code. Its results were quoted in the work order — 177 signals in 2019/20
 * falling to 39 in 2025/26, yields from -15.23% to +23.98% — and could not be
 * reproduced, because the script that produced them was never checked in. That
 * is how a finding becomes folklore. This one is checked in.
 *
 * It deliberately runs through the SHIPPED modules — lib/devig.js and
 * lib/marketAnchor.js — rather than reimplementing the arithmetic. A backtest
 * that reimplements the thing it is testing measures the reimplementation.
 *
 * WHAT IT MEASURES
 *   1. The seven-season decay table, Shin against multiplicative de-vig, at
 *      best-of-panel and bet365-only prices (Task 2).
 *   2. The flagged-longshot book by price band, which is the de-vig question
 *      stated directly.
 *   3. The model-veto yield curve across the whole theta grid (Task 5).
 *
 * WHAT IT CANNOT MEASURE. Component C of the MES. research_dc_preds carries a
 * fixed bookmaker panel, no capture timestamps and no line history, so
 * books_quoting, hours_to_kickoff and line stability do not exist in it. C is
 * therefore pinned to HELD_CONSTANT_CONFIDENCE here, exactly as it was pinned
 * in every historical figure. See scripts/backtestConfidence.js for how far
 * that question can be taken on the data that does exist, which is not far.
 *
 * READ THE CAVEATS BEFORE QUOTING THE OUTPUT
 *   • research_dc_preds is fitted PER SEASON (fit_label dc_2019 … dc_2025), so
 *     model probabilities are IN-SAMPLE. This does not touch tables 1 and 2,
 *     which never consult the model. It flatters the model in table 3, so the
 *     veto's case is weaker than it looks, not stronger.
 *   • 2025/26 has 38.1% Pinnacle coverage against 98.7-100% in every other
 *     season. Raw signal counts for that season are a data artifact. The table
 *     prints signals per 1,000 priced matches alongside the count for exactly
 *     this reason — compare THAT column across seasons, not the count.
 *   • Per-season n is 15-120. Yields at that sample size are noise wearing a
 *     decimal point.
 *
 * Usage:  node scripts/backtestMarketAnchor.js [--json]
 */

const { shinDevig, multiplicativeDevig } = require('../lib/devig');
const ma = require('../lib/marketAnchor');
const veto = require('../lib/modelVeto');

const PAGE = 1000;
const OUTCOMES = ['H', 'D', 'A'];

/** football-data.co.uk column keys, per price source. */
const PRICE_KEYS = {
  panel:  { H: 'MaxH',  D: 'MaxD',  A: 'MaxA'  },  // best of the panel
  bet365: { H: 'B365H', D: 'B365D', A: 'B365A' },
};
const PINNACLE_OPEN = { H: 'PSH', D: 'PSD', A: 'PSA' };

const num = x => {
  if (x == null || x === '') return NaN;
  const n = Number(x);
  return Number.isFinite(n) ? n : NaN;
};

async function fetchAll(supabase) {
  const rows = [];
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await supabase
      .from('research_dc_preds')
      .select('season, ftr, p_home, p_draw, p_away, odds')
      .order('match_date', { ascending: true })
      .range(from, from + PAGE - 1);
    if (error) throw new Error(`research_dc_preds: ${error.message}`);
    if (!data?.length) break;
    rows.push(...data);
    if (data.length < PAGE) break;
  }
  return rows;
}

/**
 * Expand one match into up to three selections under one de-vig method and one
 * price source. Returns [] when the anchor is incomplete — a match without a
 * full Pinnacle price is not a match this architecture has an opinion about.
 */
function selectionsFor(row, devig, priceSource) {
  const o = row.odds ?? {};
  const anchor = OUTCOMES.map(k => num(o[PINNACLE_OPEN[k]]));
  const r = devig(anchor);
  if (r.probs === null) return [];

  const modelProb = { H: num(row.p_home), D: num(row.p_draw), A: num(row.p_away) };
  const out = [];
  OUTCOMES.forEach((pick, i) => {
    const price = num(o[PRICE_KEYS[priceSource][pick]]);
    if (!(price > 1)) return;
    const fairProb = r.probs[i];
    // Component C pinned — see the header.
    const ev = ma.evaluate({
      fairProb, bestPrice: price,
      // research_dc_preds has no book count. The football-data panel is a fixed
      // set of major books, all of which quote every fixture, so the books gate
      // is satisfied by construction rather than measured. Stated, not hidden.
      booksQuoting: ma.THRESHOLDS.MIN_BOOKS,
      confidenceOverride: ma.HELD_CONSTANT_CONFIDENCE,
    });
    out.push({
      season: row.season,
      pick,
      won: row.ftr === pick,
      fairProb,
      price,
      edge: ev.edge,
      score: ev.score,
      band: ev.band,
      passes: ev.passes,
      modelProb: Number.isFinite(modelProb[pick]) ? modelProb[pick] : null,
      gap: veto.disagreementGap(modelProb[pick], fairProb),
    });
  });
  return out;
}

const profit = s => (s.won ? s.price - 1 : -1);
const yieldPct = list => list.length
  ? (100 * list.reduce((t, s) => t + profit(s), 0) / list.length)
  : null;
const strikePct = list => list.length
  ? (100 * list.filter(s => s.won).length / list.length)
  : null;
const fmt = (x, d = 2) => (x === null || !Number.isFinite(x) ? '   —  ' : x.toFixed(d).padStart(6));

function table(title, headers, rows) {
  console.log(`\n${title}`);
  const widths = headers.map((h, i) =>
    Math.max(h.length, ...rows.map(r => String(r[i]).length)));
  const line = cells => '  ' + cells.map((c, i) => String(c).padStart(widths[i])).join('  ');
  console.log(line(headers));
  console.log('  ' + widths.map(w => '─'.repeat(w)).join('  '));
  rows.forEach(r => console.log(line(r)));
}

async function main() {
  const { getClient } = require('../lib/supabaseClient');
  const supabase = getClient();

  console.log('Fetching research_dc_preds …');
  const rows = await fetchAll(supabase);
  console.log(`${rows.length} matches.`);

  // Priced-match counts per season, so signal counts can be normalised. 2025/26
  // is 38% covered and its raw counts mean nothing without this.
  const priced = new Map();
  for (const r of rows) {
    const complete = OUTCOMES.every(k => num((r.odds ?? {})[PINNACLE_OPEN[k]]) > 1);
    if (!complete) continue;
    priced.set(r.season, (priced.get(r.season) ?? 0) + 1);
  }
  const seasons = [...priced.keys()].sort();

  // ── 1. The decay table ────────────────────────────────────────────────────
  for (const priceSource of ['panel', 'bet365']) {
    for (const [label, devig] of [['Shin', shinDevig], ['multiplicative', multiplicativeDevig]]) {
      const sels = rows.flatMap(r => selectionsFor(r, devig, priceSource));
      const published = sels.filter(s => s.passes && ma.isPublishedBand(s.band));
      const body = seasons.map(season => {
        const inSeason = published.filter(s => s.season === season);
        const p = priced.get(season) ?? 0;
        return [
          season, p, inSeason.length,
          p ? (1000 * inSeason.length / p).toFixed(1) : '—',
          fmt(yieldPct(inSeason)), fmt(strikePct(inSeason), 1),
        ];
      });
      body.push(['ALL', [...priced.values()].reduce((a, b) => a + b, 0), published.length, '',
                 fmt(yieldPct(published)), fmt(strikePct(published), 1)]);
      table(`Decay — ${label} de-vig, ${priceSource} price, published (MES ≥ ${ma.THRESHOLDS.STRONG_MIN})`,
        ['season', 'priced', 'n', 'per1000', 'yield%', 'strike%'], body);
    }
  }

  // ── 2. The longshot book — the de-vig question, stated directly ───────────
  const BANDS = [
    ['<3.00', 0, 3], ['3.00-4.50', 3, 4.5], ['4.50-8.00', 4.5, 8], ['8.00+', 8, Infinity],
  ];
  const longshotRows = [];
  for (const [label, devig] of [['Shin', shinDevig], ['mult', multiplicativeDevig]]) {
    // Flagged on EDGE ALONE — no price cap — so the two methods can be compared
    // on the selections they each choose to flag.
    const flagged = rows.flatMap(r => selectionsFor(r, devig, 'panel'))
      .filter(s => s.edge !== null && s.edge >= ma.THRESHOLDS.MIN_EDGE);
    for (const [band, lo, hi] of BANDS) {
      const inBand = flagged.filter(s => s.price >= lo && s.price < hi);
      longshotRows.push([label, band, inBand.length, inBand.filter(s => s.won).length,
        fmt(strikePct(inBand), 1), fmt(yieldPct(inBand))]);
    }
  }
  table('Flagged selections by price band (edge ≥ 2%, NO price cap)',
    ['devig', 'band', 'n', 'won', 'strike%', 'yield%'], longshotRows);

  // ── 3. The veto curve ────────────────────────────────────────────────────
  const gated = rows.flatMap(r => selectionsFor(r, shinDevig, 'panel')).filter(s => s.passes);
  const vetoRows = veto.THETA_GRID.map(theta => {
    const kept = gated.filter(s => s.gap === null || s.gap <= theta);
    const supp = gated.filter(s => s.gap !== null && s.gap > theta);
    return [theta.toFixed(2), kept.length, fmt(yieldPct(kept)), supp.length, fmt(yieldPct(supp))];
  });
  vetoRows.unshift(['none', gated.length, fmt(yieldPct(gated)), 0, '   —  ']);
  table('Model veto — yield curve across theta (Shin, panel, gated set)\n' +
        '  A veto is only worth having where yield_supp is clearly NEGATIVE.',
    ['theta', 'n_kept', 'yield_kept%', 'n_supp', 'yield_supp%'], vetoRows);

  console.log(`\nDefault theta is ${veto.DEFAULT_THETA} — a pathology guard, not a fitted optimum.`);
  console.log('See lib/modelVeto.js: every theta that suppresses meaningfully suppresses money.\n');
}

if (require.main === module) {
  main().catch(err => { console.error(err); process.exit(1); });
}

module.exports = { selectionsFor, yieldPct, strikePct };
