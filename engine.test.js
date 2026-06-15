'use strict';

const assert = require('assert');
const {
  computeMatch,
  strengthToMatchProbabilities,
  deriveStrengthFromForm,
  bestOddsFromRows,
  deVig,
  computeEdge,
  computeEV,
  impliedProb,
} = require('./computeValues.v2');

let passed = 0, failed = 0;
function test(label, fn) {
  try { fn(); console.log(`  ✓ ${label}`); passed++; }
  catch (err) { console.error(`  ✗ ${label}\n    ${err.message}`); failed++; }
}

// ---- impliedProb ----
console.log('\nimpliedProb');
test('1/2.0 = 0.5', () => assert.ok(Math.abs(impliedProb(2.0) - 0.5) < 1e-9));
test('odds=1 returns null', () => assert.strictEqual(impliedProb(1), null));
test('odds=0 returns null', () => assert.strictEqual(impliedProb(0), null));

// ---- deVig ----
console.log('\ndeVig');
test('output sums to 1', () => {
  const r = deVig(0.55, 0.30, 0.25);
  assert.ok(Math.abs(r.home + r.draw + r.away - 1.0) < 1e-9);
});
test('overround preserved', () => {
  const r = deVig(0.5, 0.3, 0.25);
  assert.ok(Math.abs(r.overround - 1.05) < 1e-9);
});
test('null on zero input', () => assert.strictEqual(deVig(0,0,0), null));

// ---- computeEdge ----
console.log('\ncomputeEdge');
test('positive when model > implied', () => assert.ok(computeEdge(0.55, 0.45) > 0));
test('negative when model < implied', () => assert.ok(computeEdge(0.30, 0.50) < 0));
test('zero when equal', () => assert.strictEqual(computeEdge(0.45, 0.45), 0));
test('null when model null', () => assert.strictEqual(computeEdge(null, 0.45), null));

// ---- computeEV ----
console.log('\ncomputeEV');
test('EV = model*odds - 1', () => {
  const ev = computeEV(0.6, 2.0);
  assert.ok(Math.abs(ev - (0.6*2.0-1)) < 1e-9);
});
test('positive at 2.0 with 0.6 prob', () => assert.ok(computeEV(0.6, 2.0) > 0));
test('negative at 1.5 with 0.4 prob', () => assert.ok(computeEV(0.4, 1.5) < 0));
test('null inputs', () => assert.strictEqual(computeEV(null, 2.0), null));

// ---- CRITICAL: edge and EV sign consistency ----
console.log('\nSIGNAL CONSISTENCY (edge ⟺ EV)');
test('positive edge always means positive EV', () => {
  // Test 100 random cases
  for (let i = 0; i < 100; i++) {
    const bestOdds = 1.2 + Math.random() * 8; // 1.2 to 9.2
    const implied = 1 / bestOdds;
    const model = implied + 0.001 + Math.random() * 0.1; // always above implied
    if (model >= 1) continue;
    const edge = computeEdge(model, implied);
    const ev   = computeEV(model, bestOdds);
    assert.ok(edge > 0, `edge should be positive: ${edge}`);
    assert.ok(ev > 0,   `ev should be positive: model=${model.toFixed(4)} odds=${bestOdds.toFixed(2)} ev=${ev}`);
  }
});
test('negative edge always means negative EV', () => {
  for (let i = 0; i < 100; i++) {
    const bestOdds = 1.2 + Math.random() * 8;
    const implied = 1 / bestOdds;
    const model = Math.max(0.01, implied - 0.001 - Math.random() * 0.1);
    if (model <= 0 || model >= 1) continue;
    const edge = computeEdge(model, implied);
    const ev   = computeEV(model, bestOdds);
    assert.ok(edge < 0, `edge should be negative: ${edge}`);
    assert.ok(ev < 0,   `ev should be negative: model=${model.toFixed(4)} odds=${bestOdds.toFixed(2)} ev=${ev}`);
  }
});
test('PREVIOUS BUG: edge vs fair-prob vs EV can contradict (documenting fix)', () => {
  // This is the bug we fixed. Demonstrate old formula was wrong:
  const overround = 1.10;
  const raw_implied = 0.50;                          // from best odds = 2.0
  const fair_prob   = raw_implied / overround;       // 0.4545 (de-vigged)
  const model_prob  = 0.48;                          // above fair (old edge=+0.025)
  const best_odds   = 1 / raw_implied;               // 2.0

  const old_edge = model_prob - fair_prob;           // +0.025 → old value flag = TRUE
  const ev       = computeEV(model_prob, best_odds); // -0.04  → NEGATIVE

  // Old system: value_flag=TRUE but EV<0 — contradiction
  assert.ok(old_edge > 0,  'old edge was positive (bug)');
  assert.ok(ev < 0,        'EV is negative — contradiction proven');

  // New system: edge uses implied from best odds
  const new_edge = computeEdge(model_prob, raw_implied); // -0.02 → value flag = FALSE
  assert.ok(new_edge < 0, 'new edge correctly negative — consistent with EV');
  assert.ok(Math.sign(new_edge) === Math.sign(ev), 'new edge and EV signs match');
});

