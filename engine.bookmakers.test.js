// ONE bookmaker identity. See lib/bookmakers.js for what two cost.
const assert = require('assert');
const fs = require('fs');
const { bookmakerKey, bookmakerLabel, BOOKMAKER_LABEL } = require('./lib/bookmakers');

let passed = 0;
function test(n, f) {
  try { f(); passed++; console.log(`  ✓ ${n}`); }
  catch (e) { console.error(`  ✗ ${n}: ${e.message}`); process.exitCode = 1; }
}

// Every pair measured in production on 22 Aug 2026, both forms in one column.
const COLLISIONS = [
  ['Bet365', 'bet365'], ['SBO', 'sbo'], ['Unibet', 'unibet_uk'],
  ['William Hill', 'williamhill'], ['Betfair SB', 'betfair_sb_uk'],
  ['Betfair Exch', 'betfair_ex_uk'], ['MarathonBet', 'marathonbet'],
  ['BetVictor', 'betvictor'], ['Betano', 'betano'], ['Pinnacle', 'pinnacle'],
  ['1xBet', '1xbet'], ['Paddy Power', 'paddypower'], ['Sky Bet', 'skybet'],
  ['Coral', 'coral'],
  // NOT ['888sport','sport888'] and NOT ['Betano','betano_uk']: those are two
  // VENDOR keys for one operator, deliberately kept apart. See lib/bookmakers.
];

test('both stored forms of a book resolve to ONE key', () => {
  for (const [display, key] of COLLISIONS) {
    assert.strictEqual(bookmakerKey(display), bookmakerKey(key),
      `${display} and ${key} must be the same book`);
  }
});

test('bookmakerKey is IDEMPOTENT — safe on the read path too', () => {
  // Both forms are still in the tables, so this runs on values that are
  // already canonical. Applying it twice must not change the answer.
  for (const [display, key] of COLLISIONS) {
    for (const v of [display, key]) {
      assert.strictEqual(bookmakerKey(bookmakerKey(v)), bookmakerKey(v), v);
    }
  }
  for (const k of Object.keys(BOOKMAKER_LABEL)) assert.strictEqual(bookmakerKey(k), k, k);
});

test('a label round-trips back to its own key', () => {
  for (const key of Object.keys(BOOKMAKER_LABEL)) {
    assert.strictEqual(bookmakerKey(bookmakerLabel(key)), key,
      `${key} -> ${bookmakerLabel(key)} -> ${bookmakerKey(bookmakerLabel(key))}`);
  }
});

test('it FAILS OPEN — an unmet book keeps an identity', () => {
  // Returning null would leave a member's stored bet with no bookmaker.
  assert.strictEqual(bookmakerKey('Some New Book'), 'somenewbook');
  assert.strictEqual(bookmakerLabel('Some New Book'), 'somenewbook');
  assert.strictEqual(bookmakerKey(null), null);
  assert.strictEqual(bookmakerKey('   '), null);
});

test('NO WRITER MAY FORMAT A NAME — the ratchet', () => {
  // formatBookName was a presentation function called while BUILDING a row.
  // That is what persisted `Bet365` into a column of keys. A writer may call
  // bookmakerKey; it may never call bookmakerLabel.
  for (const f of ['computeValues.js', 'computeApiValues.js', 'ingestOdds.js',
                   'ingestOddsApi.js', 'computeInplay.js']) {
    if (!fs.existsSync(f)) continue;
    const src = fs.readFileSync(f, 'utf8');
    assert.ok(!/function formatBookName/.test(src),
      `${f} declares formatBookName — the write-layer label is what caused this`);
    assert.ok(!/bookmakerLabel\s*\(/.test(src),
      `${f} calls bookmakerLabel — a writer stores keys, the UI makes labels`);
  }
});

test('the label map has no two keys sharing a label by accident', () => {
  // Betano/betano_uk and unibet variants deliberately share a label; assert the
  // set of EXCEPTIONS is closed so a new collision has to be declared.
  const seen = new Map();
  const allowed = new Set();   // no two keys may share a label at all
  for (const [key, label] of Object.entries(BOOKMAKER_LABEL)) {
    if (seen.has(label) && !allowed.has(label)) {
      assert.fail(`${seen.get(label)} and ${key} both label as "${label}"`);
    }
    seen.set(label, key);
  }
});

console.log(`\nbookmaker identity tests: ${passed} passed`);
