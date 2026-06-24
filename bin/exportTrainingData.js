/**
 * bin/exportTrainingData.js — Historical Feature Matrix Extractor
 *
 * Harvests settled fixtures from Supabase and constructs the (X, y) training
 * matrix required for the XGBoost multi-class classifier.
 *
 * Strategy for obtaining ground-truth labels:
 *   The `value_signals` table stores the true match outcome implicitly:
 *     outcome = 'home'|'draw'|'away' AND result = 'win'
 *   means that outcome was the actual match result.
 *
 *   We SELECT DISTINCT ON (match_id) the winning signal row per match.
 *   Matches for which all signals are still 'pending', or for which we
 *   never fired a signal (selection bias), are excluded — this is a known
 *   limitation. Label encoding: home=0, draw=1, away=2.
 *
 * Feature vector:
 *   22 dimensions produced by features.js (rolling xG/PPDA/goals + rest
 *   days + neutral venue flag). Matches with completeness < MIN_COMPLETENESS
 *   are excluded so the model trains only on high-quality rows.
 *
 * Output:
 *   data/training_set.json — JSON array of { features: number[], label: number }
 *
 * Usage:
 *   export $(cat .env | xargs) && node bin/exportTrainingData.js
 *   node bin/exportTrainingData.js --out data/training_set.json --min-completeness 0.6
 */

'use strict';

const path = require('path');
const fs   = require('fs');
const { getClient }          = require('../lib/supabaseClient');
const { buildFeatureVector, MIN_COMPLETENESS } = require('../features');

// ── CLI flags ────────────────────────────────────────────────────────────────

const args    = process.argv.slice(2);
const flag    = (name, fallback) => {
  const idx = args.indexOf(name);
  return idx !== -1 && args[idx + 1] ? args[idx + 1] : fallback;
};

const OUT_PATH         = path.resolve(flag('--out', path.join(__dirname, '..', 'data', 'training_set.json')));
const MIN_COMPLETENESS_ARG = parseFloat(flag('--min-completeness', String(MIN_COMPLETENESS)));
const BATCH_SIZE       = 50; // matches fetched per iteration to avoid timeout

// ── Label encoding ───────────────────────────────────────────────────────────

/** @type {Record<string, number>} */
const OUTCOME_LABEL = { home: 0, draw: 1, away: 2 };

// ── Main ─────────────────────────────────────────────────────────────────────

