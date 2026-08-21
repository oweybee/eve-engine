#!/usr/bin/env node
'use strict';

/**
 * scripts/refreshDisagreement.js — recompute the model-vs-market scorecard.
 *
 * RUN THIS AFTER EVERY MODEL RE-FIT. The figures in `disagreement_calibration`
 * describe one specific fit of one specific model. A re-fit that does not
 * refresh them leaves the UI quoting the old model's record as though it were
 * the new one's — and because the copy is generated from the table rather than
 * written by hand, nobody will notice the sentence has gone stale.
 *
 * Also run it whenever research_dc_preds gains seasons.
 *
 * The work happens in `refresh_disagreement_calibration()` (migration 054), not
 * here: it aggregates 44,000+ selections, and shipping them to Node to divide
 * them and ship them back would be a worse design than one SQL function. This
 * script is the operator's handle on it — it invokes, verifies and prints.
 *
 * Usage:  node scripts/refreshDisagreement.js [--quiet] [--verify] [--width=N]
 *         node scripts/refreshDisagreement.js --sigma     measured sigma_p only
 */

const QUIET = process.argv.includes('--quiet');
const VERIFY = process.argv.includes('--verify');
const WRITE = process.argv.includes('--write');
const SIGMA = process.argv.includes('--sigma');
const WIDTH_ARG = process.argv.find(a => a.startsWith('--width='));
const WIDTH = WIDTH_ARG ? Number(WIDTH_ARG.split('=')[1]) : null;

const PAGE = 1000;

/**
 * The smallest per-point sample that may stand on its own.
 *
 * Below this a point estimate is noise: at single points ELO reads 51.0% at
 * 11pp, 57.7% at 14pp and 53.1% at 22pp, so the wider disagreement would be
 * quoted as the safer one, and 37pp lands on an exact 50/50 over 16 rows.
 * Everything above the first point that falls short is merged into one
 * open-ended band, re-aggregated from the selections rather than averaged out
 * of the band summaries — percentages do not average.
 */
const MIN_SAMPLE = Number(process.env.MIN_SAMPLE || '300');

/**
 * Every research row, PAGED.
 *
 * PostgREST caps a response at 1000 rows and says nothing about it — the same
 * silent truncation that has captureSnapshot processing 1000 of 1509
 * computed_values rows. A fit built on a truncated corpus is not a smaller fit,
 * it is a wrong one, and it would look entirely plausible.
 */
async function pageAll(supabase, table, columns, order = 'id') {
  const out = [];
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await supabase
      .from(table).select(columns)
      .order(order, { ascending: true })
      .range(from, from + PAGE - 1);
    if (error) throw new Error(`${table} read: ${error.message}`);
    if (!data?.length) break;
    out.push(...data);
    if (data.length < PAGE) break;
  }
  return out;
}

async function fetchCorpus(supabase) {
  // JOINED IN NODE, NOT BY POSTGREST. There is no foreign key between these two
  // tables — they are row-aligned on `id` and nothing declares it — so an
  // embedded select fails with "Could not find a relationship ... in the schema
  // cache". Two paged reads and a Map is the honest version of the join the
  // research corpus actually supports.
  const preds = await pageAll(supabase, 'research_dc_preds',
    'id, match_date, ftr, odds, p_home, p_draw, p_away');
  const ratings = await pageAll(supabase, 'research_match_ratings',
    'id, home_tid, away_tid');

  const byId = new Map(ratings.map(r => [r.id, r]));
  let unmatched = 0;
  const rows = preds.map(p => {
    const r = byId.get(p.id);
    if (!r) unmatched++;
    return { ...p, home_tid: r?.home_tid ?? null, away_tid: r?.away_tid ?? null };
  });
  // A row with no ratings partner still counts for DIXON_COLES and is skipped
  // by the Elo replay, so the two models can legitimately have different
  // sample sizes. Said out loud rather than left to be inferred from a total.
  console.log(`[refit] ${preds.length} preds, ${ratings.length} ratings, ` +
    `${unmatched} pred(s) with no ratings row`);
  return rows;
}

/**
 * Recompute both models from the corpus and, unless --write is passed, only
 * print. The fit is the same code at any band width; --verify runs it at the
 * PUBLISHED cuts and diffs against the live table, which is the only check that
 * says this reproduces the numbers the product has been quoting.
 */
