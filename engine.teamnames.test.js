/**
 * engine.teamnames.test.js — one club, one key.
 * Run: node engine.teamnames.test.js
 *
 * The cases here are drawn from the real production name lists (164 corpus
 * names, 134 feed names, 2026-08-05), including the false match an earlier
 * version of this matcher produced. The asymmetry that governs every one of
 * them: a MISSED mapping leaves a club short of history and it stays silent,
 * which is correct. A FALSE mapping attributes one club's corners to another
 * and every number downstream inherits it invisibly.
 */
'use strict';
const assert = require('assert');
const { normalize, tokens, canonicalKey, similarity, bestMatch,
        buildCanonicalMap, isPlaceholder } = require('./lib/teamNames');

let passed = 0;
function test(n, f) {
  try { f(); passed++; console.log(`  ✓ ${n}`); }
  catch (e) { console.error(`  ✗ ${n}: ${e.message}`); process.exitCode = 1; }
}

const fd = n => ({ source: 'football_data', name: n });
const feed = n => ({ source: 'live_feed', name: n });
const resolve = (rows, opts) => {
  const { aliases, unmatched } = buildCanonicalMap(rows, opts);
  const keyOf = new Map(aliases.map(a => [`${a.source}|${a.name}`, a.canonical_key]));
  return { keyOf, aliases, unmatched };
};

// ── normalisation ───────────────────────────────────────────────────────────

test('corporate noise goes, meaning stays', () => {
  assert.strictEqual(normalize('AFC Wimbledon'), 'wimbledon');
  assert.strictEqual(normalize('FC Halifax Town'), 'halifaxtown');
  assert.strictEqual(normalize('1. FC Köln'), 'koln');
  assert.deepStrictEqual(tokens('Havant & Waterlooville'), ['havant', 'and', 'waterlooville']);
  assert.strictEqual(normalize(null), '');
  assert.strictEqual(normalize(''), '');
});

test('NO word is dropped for being generic', () => {
  // The rule an earlier version had — drop united/city/athletic — worked for 15
  // clubs and then merged Oxford with Oxford City. Every meaningful token now
  // survives, and merging is decided later, by the data.
  assert.strictEqual(normalize('Oxford City'), 'oxfordcity');
  assert.strictEqual(normalize('Oxford United'), 'oxfordunited');
  assert.notStrictEqual(normalize('Oxford City'), normalize('Oxford United'));
  assert.strictEqual(normalize('Bristol City'), 'bristolcity');
  assert.strictEqual(normalize('Bristol Rovers'), 'bristolrovers');
});

test('abbreviations resolve through ALIAS, which token rules cannot reach', () => {
  // "Man City" shares no token with "Manchester City" — no prefix rule and no
  // fuzzy score finds it, so it is curated.
  assert.strictEqual(canonicalKey('Man City'), 'manchestercity');
  assert.strictEqual(canonicalKey('Man United'), 'manchesterunited');
  assert.strictEqual(canonicalKey('Man Utd'), 'manchesterunited');
  assert.notStrictEqual(canonicalKey('Man City'), canonicalKey('Man United'));
  assert.strictEqual(canonicalKey("Nott'm Forest"), 'nottinghamforest');
  assert.strictEqual(canonicalKey('Sheffield Weds'), 'sheffieldwednesday');
});

// ── the feed's duplicate clubs — the live defect ────────────────────────────

test('the same club under two feed spellings becomes one club', () => {
  // 17 of these exist in production. Each was two rolling-form windows, and the
  // corners and cards models need 20 matches per team per venue, so halving a
  // club's history is often the difference between a prediction and silence.
  const pairs = [
    ['Leeds', 'Leeds United'], ['Hull', 'Hull City'], ['Derby', 'Derby County'],
    ['Bolton', 'Bolton Wanderers'], ['Wolves', 'Wolverhampton Wanderers'],
    ['Tottenham', 'Tottenham Hotspur'], ['QPR', 'Queens Park Rangers'],
    ['West Brom', 'West Bromwich Albion'], ['Ipswich', 'Ipswich Town'],
  ];
  for (const [short, long] of pairs) {
    const { keyOf } = resolve([feed(short), feed(long)]);
    assert.strictEqual(keyOf.get(`live_feed|${short}`), keyOf.get(`live_feed|${long}`),
      `${short} and ${long} must be one club`);
  }
});

