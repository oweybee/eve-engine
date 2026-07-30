/**
 * engine.backfill.test.js — whole-season fixture backfill.
 * Run: node engine.backfill.test.js
 *
 * Covers the pure logic: season-year boundary, result derivation, and the
 * league-day-per-month count the Odds API pacer divides its pool against.
 */
'use strict';
const assert = require('assert');
const { currentSeasonYear, outcomeOf, leagueDaysByMonth, fetchSeason,
        FINISHED } = require('./backfillSeasonFixtures');

let passed = 0;
function test(n, f) {
  try { f(); passed++; console.log(`  ✓ ${n}`); }
  catch (e) { console.error(`  ✗ ${n}: ${e.message}`); process.exitCode = 1; }
}

// ── season year ─────────────────────────────────────────────────────────────
// API-Football labels a season by its START year, so 2026/27 is season=2026 all
// the way through to next June. Getting this wrong silently fetches the WRONG
// season and the pacer plans against last year's calendar.

test('July flips to the new season', () => {
  assert.strictEqual(currentSeasonYear(new Date('2026-07-01T00:00:00Z')), 2026);
  assert.strictEqual(currentSeasonYear(new Date('2026-06-30T23:59:59Z')), 2025);
});

test('spring still belongs to the season that started last autumn', () => {
  assert.strictEqual(currentSeasonYear(new Date('2027-02-14T12:00:00Z')), 2026);
  assert.strictEqual(currentSeasonYear(new Date('2027-05-31T12:00:00Z')), 2026);
});

test('deep midwinter — year rollover does not advance the season', () => {
  assert.strictEqual(currentSeasonYear(new Date('2026-12-31T23:00:00Z')), 2026);
  assert.strictEqual(currentSeasonYear(new Date('2027-01-01T01:00:00Z')), 2026);
});

// ── result derivation ───────────────────────────────────────────────────────
// The schema forbids status='completed' without goals, so outcomeOf must refuse
// anything it can't score — a null here is a skipped row, not a bad write.

const fx = (short, h, a) => ({ fixture: { id: 1, status: { short } }, goals: { home: h, away: a } });

test('finished fixtures score correctly', () => {
  assert.strictEqual(outcomeOf(fx('FT', 2, 1)), 'home');
  assert.strictEqual(outcomeOf(fx('FT', 0, 3)), 'away');
  assert.strictEqual(outcomeOf(fx('FT', 1, 1)), 'draw');
  assert.strictEqual(outcomeOf(fx('FT', 0, 0)), 'draw');
});

test('extra time and penalties count as finished', () => {
  assert.strictEqual(outcomeOf(fx('AET', 2, 1)), 'home');
  assert.strictEqual(outcomeOf(fx('PEN', 1, 1)), 'draw');   // 90+ET draw; shootout is separate
  assert.ok(FINISHED.has('FT') && FINISHED.has('AET') && FINISHED.has('PEN'));
});

test('unplayed and in-progress fixtures yield no result', () => {
  assert.strictEqual(outcomeOf(fx('NS', null, null)), null);
  assert.strictEqual(outcomeOf(fx('1H', 1, 0)), null);
  assert.strictEqual(outcomeOf(fx('HT', 1, 0)), null);
  assert.strictEqual(outcomeOf(fx('PST', null, null)), null);   // postponed
  assert.strictEqual(outcomeOf(fx('CANC', null, null)), null);
});

test('FT without goals is refused — the schema check would reject it', () => {
  assert.strictEqual(outcomeOf(fx('FT', null, null)), null);
  assert.strictEqual(outcomeOf(fx('FT', 2, null)), null);
  assert.strictEqual(outcomeOf(fx('FT', null, 2)), null);
});

test('malformed payloads do not throw', () => {
  assert.strictEqual(outcomeOf(undefined), null);
  assert.strictEqual(outcomeOf({}), null);
  assert.strictEqual(outcomeOf({ fixture: {} }), null);
});

// ── league-days per month ───────────────────────────────────────────────────
// This is the billing unit: The Odds API charges per LEAGUE request, so ten
// fixtures in one league on one day cost the same as one. Counting fixtures
// instead of league-days would overstate the month's cost several-fold.

const at = (leagueId, iso) => ({ fixture: { id: Math.random(), date: iso },
                                 league: { id: leagueId } });

test('a whole matchday in one league is ONE league-day', () => {
  const m = leagueDaysByMonth([
    at(39, '2026-08-15T14:00:00+00:00'),
    at(39, '2026-08-15T16:30:00+00:00'),
    at(39, '2026-08-15T19:00:00+00:00'),
  ]);
  assert.strictEqual(m.get('2026-08'), 1, 'same league, same day → 1');
});

test('different leagues on the same day count separately', () => {
  const m = leagueDaysByMonth([
    at(39, '2026-08-15T14:00:00+00:00'),
    at(140, '2026-08-15T20:00:00+00:00'),
    at(78, '2026-08-15T17:30:00+00:00'),
  ]);
  assert.strictEqual(m.get('2026-08'), 3);
});

