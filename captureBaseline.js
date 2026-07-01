'use strict';

/**
 * captureBaseline.js — freeze the pre-match goal expectations for the in-play
 * win-probability engine (Phase 2).
 *
 * For each scheduled match approaching kickoff, de-vig the consensus 1X2
 * (reusing computeValues' consensus core), invert it to full-match expected
 * goals (λ_home, λ_away) via lib/inplayWinProb, and upsert into inplay_baseline.
 * Runs each pre-match cycle (engine.yml) so the row tracks the market toward the
 * closing line; once a match has kicked off it is left frozen — that pre-match
 * anchor is what the live engine holds against in-play prices.
 *
 * Required: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY.
 * Usage: node captureBaseline.js [--dry-run]
 */

const { getClient } = require('./lib/supabaseClient');
const { fetchMatchesForComputation, computeConsensus } = require('./computeValues');
const { invertConsensusToLambda } = require('./lib/inplayWinProb');

const DRY_RUN = process.argv.includes('--dry-run');
// Start capturing this far ahead of kickoff (and keep refreshing until KO).
const CAPTURE_LEAD_MS = parseInt(process.env.BASELINE_LEAD_MIN || '240', 10) * 60 * 1000;

async function run() {
  console.log(`\n[baseline] ${new Date().toISOString()}${DRY_RUN ? ' [DRY RUN]' : ''}`);
  const supabase = getClient();

  const matches = await fetchMatchesForComputation(supabase, ['scheduled']);
  const now = Date.now();

  const rows = [];
  for (const m of matches) {
    const ko = m.kickoff_at ? new Date(m.kickoff_at).getTime() : NaN;
    if (!Number.isFinite(ko)) continue;
    if (now >= ko) continue;                      // kicked off — keep the frozen anchor
    if (ko - now > CAPTURE_LEAD_MS) continue;     // too far out yet

    const c = computeConsensus(m.odds);
    if (!c || !c.home || !c.draw || !c.away) continue;
    const pH = c.home.p_cons, pD = c.draw.p_cons, pA = c.away.p_cons;
    if (![pH, pD, pA].every(p => Number.isFinite(p) && p > 0)) continue;

    const { lambdaHome, lambdaAway } = invertConsensusToLambda(pH, pD, pA);
    rows.push({
      match_id:    m.id,
      lambda_home: +lambdaHome.toFixed(4),
      lambda_away: +lambdaAway.toFixed(4),
      p_home:      +pH.toFixed(4),
      p_draw:      +pD.toFixed(4),
      p_away:      +pA.toFixed(4),
      source:      'consensus',
      captured_at: new Date().toISOString(),
    });
  }

  console.log(`[baseline] ${rows.length} match(es) in capture window`);
  if (!rows.length) return;

  if (DRY_RUN) {
    for (const r of rows.slice(0, 5)) {
      console.log(`  [dry] ${r.match_id.slice(0, 8)} λ=(${r.lambda_home}, ${r.lambda_away})`);
    }
    return;
  }

  const { error } = await supabase
    .from('inplay_baseline')
    .upsert(rows, { onConflict: 'match_id' });
  if (error) throw new Error(`inplay_baseline upsert: ${error.message}`);
  console.log(`[baseline] upserted ${rows.length} baseline(s)`);
}

if (require.main === module) {
  run().catch(err => { console.error('[baseline] fatal:', err.message); process.exit(1); });
}

module.exports = { run };
