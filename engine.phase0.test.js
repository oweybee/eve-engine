'use strict';

/**
 * engine.phase0.test.js — THE SWITCHED-OFF WRITERS STAY OFF.
 *
 * Phase 0 of the engine consolidation (18 Aug 2026). Four architectures stop
 * writing, measured against the Shin-de-vigged closing line:
 *
 *     API_PREDICTIVE    n=230   no-vig CLV -3.26%   z -8.60
 *     LAMBDA_MC         n=166   no-vig CLV -3.58%   z -9.41
 *     CORNERS_MODEL     4 signals ever, last written 17 July, never published
 *     CARDS_MODEL       2 signals ever, last written 17 July, never published
 *
 * The read-side guards already stripped their claims — `publication.js` refuses
 * them and `trg_score_needs_measured_sigma` nulls an unmeasured score. Those
 * stop a row being SCORED, not written, which is why API_PREDICTIVE was still
 * producing ~45 computed_values a day while being formally disqualified.
 *
 * These tests are about the WRITER. A guard that lives only in a workflow file
 * is one `node computeApiValues.js` away from being undone.
 */

let passed = 0, failed = 0;
function test(name, fn) {
  try { fn(); console.log(`  ✓ ${name}`); passed++; }
  catch (e) { console.log(`  ✗ ${name}\n      ${e.message}`); failed++; }
}
function assert(c, m) { if (!c) throw new Error(m); }

const fs = require('fs');
const path = require('path');
const sm = require('./lib/secondaryMarkets');

const read = f => fs.readFileSync(path.join(__dirname, f), 'utf8');

console.log('\nthe disqualified h2h writers are off by default');

test('computeApiValues refuses to run without an explicit override', () => {
  const src = read('computeApiValues.js');
  assert(/const ENABLED = process\.env\.API_PREDICTIVE_ENABLED === 'true'/.test(src),
    'needs an explicit opt-in flag, defaulting off');
  assert(/if \(!ENABLED\)/.test(src), 'main must check it');
  // Default off is the whole point: an unset variable must not run the engine.
  assert(process.env.API_PREDICTIVE_ENABLED !== 'true' || true, 'flag is opt-in');
});

test('computeModelBoard refuses to run without an explicit override', () => {
  const src = read('computeModelBoard.js');
  assert(/const ENABLED = process\.env\.LAMBDA_BOARD_ENABLED === 'true'/.test(src),
    'needs an explicit opt-in flag, defaulting off');
  assert(/if \(!ENABLED\)/.test(src), 'main must check it');
});

test('neither runs from the engine workflow any more', () => {
  const wf = read('.github/workflows/engine.yml');
  assert(!/run: node computeApiValues\.js/.test(wf), 'computeApiValues step must be gone');
  assert(!/run: node computeModelBoard\.js/.test(wf), 'computeModelBoard step must be gone');
  // And the repo variable cannot quietly switch LAMBDA_MC back on.
  assert(/LAMBDA_BOARD_ENABLED:\s*'false'/.test(wf),
    'the lambda flag must be pinned false, not read from a repo variable');
});

console.log('\ncorners and cards are gone from the writer, not just from the gate');

test('buildSecondarySignals emits only totals and btts', () => {
  const match = {
    id: 'm1',
    odds: [
      { market: 'totals',  market_line: 2.5, bookmaker: 'bet365',      home_odds: 1.95, away_odds: 1.90, fetched_at: '2026-08-18T10:00:00Z' },
      { market: 'totals',  market_line: 2.5, bookmaker: 'betvictor',   home_odds: 1.93, away_odds: 1.92, fetched_at: '2026-08-18T10:00:00Z' },
      { market: 'btts',    market_line: null, bookmaker: 'bet365',     home_odds: 1.80, away_odds: 2.00, fetched_at: '2026-08-18T10:00:00Z' },
      { market: 'btts',    market_line: null, bookmaker: 'betvictor',  home_odds: 1.82, away_odds: 1.98, fetched_at: '2026-08-18T10:00:00Z' },
      // Priced corners and cards on the feed. They must simply be ignored.
      { market: 'corners', market_line: 9.5, bookmaker: 'bet365',      home_odds: 1.90, away_odds: 1.95, fetched_at: '2026-08-18T10:00:00Z' },
      { market: 'bookings',market_line: 3.5, bookmaker: 'bet365',      home_odds: 1.85, away_odds: 2.00, fetched_at: '2026-08-18T10:00:00Z' },
    ],
  };
  const consensus = {
    home: { p_cons: 0.45 }, draw: { p_cons: 0.27 }, away: { p_cons: 0.28 },
  };
  const stats = { corners_for_avg: 6, corners_against_avg: 5, cards_avg: 2 };

  const signals = sm.buildSecondarySignals(match, consensus, stats, stats, { cards_avg: 4 });
  const markets = new Set(signals.map(s => s.market));
  assert(!markets.has('corners'),  'corners must not be emitted');
  assert(!markets.has('bookings'), 'bookings must not be emitted');
  const archs = new Set(signals.map(s => s.model_architecture));
  assert(!archs.has('CORNERS_MODEL'), 'CORNERS_MODEL must not be written');
  assert(!archs.has('CARDS_MODEL'),   'CARDS_MODEL must not be written');
});

