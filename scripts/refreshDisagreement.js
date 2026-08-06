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
 * Usage:  node scripts/refreshDisagreement.js [--quiet]
 */

const QUIET = process.argv.includes('--quiet');

async function main() {
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