test('same league across days counts per day, and splits by month', () => {
  const m = leagueDaysByMonth([
    at(39, '2026-08-29T14:00:00+00:00'),
    at(39, '2026-08-30T14:00:00+00:00'),
    at(39, '2026-09-12T14:00:00+00:00'),
    at(39, '2026-09-12T16:30:00+00:00'),   // dedups against the line above
  ]);
  assert.strictEqual(m.get('2026-08'), 2);
  assert.strictEqual(m.get('2026-09'), 1);
});

test('falls back to the tagged league when the payload omits league.id', () => {
  // upsertMatches receives fixtures tagged with _league; the count must work on
  // either shape so it can run before or after tagging.
  const m = leagueDaysByMonth([
    { fixture: { id: 7, date: '2026-08-15T14:00:00+00:00' }, _league: { id: 39 } },
    { fixture: { id: 8, date: '2026-08-15T16:00:00+00:00' }, _league: { id: 39 } },
  ]);
  assert.strictEqual(m.get('2026-08'), 1);
});

test('fixtures missing a date or league are skipped, not counted as one bucket', () => {
  const m = leagueDaysByMonth([
    at(39, '2026-08-15T14:00:00+00:00'),
    { fixture: { id: 9, date: null }, league: { id: 39 } },
    { fixture: { id: 10, date: '2026-08-16T14:00:00+00:00' }, league: {} },
    {},
  ]);
  assert.strictEqual(m.get('2026-08'), 1);
  assert.strictEqual(m.size, 1);
});

test('empty input yields an empty map, not a crash', () => {
  assert.strictEqual(leagueDaysByMonth([]).size, 0);
});

test('a realistic month is far cheaper than a per-fixture count implies', () => {
  // 40 leagues × 4 match-days each in a month, 6 fixtures per league-day.
  const fixtures = [];
  for (let league = 1; league <= 40; league++) {
    for (const day of ['05', '12', '19', '26']) {
      for (let g = 0; g < 6; g++) {
        fixtures.push(at(league, `2026-09-${day}T1${g}:00:00+00:00`));
      }
    }
  }
  const m = leagueDaysByMonth(fixtures);
  assert.strictEqual(fixtures.length, 960);
  assert.strictEqual(m.get('2026-09'), 160, '40 leagues × 4 days');
  // 6x cheaper than paying per fixture — the whole reason tiering 40 leagues is
  // affordable at all.
  assert.ok(m.get('2026-09') * 6 === fixtures.length);
});

// ── paging + the HTTP-200 error envelope ────────────────────────────────────
// A season loaded short is the failure this whole script exists to prevent: the
// pacer would divide the monthly pool by a calendar missing matchdays and
// quietly overspend. So paging must be followed, and API-Football's habit of
// reporting errors with HTTP 200 must not read as "no fixtures".

function asyncTest(n, f) {
  return f().then(() => { passed++; console.log(`  ✓ ${n}`); })
            .catch(e => { console.error(`  ✗ ${n}: ${e.message}`); process.exitCode = 1; });
}

const page = (current, total, items) => ({ paging: { current, total }, response: items, errors: [] });

(async () => {
  await asyncTest('single-page season costs one call', async () => {
    const calls = [];
    const got = await fetchSeason(39, 2026, async p => {
      calls.push(p);
      return page(1, 1, [at(39, '2026-08-15T14:00:00+00:00')]);
    });
    assert.strictEqual(got.calls, 1);
    assert.strictEqual(got.pages, 1);
    assert.strictEqual(got.fixtures.length, 1);
    assert.ok(calls[0].includes('league=39') && calls[0].includes('season=2026'));
  });

  await asyncTest('a paged season is followed to the end, not truncated', async () => {
    const seen = [];
    const got = await fetchSeason(39, 2026, async p => {
      const n = parseInt(p.match(/page=(\d+)/)[1], 10);
      seen.push(n);
      return page(n, 3, [at(39, `2026-0${n}-15T14:00:00+00:00`),
                         at(39, `2026-0${n}-16T14:00:00+00:00`)]);
    });
    assert.deepStrictEqual(seen, [1, 2, 3], 'must request every page');
    assert.strictEqual(got.fixtures.length, 6, 'all pages accumulated');
    assert.strictEqual(got.calls, 3);
  });

  await asyncTest('missing paging envelope is treated as a single page', async () => {
    const got = await fetchSeason(39, 2026, async () => ({ response: [at(39, '2026-08-15T14:00:00+00:00')] }));
    assert.strictEqual(got.calls, 1);
    assert.strictEqual(got.fixtures.length, 1);
  });

  await asyncTest('HTTP 200 + errors throws instead of looking like an empty season', async () => {
    // This is the plan-gated-season case: API-Football answers 200 with an empty
    // response and an error string. Silently treating it as "league didn't run"
    // would hide a subscription limit behind a plausible-looking result.
    await assert.rejects(
      () => fetchSeason(39, 2015, async () => ({
        paging: { current: 1, total: 1 }, response: [],
        errors: { plan: 'Free plans do not have access to this season.' },
      })),
      /Free plans do not have access/);
  });

  await asyncTest('errors as an array is handled too (the API uses both shapes)', async () => {
    await assert.rejects(
      () => fetchSeason(39, 2026, async () => ({ response: [], errors: ['Bad league id'] })),
      /Bad league id/);
  });

  console.log(`\n${passed} backfill test(s) passed`);
})();
