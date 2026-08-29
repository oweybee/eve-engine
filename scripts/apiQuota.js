#!/usr/bin/env node
'use strict';

/**
 * scripts/apiQuota.js — print the stored API-Football quota. Costs no request.
 *
 * It reads `engine_state.api_football_quota`, which the ingest scripts write
 * from headers that ride along on calls they were making anyway. It does NOT
 * call the vendor: /status spends one against the counter it reports.
 *
 * `never recorded` after a real run means the header names in
 * lib/apiFootballQuota are wrong — they are from the v3 docs and have never
 * been checked against a live response, because no key was available where
 * they were written.
 *
 * Usage: npm run api-quota  [--json]
 */

const { getClient } = require('../lib/supabaseClient');
const q = require('../lib/apiFootballQuota');

(async () => {
  const stored = await q.readQuota(getClient());
  if (process.argv.includes('--json')) {
    console.log(JSON.stringify(stored, null, 2));
    return;
  }
  if (!stored) {
    console.log('api-football quota: never recorded — no run has reported headers yet');
    return;
  }
  console.log(q.describeQuota(stored));
  console.log(`  day        ${stored.day}   checked ${stored.checked_at}`);
  if (stored.fraction_left != null) {
    console.log(`  left       ${(stored.fraction_left * 100).toFixed(1)}% of the day's allowance`);
  }
  if (q.isLow(stored)) console.log('  WARNING    the daily allowance is nearly gone');
})().catch(err => { console.error('[quota] FATAL:', err.message); process.exit(1); });
