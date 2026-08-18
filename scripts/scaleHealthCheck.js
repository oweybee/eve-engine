'use strict';

/**
 * scripts/scaleHealthCheck.js — THE RELEASE GATE FOR EV- AND KELLY-BASED SCORES.
 *
 * Reads `market_prob_scale_check` (migration 060) and fails the run if any
 * market is RED. One product decides whether an EV or Kelly number on this
 * platform means anything:
 *
 *     market_prob × detected_odds
 *
 * `market_prob` is the de-vigged probability of the SAME side, at the SAME
 * line, out of the SAME vector the price was taken from — so the product is
 * 1/overround of the market the reader can bet into. A real book keeps margin,
 * so it must land BELOW 1, and across a best-price panel it settles in
 * 0.94–0.99.
 *
 * ABOVE 1 SAYS THE FAIR LINE BEATS ITS OWN PRICE, on every leg at once, which
 * on a two-way market means the over and the under are both flagged as value.
 * That was live on 18 Aug 2026: 60 totals fixtures and 13 BTTS fixtures carried
 * both sides, and the totals cohort averaged 1.0167.
 *
 * A CHECK THAT ONLY PRINTS IS NOT A CHECK. This exits non-zero, so the workflow
 * goes red and the failure is visible without anyone remembering to look.
 *
 *   node scripts/scaleHealthCheck.js
 */

const { getClient } = require('../lib/supabaseClient');

/** The band the invariant has to sit in. Mirrors the view's own CASE, which is
 *  the authority — this is here so the printed report can say WHY, not to make
 *  a second ruling. */
const BAND_LO = 0.94;
const BAND_HI = 0.99;

async function main() {
  const supabase = getClient();

  const { data, error } = await supabase
    .from('market_prob_scale_check')
    .select('market, scored_rows, avg_consistency, min_consistency, max_consistency, rows_over_one, verdict')
    .order('market');

  if (error) throw new Error(`market_prob_scale_check: ${error.message}`);

  const rows = data ?? [];

  console.log('\nmarket_prob × detected_odds — the price/consensus scale invariant');
  console.log(`band ${BAND_LO}–${BAND_HI}, and no row may exceed 1.00\n`);
  console.log('  market      rows   avg      min      max      >1.00  verdict');
  console.log('  ' + '─'.repeat(66));

  for (const r of rows) {
    console.log(
      '  ' +
      String(r.market).padEnd(11) +
      String(r.scored_rows).padStart(5) + '  ' +
      String(r.avg_consistency ?? '—').padStart(7) + '  ' +
      String(r.min_consistency ?? '—').padStart(7) + '  ' +
      String(r.max_consistency ?? '—').padStart(7) + '  ' +
      String(r.rows_over_one).padStart(6) + '  ' +
      r.verdict
    );
  }

  // A market with no scored rows is not a pass and not a failure — it is a
  // market the engine has not written a score for yet. Say so rather than let
  // an empty table read as green across the board, which is exactly how three
  // features in this repo shipped silently dead.
  const MARKETS = ['h2h', 'totals', 'btts'];
  const seen = new Set(rows.map(r => r.market));
  const missing = MARKETS.filter(m => !seen.has(m));
  if (missing.length) {
    console.log(`\n  no scored rows yet for: ${missing.join(', ')} — nothing to check, and nothing verified`);
  }

  await reportLiveness(supabase);

  const red = rows.filter(r => String(r.verdict).startsWith('RED'));
  if (red.length) {
    console.error(`\n✗ SCALE CHECK RED on ${red.map(r => r.market).join(', ')}`);
    console.error('  No EV- or Kelly-based score may go live while this is red.');
    process.exit(1);
  }

  console.log(`\n✓ scale check green on ${rows.length} market${rows.length === 1 ? '' : 's'}`);
}

/**
 * PRICE LIVENESS — reported, deliberately NOT a hard gate.
 *
 * CLV against the close cannot separate "we found a better price" from "we
 * recorded a price nobody was offering". Both read as positive CLV and the
 * second reads MORE positive: across the settled book the unavailable rows
 * carry the higher CLV on every architecture but one.
 *
 * `price_was_takeable()` asks the clean version of the question — was this
 * price at or below the best a BETTABLE book was showing at the time. A premium
 * over the median can be honest (best-of-nine legitimately beats the median by
 * ~3.5%, measured); a price above the contemporaneous maximum cannot be.
 *
 * WHY IT ONLY WARNS. The measure is bounded by how dense the odds feed is, and
 * the feed writes in bursts covering 10-23 fixtures an hour with the freshest
 * quote on the forward card around 64 minutes old. A thin window misclassifies
 * a real price as unavailable, and a second hard gate that goes red on history
 * nobody can change is a gate people learn to ignore. The scale invariant above
 * is the one that fails the build; this one is for reading.
 */
async function reportLiveness(supabase) {
  const { data, error } = await supabase
    .from('signal_price_liveness')
    .select('model_architecture, market, settled, checkable, takeable, takeable_pct, clv_all_pct, clv_takeable_pct, z_takeable')
    .order('clv_takeable_pct', { ascending: false, nullsFirst: false });

  if (error) {
    console.log(`\n  price liveness unavailable: ${error.message}`);
    return;
  }

  console.log('\n\nprice liveness — was the price we published actually available?');
  console.log('CLV on bets that could have been placed, vs CLV on everything\n');
  console.log('  architecture      market   settled  takeable   CLV all   CLV takeable      z');
  console.log('  ' + '─'.repeat(74));

  for (const r of data ?? []) {
    const pct = r.takeable_pct == null ? '—' : `${r.takeable_pct}%`;
    console.log(
      '  ' +
      String(r.model_architecture ?? '—').padEnd(17) +
      String(r.market).padEnd(8) +
      String(r.settled).padStart(7) + '  ' +
      pct.padStart(8) + '  ' +
      String(r.clv_all_pct ?? '—').padStart(8) + '  ' +
      String(r.clv_takeable_pct ?? '—').padStart(12) + '  ' +
      String(r.z_takeable ?? '—').padStart(6)
    );
  }

  const thin = (data ?? []).filter(r => r.takeable_pct != null && r.takeable_pct < 50);
  if (thin.length) {
    console.log(
      `\n  ⚠  ${thin.map(r => `${r.model_architecture}/${r.market} ${r.takeable_pct}%`).join(', ')} ` +
      `— under half these prices were available when we published them.`);
  }
}

main().catch(err => {
  console.error(`✗ scale health check failed to run: ${err.message}`);
  process.exit(1);
});