test('a short name folds into the longer one, not the other way round', () => {
  const { keyOf } = resolve([feed('Leeds'), feed('Leeds United')]);
  assert.strictEqual(keyOf.get('live_feed|Leeds'), 'leedsunited');
});

// ── the refusal, which is the whole point ───────────────────────────────────

test('an ambiguous short name is REFUSED, not guessed', () => {
  // The false match an earlier version produced. Oxford United and Oxford City
  // are different clubs; "Oxford" could be short for either.
  const { keyOf, unmatched } = resolve([fd('Oxford'), fd('Oxford City'), feed('Oxford United')]);
  assert.notStrictEqual(keyOf.get('football_data|Oxford'), keyOf.get('football_data|Oxford City'));
  assert.notStrictEqual(keyOf.get('football_data|Oxford'), keyOf.get('live_feed|Oxford United'));
  const reason = unmatched.find(u => u.name === 'Oxford')?.reason ?? '';
  assert.match(reason, /ambiguous/, 'the refusal must be reported, not silent');
});

test('two genuinely different clubs sharing a town never merge', () => {
  const { keyOf } = resolve([
    fd('Bristol City'), fd('Bristol Rvs'), feed('Bristol City'), feed('Bristol Rovers'),
  ]);
  assert.strictEqual(keyOf.get('football_data|Bristol Rvs'), keyOf.get('live_feed|Bristol Rovers'));
  assert.notStrictEqual(keyOf.get('live_feed|Bristol City'), keyOf.get('live_feed|Bristol Rovers'));
});

test('Notts County and Nottingham Forest stay two clubs', () => {
  const { keyOf } = resolve([fd('Notts County'), fd("Nott'm Forest"),
                             feed('Notts County'), feed('Nottingham Forest')]);
  assert.strictEqual(keyOf.get("football_data|Nott'm Forest"), keyOf.get('live_feed|Nottingham Forest'));
  assert.notStrictEqual(keyOf.get('live_feed|Notts County'), keyOf.get('live_feed|Nottingham Forest'));
});

// ── the cross-source join, which is what §2.3 asked for ─────────────────────

test('corpus and feed spellings of one club meet', () => {
  const cases = [
    ['Man City', 'Manchester City'], ['Wolves', 'Wolverhampton Wanderers'],
    ['Newcastle', 'Newcastle United'], ['Sheffield Weds', 'Sheffield Wednesday'],
    ['Peterboro', 'Peterborough'], ['Harrogate', 'Harrogate Town'],
  ];
  for (const [corpus, live] of cases) {
    const { keyOf } = resolve([fd(corpus), feed(live)]);
    assert.strictEqual(keyOf.get(`football_data|${corpus}`), keyOf.get(`live_feed|${live}`),
      `${corpus} must join ${live}`);
  }
});

test('a club only one source knows is reported, not forced onto a neighbour', () => {
  // football-data carries non-league clubs the feed has never covered. That is
  // not a mapping failure and must not be resolved into something else.
  const { keyOf, unmatched } = resolve([fd('Canvey Island'), feed('Arsenal'), feed('Chelsea')]);
  assert.strictEqual(keyOf.get('football_data|Canvey Island'), 'canveyisland');
  assert.ok(unmatched.some(u => u.name === 'Canvey Island'));
});

// ── similarity and the floor ────────────────────────────────────────────────

test('similarity is bounded and symmetric on the ends', () => {
  assert.strictEqual(similarity('arsenal', 'arsenal'), 1);
  assert.strictEqual(similarity('', ''), 1);
  assert.strictEqual(similarity('arsenal', ''), 0);
  assert.strictEqual(similarity(null, 'arsenal'), 0);
  const s = similarity('manchestercity', 'manchesterunited');
  assert.ok(s > 0 && s < 1, 'two real clubs must score between the extremes');
});

test('bestMatch returns null below the floor and reports the near miss', () => {
  const near = bestMatch('Arsenel', ['Arsenal', 'Chelsea'], 0.8);
  assert.strictEqual(near.match, 'Arsenal');
  const miss = bestMatch('Barcelona', ['Arsenal', 'Chelsea'], 0.92);
  assert.strictEqual(miss.match, null);
  assert.ok(miss.score < 0.92, 'the score is returned so the miss can be logged');
});

