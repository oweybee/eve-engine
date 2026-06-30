'use strict';

/**
 * recordAccas.js — daily forward-test ledger for the suggested accumulators.
 *
 * Once per UTC day, snapshots the "Edge" accumulator (the top value signals,
 * one per match) into suggested_accas, referencing the value_signals that form
 * its legs. Settlement is INHERITED from the existing per-signal settlement
 * (fetchResults), so there is no duplicated maths and no drift: an acca wins iff
 * every referenced signal wins. Idempotent via UNIQUE(strategy, acca_date).
 *
 * Runs after settlement in the engine workflow.
 */

const { getClient } = require('./lib/supabaseClient');

const ACCA_LEGS = parseInt(process.env.ACCA_TRACK_LEGS || '4', 10);

function utcDate(d = new Date()) { return d.toISOString().slice(0, 10); }

async function run() {
  console.log(`\n[accas] ${new Date().toISOString()}`);
  const supabase = getClient();
  const today = utcDate();

  // Already recorded today? (idempotent — the engine runs many times a day.)
  const { data: existing } = await supabase
    .from('suggested_accas')
    .select('strategy')
    .eq('acca_date', today)
    .eq('strategy', 'edge');
  if (existing && existing.length) {
    console.log('[accas] edge acca already recorded for', today);
    return;
  }

  // Top pending value signals (positive edge, not yet kicked off), one per match.
  const { data: sigs, error } = await supabase
    .from('value_signals')
    .select('id, match_id, detected_odds, detected_edge, kickoff_at, result')
    .eq('result', 'pending')
    .gt('detected_edge', 0)
    .gt('kickoff_at', new Date().toISOString())
    .order('detected_edge', { ascending: false })
    .limit(200);
  if (error) { console.error('[accas] fetch:', error.message); return; }

  // One leg per match (the highest-edge signal), then the top ACCA_LEGS matches.
  const perMatch = new Map();
  for (const s of sigs ?? []) {
    if (!perMatch.has(s.match_id)) perMatch.set(s.match_id, s);
  }
  const legs = [...perMatch.values()].slice(0, ACCA_LEGS);
  if (legs.length < 2) {
    console.log(`[accas] only ${legs.length} qualifying leg(s) — skipping today`);
    return;
  }

  const combinedOdds = +legs.reduce((p, l) => p * parseFloat(l.detected_odds), 1).toFixed(4);
  const combinedProb = +legs.reduce((p, l) => {
    const o = parseFloat(l.detected_odds), e = parseFloat(l.detected_edge);
    return p * Math.min(1, Math.max(0, (e + 1) / o));   // modelProb = (edge+1)/odds
  }, 1).toFixed(6);

  const { error: insErr } = await supabase
    .from('suggested_accas')
    .upsert({
      strategy: 'edge',
      acca_date: today,
      signal_ids: legs.map(l => l.id),
      leg_count: legs.length,
      combined_odds: combinedOdds,
      combined_prob: combinedProb,
    }, { onConflict: 'strategy,acca_date' });

  if (insErr) { console.error('[accas] insert:', insErr.message); return; }
  console.log(`[accas] recorded edge acca for ${today}: ${legs.length} legs @ ${combinedOdds}`);
}

if (require.main === module) {
  run().then(() => process.exit(0)).catch(err => { console.error('[accas] unhandled:', err); process.exit(0); });
}

module.exports = { run };