async function refit() {
  const { getClient } = require('../lib/supabaseClient');
  const { loadEloParams } = require('../lib/eloProbs');
  const { bandsOf, aggregate, selectionsFrom, edgesWithMinSample, calibrationSigma } =
    require('../lib/disagreementFit');
  const supabase = getClient();

  // loadEloParams takes an OPTIONS OBJECT, not positional model/version.
  const eloParams = await loadEloParams(supabase, { model: 'ELO_1X2', version: 'v1' });
  const corpus = await fetchCorpus(supabase);
  console.log(`\n[refit] ${corpus.length} research rows, elo params ` +
    `d0=${eloParams.drawAtParity} s=${eloParams.drawSpread} homeAdv=${eloParams.homeAdv}`);

  const sel = selectionsFrom(corpus, eloParams);

  // The publishable bar per model. MARKET_ANCHORED has never had one: it is
// being MEASURED here for the first time, so it is deliberately parked at 1 —
// a bar nothing can clear — until its own count-vs-Brier picture is read.
// Publishing a record the moment it exists is how a number nobody has looked
// at reaches a match card.
const MIN_GAP = { DIXON_COLES: 0.06, ELO: 0.10, MARKET_ANCHORED: 1 };
const MODELS = ['DIXON_COLES', 'ELO', 'MARKET_ANCHORED'];
  // ── MEASURED PROBABILITY ERROR, on the same selections ────────────────────
  //
  // WHY THIS RUNS HERE. `sigma_p` in `model_calibration` is what the conviction
  // ladder divides a disagreement by, and migration 048's `calibration_report()`
  // measures it from `value_signals` — rows a model BET on. ELO has never
  // written one: it writes `elo_forecasts`, which is forward-looking and held 49
  // settled fixtures on 21 Aug 2026. Measuring the product's most-rendered
  // forecast off fifty games would be the LAMBDA_MC shape with a number attached.
  //
  // This corpus is the one the scorecard is already built on, so the sigma is
  // measured over the same rows, by the same estimator, as everything else the
  // model claims about itself.
  //
  // IT PRINTS AND DOES NOT WRITE, deliberately. Inserting a `model_calibration`
  // row is what makes an architecture scoreable across the whole product; that
  // is a migration and an owner decision, not a side effect of a re-fit.
  if (SIGMA) {
    console.log('\n[sigma] measured probability error — migration 048\'s estimator');
    console.log('        model            n      bins   sigma_p    2σ (the PRIME bar)');
    for (const model of MODELS) {
      const r = calibrationSigma(sel[model]);
      if (r.sigmaHat == null) {
        console.log(`        ${model.padEnd(16)} no bin cleared the minimum`);
        continue;
      }
      const prime = (2.019 * r.sigmaHat * 100).toFixed(2);
      console.log(`        ${model.padEnd(16)} ${String(r.nUsed).padStart(6)}  ${String(r.nBins).padStart(4)}   ` +
        `${r.sigmaHat.toFixed(4)}     ${prime}pp`);
      for (const b of r.curve) {
        console.log(`          bin ${String(b.bucket).padStart(2)}  n=${String(b.n).padStart(6)}  ` +
          `forecast ${(b.pBar * 100).toFixed(1)}%  realised ${(b.obs * 100).toFixed(1)}%  ` +
          `miss ${((b.obs - b.pBar) * 100 >= 0 ? '+' : '')}${((b.obs - b.pBar) * 100).toFixed(1)}pp`);
      }
    }
  }

  const result = {};
  for (const model of MODELS) {
    // PER MODEL, because the two corpora differ in size and the point where a
    // per-point band stops being a measurement is a property of the sample.
    const edges = VERIFY
      ? bandsOf(null)
      : edgesWithMinSample(sel[model], WIDTH, MIN_SAMPLE);
    const bands = aggregate(sel[model], edges);
    result[model] = bands;
    const tail = bands[bands.length - 1];
    console.log(`\n  ${model} — ${sel[model].length} selections, ${bands.length} band(s)` +
      (VERIFY ? '' : `, per point to ${tail.gap_bucket} (min sample ${MIN_SAMPLE})`));
    for (const b of bands) {
      console.log(`    ${String(b.gap_bucket).padEnd(9)} n=${String(b.n).padStart(6)}  ` +
        `market ${String(b.market_right_pct).padStart(5)}%  model ${String(b.model_right_pct).padStart(5)}%  ` +
        `brier ${b.brier_model} vs ${b.brier_market}`);
    }
  }

  if (VERIFY) {
    const { data: live, error } = await supabase
      .from('disagreement_calibration')
      .select('model, gap_bucket, n, market_right_pct, model_right_pct');
    if (error) throw new Error(`live read: ${error.message}`);
    console.log('\n  [verify] recomputed vs published');
    let mismatches = 0;
    for (const model of MODELS) {
      for (const b of result[model]) {
        const pub = live.find(l => l.model === model && l.gap_bucket === b.gap_bucket);
        const same = pub && Number(pub.n) === b.n
          && Number(pub.market_right_pct) === b.market_right_pct;
        if (!same) mismatches++;
        console.log(`    ${same ? 'ok  ' : 'DIFF'} ${model} ${b.gap_bucket}: ` +
          `n ${b.n} vs ${pub?.n ?? '—'}, market ${b.market_right_pct}% vs ${pub?.market_right_pct ?? '—'}%`);
      }
    }
    console.log(`\n  ${mismatches} mismatch(es).`);
    return;
  }

  if (!WRITE) {
    console.log('\n  Dry run — pass --write to replace the table.');
    return;
  }

  const rows = [];
  for (const model of MODELS) {
    for (const b of result[model]) {
      rows.push({ ...b, model, min_publishable_gap: MIN_GAP[model], computed_at: new Date().toISOString() });
    }
  }
  // REPLACE, not merge: a re-cut changes which bucket labels exist, and leaving
  // the old ones behind would let `bucketFor` match a stale band that overlaps
  // a new one.
  const { error: delErr } = await supabase
    .from('disagreement_calibration').delete().in('model', MODELS);
  if (delErr) throw new Error(`clear: ${delErr.message}`);
  const { error: insErr } = await supabase.from('disagreement_calibration').insert(rows);
  if (insErr) throw new Error(`insert: ${insErr.message}`);
  console.log(`\n  Wrote ${rows.length} row(s).`);
}