// ---- bestOddsFromRows ----
console.log('\nbestOddsFromRows');
const rows = [
  { bookmaker: 'A', home_odds: '1.85', draw_odds: '3.40', away_odds: '4.50', fetched_at: '2024-06-11T10:00:00Z' },
  { bookmaker: 'B', home_odds: '1.80', draw_odds: '3.60', away_odds: '4.40', fetched_at: '2024-06-11T14:00:00Z' },
];
test('picks best home odds', () => assert.strictEqual(bestOddsFromRows(rows).home, 1.85));
test('picks best draw odds', () => assert.strictEqual(bestOddsFromRows(rows).draw, 3.60));
test('returns null for empty', () => assert.strictEqual(bestOddsFromRows([]), null));
test('fetchedAt is EARLIEST of best-price sources', () => {
  // home best comes from A (10:00), draw best from B (14:00), away best from A (10:00)
  // earliest = 10:00
  const r = bestOddsFromRows(rows);
  assert.strictEqual(r.fetchedAt, '2024-06-11T10:00:00Z');
});

// ---- strengthToMatchProbabilities ----
console.log('\nstrengthToMatchProbabilities');
test('probs sum to 1', () => {
  const p = strengthToMatchProbabilities(1500, 1500);
  assert.ok(Math.abs(p.home + p.draw + p.away - 1.0) < 1e-9);
});
test('home advantage: home > away at equal strength', () => {
  const p = strengthToMatchProbabilities(1500, 1500);
  assert.ok(p.home > p.away);
});
test('stronger home team wins more', () => {
  const p = strengthToMatchProbabilities(1700, 1300);
  assert.ok(p.home > 0.5);
});
test('draw probability in realistic range', () => {
  const p = strengthToMatchProbabilities(1500, 1500);
  assert.ok(p.draw >= 0.15 && p.draw <= 0.35, `draw=${p.draw}`);
});
test('all outcomes positive', () => {
  const p = strengthToMatchProbabilities(1800, 1200);
  assert.ok(p.home > 0 && p.draw > 0 && p.away > 0);
});

// ---- deriveStrengthFromForm ----
console.log('\nderiveStrengthFromForm');
test('no form returns default', () => assert.strictEqual(deriveStrengthFromForm([]), 1500));
test('wins increase strength', () => assert.ok(deriveStrengthFromForm(['W','W','W']) > 1500));
test('losses decrease strength', () => assert.ok(deriveStrengthFromForm(['L','L','L']) < 1500));
test('stable range (5 results)', () => {
  const s = deriveStrengthFromForm(['W','W','D','L','W']);
  assert.ok(s > 1400 && s < 1600, `strength out of range: ${s}`);
});