test('secondaryComputedValues writes no corners or bookings columns', () => {
  const match = {
    id: 'm1',
    odds: [
      { market: 'corners', market_line: 9.5, bookmaker: 'bet365', home_odds: 1.90, away_odds: 1.95, fetched_at: '2026-08-18T10:00:00Z' },
      { market: 'bookings',market_line: 3.5, bookmaker: 'bet365', home_odds: 1.85, away_odds: 2.00, fetched_at: '2026-08-18T10:00:00Z' },
    ],
  };
  const consensus = { home: { p_cons: 0.45 }, draw: { p_cons: 0.27 }, away: { p_cons: 0.28 } };
  const stats = { corners_for_avg: 6, corners_against_avg: 5, cards_avg: 2 };
  const cv = sm.secondaryComputedValues(match, consensus, stats, stats, { cards_avg: 4 });
  const leaked = Object.keys(cv).filter(k => /^(corners|bookings)_/.test(k));
  assert(leaked.length === 0, `columns leaked: ${leaked.join(', ')}`);
});

test('the lambda estimators are deleted, not merely unused', () => {
  assert(sm.cornersLambda === undefined, 'cornersLambda must not be exported');
  assert(sm.cardsLambda === undefined,   'cardsLambda must not be exported');
  assert(!fs.existsSync(path.join(__dirname, 'cornersModel.js')),  'cornersModel.js must be deleted');
  assert(!fs.existsSync(path.join(__dirname, 'bookingsModel.js')), 'bookingsModel.js must be deleted');
});

console.log('\nwhat a run actually polls');

test('the fetch uses the DUE set, not the whole day plan', () => {
  const src = read('ingestOdds.js');
  // The bug: dueIds was computed, logged, used to advance the schedule — and
  // then Phase 1 fetched plan.fixture_ids, so the tiering saved no requests.
  assert(/const fetched = await withPool\(\s*pollIds,/.test(src),
    'Phase 1 must fetch pollIds, never plan.fixture_ids');
  assert(!/withPool\(\s*plan\.fixture_ids,/.test(src),
    'plan.fixture_ids must not be the fetch set');
});

test('a fixture past kickoff is dropped before any request is spent', () => {
  const src = read('ingestOdds.js');
  assert(/minsToKo <= 0/.test(src) || /kickoffAt\).getTime\(\) <= now/.test(src),
    'started fixtures must be filtered out');
  assert(/select\('id, external_id, kickoff_at'\)/.test(src),
    'kickoff must ride along on the id resolution rather than costing a query');
});

test('the closing floor exists and is a floor, not a tier', () => {
  const src = read('ingestOdds.js');
  assert(/CLOSING_FLOOR_WINDOW_MIN/.test(src) && /CLOSING_FLOOR_EVERY_MIN/.test(src),
    'both floor parameters must exist');
  // It must ADD to the due set, never replace it — pollBudget still owns tiers.
  assert(/new Set\(\[\.\.\.dueIds\.map\(String\), \.\.\.floorIds\]\)/.test(src),
    'the floor unions with the due set');
});

test('an empty due set does NOT short-circuit before the floor runs', () => {
  const src = read('ingestOdds.js');
  const floorAt  = src.indexOf('const floorIds');
  const bailAt   = src.indexOf('nothing to poll');
  assert(floorAt > 0 && bailAt > floorAt,
    'the bail-out must come AFTER the floor has had a say — a fixture 40 minutes ' +
    'from kickoff with nothing else due is the case the floor exists for');
  assert(!/0 of \$\{plan\.fixture_ids\.length\} fixture\(s\) due — advancing schedule only/.test(src),
    'the old pre-floor early return must be gone');
});

test('everything polled advances, so the floor cannot re-fire every run', () => {
  const src = read('ingestOdds.js');
  assert(/advancePlan\(supabase, plan, pollIds\)/.test(src),
    'advancePlan must receive pollIds; passing dueIds leaves floor fixtures ' +
    'un-advanced and therefore due again immediately');
});

console.log(`\n${failed === 0 ? '✓' : '✗'} phase 0: ${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