async function run() {
  const supabase = getClient();

  console.log('[export] Querying settled value signals to derive match outcomes…');

  // Step 1: Find the true outcome for every settled match.
  //
  // We select the most recently detected WINNING h2h signal per match.
  // A 'win' result means: this outcome (home/draw/away) was the actual result.
  // We filter to h2h outcomes only to exclude over/under/btts outcomes that
  // cannot be used as a 3-way 1X2 classification label.
  //
  // Note on selection bias: we only have labels for matches where our engine
  // happened to fire a value signal. This under-represents draws and away wins
  // (which the engine historically flags less often). For a fully unbiased
  // dataset, use a separate scores feed.
  const { data: winRows, error: winErr } = await supabase
    .from('value_signals')
    .select(`
      match_id,
      outcome,
      detected_at,
      match:matches (
        id,
        kickoff_at,
        home_team_id,
        away_team_id,
        is_neutral,
        league:leagues ( name )
      )
    `)
    .eq('result', 'win')
    .in('outcome', ['home', 'draw', 'away'])
    .order('detected_at', { ascending: false });

  if (winErr) {
    console.error('[export] Failed to query winning signals:', winErr.message);
    process.exit(1);
  }

  if (!winRows?.length) {
    console.warn('[export] No settled winning signals found — cannot build training set.');
    console.warn('         Ensure fetchResults.js has been run to settle historical signals.');
    process.exit(0);
  }

  // Step 2: Deduplicate to one label per match_id.
  //
  // Because we ordered DESC by detected_at, the first occurrence per match_id
  // is the most recently detected winning signal.  Two winning h2h signals for
  // the same match_id (e.g., home and... wait, only one outcome can win) cannot
  // happen for 1X2 — safe to just take the first.
  /** @type {Map<string, { outcome: string; match: object }>} */
  const labelByMatch = new Map();
  for (const row of winRows) {
    if (!labelByMatch.has(row.match_id)) {
      labelByMatch.set(row.match_id, { outcome: row.outcome, match: row.match });
    }
  }

  console.log(`[export] ${labelByMatch.size} unique settled matches with 1X2 labels.`);

  // Step 3: Build feature vectors.
  //
  // We process in batches of BATCH_SIZE to limit concurrent DB sub-queries.
  const entries    = [...labelByMatch.entries()];
  const trainingRows = [];
  let   skippedLow   = 0;
  let   skippedNull  = 0;

  for (let start = 0; start < entries.length; start += BATCH_SIZE) {
    const batch = entries.slice(start, start + BATCH_SIZE);

    const batchResults = await Promise.all(
      batch.map(async ([matchId, { outcome, match }]) => {
        if (!match?.home_team_id || !match?.away_team_id) return null;

        let fv;
        try {
          fv = await buildFeatureVector(supabase, match);
        } catch (err) {
          console.warn(`  [export] buildFeatureVector error match=${matchId}: ${err.message}`);
          return null;
        }

        if (!fv) return null;

        if (fv.completeness < MIN_COMPLETENESS_ARG) {
          return { skip: 'low_completeness' };
        }

        const label = OUTCOME_LABEL[outcome];
        if (label === undefined) return null;

        return {
          match_id:     matchId,
          kickoff_at:   match.kickoff_at,
          label,                         // 0=home, 1=draw, 2=away
          outcome,                       // human-readable, for audit
          features:     fv.features,     // 22-element Float64 array
          completeness: fv.completeness,
        };
      }),
    );

    for (const r of batchResults) {
      if (!r) { skippedNull++; continue; }
      if (r.skip === 'low_completeness') { skippedLow++; continue; }
      trainingRows.push(r);
    }

    process.stdout.write(
      `\r[export] ${start + batch.length}/${entries.length} processed — ` +
      `${trainingRows.length} kept, ${skippedLow} low-completeness, ${skippedNull} null`,
    );
  }

  console.log('\n');

  if (!trainingRows.length) {
    console.error('[export] No usable training rows — all matches failed completeness check.');
    process.exit(1);
  }

  // Step 4: Write output.
  //
  // Format is a JSON array so ml/train_xgboost.py can `json.load()` it directly.
  // Each element: { match_id, kickoff_at, label, outcome, features, completeness }
  // The Python script uses `label` (int) and `features` (22-element list).
  fs.mkdirSync(path.dirname(OUT_PATH), { recursive: true });
  fs.writeFileSync(OUT_PATH, JSON.stringify(trainingRows, null, 2));

  // Summary
  const labelCounts = { 0: 0, 1: 0, 2: 0 };
  for (const r of trainingRows) labelCounts[r.label]++;
  const avgComp = (trainingRows.reduce((s, r) => s + r.completeness, 0) / trainingRows.length * 100).toFixed(1);

  console.log(`[export] ✓ Training set written: ${OUT_PATH}`);
  console.log(`[export]   Rows  : ${trainingRows.length}`);
  console.log(`[export]   Labels: Home=${labelCounts[0]}  Draw=${labelCounts[1]}  Away=${labelCounts[2]}`);
  console.log(`[export]   Avg completeness : ${avgComp}%`);
  console.log(`[export]   Skipped (low data): ${skippedLow}`);
  console.log(`[export]   Skipped (null fv) : ${skippedNull}`);
  console.log(`[export]`);
  console.log(`[export] Next step:`);
  console.log(`[export]   cd ml && pip install xgboost onnxmltools skl2onnx scikit-learn && python train_xgboost.py`);
}

run().catch(err => {
  console.error('[export] fatal:', err.message);
  process.exit(1);
});