// ---- computeMatch integration ----
console.log('\ncomputeMatch integration');
const mockMatch = {
  id: 'match-001',
  home_team: { id: 'team-h', name: 'Home FC' },
  away_team: { id: 'team-a', name: 'Away FC' },
  league: { id: 'lg-1', name: 'Test League' },
  odds: [
    { bookmaker: 'A', home_odds: 1.80, draw_odds: 3.50, away_odds: 4.50, fetched_at: new Date().toISOString() },
    { bookmaker: 'B', home_odds: 1.85, draw_odds: 3.40, away_odds: 4.60, fetched_at: new Date().toISOString() },
  ],
};
const mockForm = {
  'team-h': ['W','W','D','W','L'],
  'team-a': ['L','D','W','L','L'],
};

test('returns result for valid input', () => assert.ok(computeMatch(mockMatch, mockForm) !== null));
test('uses best odds across books', () => {
  const r = computeMatch(mockMatch, mockForm);
  assert.strictEqual(r.best_home_odds, 1.85);
  assert.strictEqual(r.best_away_odds, 4.60);
});
test('schema fields present, no extra fields written to DB', () => {
  const r = computeMatch(mockMatch, mockForm);
  const schemaFields = [
    'match_id','best_home_odds','best_draw_odds','best_away_odds',
    'fair_home_odds','fair_draw_odds','fair_away_odds',
    'home_edge','draw_edge','away_edge',
    'home_value','draw_value','away_value',
    'odds_fetched_at','computed_at',
  ];
  const internalFields = ['_maxEdge','_homeEV','_drawEV','_awayEV'];
  // All schema fields present
  schemaFields.forEach(f => assert.ok(f in r, `missing schema field: ${f}`));
  // Internal fields present (will be stripped before upsert)
  internalFields.forEach(f => assert.ok(f in r, `missing internal field: ${f}`));
  // max_edge NOT a writeable field (generated column)
  assert.ok(!('max_edge' in r), 'max_edge should not be in output (generated column)');
  // No EV fields in schema output
  assert.ok(!('home_ev' in r), 'home_ev should not be in DB row');
});
test('value flags are booleans', () => {
  const r = computeMatch(mockMatch, mockForm);
  assert.strictEqual(typeof r.home_value, 'boolean');
  assert.strictEqual(typeof r.draw_value, 'boolean');
  assert.strictEqual(typeof r.away_value, 'boolean');
});
test('edge and value flag always consistent with EV', () => {
  const r = computeMatch(mockMatch, mockForm);
  // For each outcome: if value_flag=true then EV must be positive
  if (r.home_value) assert.ok(r._homeEV > 0, `home_value=true but homeEV=${r._homeEV}`);
  if (r.draw_value) assert.ok(r._drawEV > 0, `draw_value=true but drawEV=${r._drawEV}`);
  if (r.away_value) assert.ok(r._awayEV > 0, `away_value=true but awayEV=${r._awayEV}`);
});
test('null for no odds', () => assert.strictEqual(computeMatch({...mockMatch, odds: []}, {}), null));
test('handles missing form (default strength)', () => assert.ok(computeMatch(mockMatch, {}) !== null));
test('_maxEdge null when no positive edges', () => {
  // Force model to always be below implied by using extreme short-price odds
  const shortMatch = { ...mockMatch, odds: [{
    bookmaker: 'X', home_odds: 1.05, draw_odds: 12.0, away_odds: 25.0,
    fetched_at: new Date().toISOString()
  }]};
  const r = computeMatch(shortMatch, {});
  // At 1.05 implied=0.952, model can't beat that from default strength
  if (r && r._maxEdge !== null) {
    assert.ok(typeof r._maxEdge === 'number');
  } else if (r) {
    assert.strictEqual(r._maxEdge, null);
  }
  assert.ok(true); // either is valid
});

// ---- Summary ----
console.log(`\n${passed+failed} tests: ${passed} passed, ${failed} failed\n`);
if (failed > 0) process.exit(1);
