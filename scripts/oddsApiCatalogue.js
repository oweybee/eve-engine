#!/usr/bin/env node
/**
 * scripts/oddsApiCatalogue.js — what does The Odds API actually return?
 *
 * WHY THIS EXISTS. `mapSportKeys` resolved ZERO of our 38 tracked leagues on
 * 22 Aug 2026, so `ingestOddsApi.js` polled nothing and the account had spent
 * 0 of its 100,000 monthly credits since the integration was written. The unit
 * tests pass because they run against RECORDED-SHAPE fixtures authored from the
 * v4 docs — the integration has never met the real feed, which lib/oddsApi.js
 * says in its own header. A fixture built from a guess tests the guess.
 *
 * the-odds-api.com is egress-blocked from the agent environment, so the only
 * place the real shape can be observed is a runner. This prints it.
 *
 * IT COSTS NOTHING. /v4/sports is the free catalogue endpoint — it returns the
 * quota headers without consuming a credit, which is also why it is the right
 * place to read usage from.
 */
'use strict';

const { httpGetJson, mapSportKeys } = require('../lib/oddsApi');

const KEY = process.env.ODDS_API_KEY;

async function main() {
  if (!KEY) { console.log('[catalogue] ODDS_API_KEY not set — nothing to ask'); process.exit(1); }

  const res = await httpGetJson(`/v4/sports/?apiKey=${KEY}&all=true`);
  const h = res.headers ?? {};
  console.log('=== ACCOUNT ===');
  console.log(`x-requests-used      ${h['x-requests-used'] ?? '(absent)'}`);
  console.log(`x-requests-remaining ${h['x-requests-remaining'] ?? '(absent)'}`);
  console.log(`x-requests-last      ${h['x-requests-last'] ?? '(absent)'}`);

  const all = res.json ?? [];
  const soccer = all.filter((s) => String(s.key ?? '').startsWith('soccer'));
  console.log(`\n=== CATALOGUE === ${all.length} sport(s), ${soccer.length} soccer`);

  // The two fields every matcher tests, printed verbatim so the next reader can
  // see which one carries the country and which carries the competition.
  const groups = [...new Set(soccer.map((s) => s.group ?? '(null)'))];
  console.log(`distinct \`group\` values across soccer: ${JSON.stringify(groups)}`);
  console.log('\nkey | group | title | description');
  for (const s of soccer) {
    console.log(`${s.key} | ${s.group ?? ''} | ${s.title ?? ''} | ${s.description ?? ''}`);
  }

  const { map, unmatched } = mapSportKeys(all, { includeCups: true });
  console.log(`\n=== OUR MATCHERS === resolved ${Object.keys(map).length}, unmatched ${unmatched.length}`);
  for (const [k, v] of Object.entries(map)) console.log(`  ok       ${k} -> ${v}`);
  if (unmatched.length) console.log(`  MISSING  ${unmatched.join(', ')}`);
}

main().catch((e) => { console.error(`[catalogue] ${e.message}`); process.exit(1); });