test('a high floor keeps two real clubs apart', () => {
  // Man City and Man United are 14 and 16 characters sharing a long prefix.
  // At the default floor they must not merge.
  const { keyOf } = resolve([feed('Manchester City'), feed('Manchester United')]);
  assert.notStrictEqual(keyOf.get('live_feed|Manchester City'),
                        keyOf.get('live_feed|Manchester United'));
});

// ── input hygiene ───────────────────────────────────────────────────────────

test('empty and malformed rows are dropped, never keyed', () => {
  const { aliases } = resolve([
    fd(''), fd('   '), { source: '', name: 'Arsenal' }, fd(null), feed('Arsenal'),
  ]);
  assert.strictEqual(aliases.length, 1);
  assert.strictEqual(aliases[0].name, 'Arsenal');
  assert.deepStrictEqual(buildCanonicalMap(null).aliases, []);
  assert.deepStrictEqual(buildCanonicalMap([]).unmatched, []);
});

test('every emitted alias carries its method, so a fuzzy join is auditable', () => {
  const { aliases } = resolve([fd('Man City'), feed('Manchester City'), feed('Leeds'), feed('Leeds United')]);
  for (const a of aliases) {
    assert.ok(['exact', 'prefix', 'fuzzy'].includes(a.method), `bad method ${a.method}`);
    assert.ok(a.canonical_key.length > 0);
  }
});

// ── placeholders, measured: 222 of 1,248 rows in `teams` ────────────────────

test('planDay placeholders are not clubs and are never aliased', () => {
  // 18% of the `teams` table. Each is unique, so aliasing them would mint 222
  // one-match "clubs" — and a fuzzy pass would score team_home_1490361 against
  // team_home_1490362 at 0.94 and merge two unrelated fixtures' histories.
  assert.strictEqual(isPlaceholder('team_home_1490361'), true);
  assert.strictEqual(isPlaceholder('team_away_1565206'), true);
  assert.strictEqual(isPlaceholder('  team_home_1  '), true);
  assert.strictEqual(isPlaceholder('Arsenal'), false);
  assert.strictEqual(isPlaceholder('Team Home United'), false);
  assert.strictEqual(isPlaceholder(null), false);

  const { aliases } = resolve([
    feed('team_home_1490361'), feed('team_away_1490361'), feed('Arsenal'),
  ]);
  assert.strictEqual(aliases.length, 1);
  assert.strictEqual(aliases[0].name, 'Arsenal');
});

// ── the ambiguity refusals that exist in the REAL feed ──────────────────────

test('every ambiguous prefix in production is refused', () => {
  // Measured across all 1,026 real feed names on 2026-08-05. These five are the
  // whole reason the generic-word rule had to go: "Inter" alone is a prefix of
  // four different clubs on three continents, and merging it into whichever
  // sorted first would have attributed Inter Milan's record to Inter Miami.
  const feedNames = [
    'Inter', 'Inter Club d\'Escaldes', 'Inter Miami', 'Inter Milan', 'Inter Turku',
    'Austria', 'Austria Lustenau', 'Austria Vienna',
    'Celta', 'Celta de Vigo II', 'Celta Vigo',
    'Dynamo', 'Dynamo Dresden', 'Dynamo Kyiv',
    'Independiente', 'Independiente del Valle', 'Independiente Rivadavia',
  ];
  const { keyOf, unmatched } = resolve(feedNames.map(feed));
  for (const short of ['Inter', 'Austria', 'Celta', 'Dynamo', 'Independiente']) {
    const k = keyOf.get(`live_feed|${short}`);
    const merged = feedNames.filter(n => n !== short && keyOf.get(`live_feed|${n}`) === k);
    assert.deepStrictEqual(merged, [], `${short} must not merge into ${merged.join(', ')}`);
    assert.match(unmatched.find(u => u.name === short)?.reason ?? '', /ambiguous/,
      `${short} must be reported as ambiguous`);
  }
});

console.log(`\n${passed} test(s) passed`);