async function main() {
  // `--sigma` IS A REFIT PATH. It reads the replayed selections, so it has to
  // go through refit() — falling through to the legacy RPC below runs
  // refresh_disagreement_calibration(), which has been broken since migration
  // 075 and fails with "no unique or exclusion constraint matching the ON
  // CONFLICT specification". Which it duly did, the first time this flag ran.
  if (VERIFY || WRITE || SIGMA || WIDTH != null) return refit();

  const { getClient } = require('../lib/supabaseClient');
  const supabase = getClient();

  const { data: written, error: rpcError } = await supabase
    .rpc('refresh_disagreement_calibration');
  // supabase-js RESOLVES with { error } rather than throwing, so an unchecked
  // await here would report success on a failed refresh — the exact shape that
  // let the Stripe webhook return 200 on every rejected upgrade.
  if (rpcError) throw new Error(`refresh_disagreement_calibration: ${rpcError.message}`);

  const { data: rows, error: readError } = await supabase
    .from('disagreement_calibration')
    .select('gap_bucket, gap_min, gap_max, n, market_right_pct, model_right_pct, brier_model, brier_market, computed_at')
    .order('gap_min', { ascending: true });
  if (readError) throw new Error(`disagreement_calibration read-back: ${readError.message}`);

  if (!rows?.length) throw new Error('refresh reported success but the table is empty');

  if (!QUIET) {
    console.log(`\nRefreshed ${written} bucket(s) at ${rows[0].computed_at}\n`);
    const head = ['bucket', 'n', 'market right', 'model right', 'Brier model', 'Brier market'];
    console.log('  ' + head.join('  |  '));
    for (const r of rows) {
      console.log(`  ${String(r.gap_bucket).padEnd(8)}  ${String(r.n).padStart(6)}  ` +
        `${String(r.market_right_pct).padStart(11)}%  ${String(r.model_right_pct).padStart(10)}%  ` +
        `${String(r.brier_model).padStart(10)}  ${String(r.brier_market).padStart(11)}`);
    }
    const total = rows.reduce((t, r) => t + r.n, 0);
    console.log(`\n  ${total} selections.`);
    // The gradient is the whole reason the model does not get a vote. If it
    // ever inverts, that is a finding, not a formatting problem.
    const first = rows[0], last = rows[rows.length - 1];
    if (Number(last.market_right_pct) <= Number(first.market_right_pct)) {
      console.log('\n  ⚠ The disagreement gradient has INVERTED or flattened.');
      console.log('    The market no longer wins more often as the model diverges.');
      console.log('    That is a material change to the architecture\'s premise — do not');
      console.log('    ship copy off this table until someone has looked at why.');
    }
  }
}

if (require.main === module) {
  main().catch(err => { console.error(err.message); process.exit(1); });
}
