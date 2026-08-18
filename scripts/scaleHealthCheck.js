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

  const red = rows.filter(r => String(r.verdict).startsWith('RED'));
  if (red.length) {
    console.error(`\n✗ SCALE CHECK RED on ${red.map(r => r.market).join(', ')}`);
    console.error('  No EV- or Kelly-based score may go live while this is red.');
    process.exit(1);
  }

  console.log(`\n✓ scale check green on ${rows.length} market${rows.length === 1 ? '' : 's'}`);
}

main().catch(err => {
  console.error(`✗ scale health check failed to run: ${err.message}`);
  process.exit(1);
});
