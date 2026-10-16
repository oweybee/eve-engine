'use strict';

/**
 * engine.matchevents.test.js — goals and cards for /results.
 */

const test = require('node:test');
const assert = require('node:assert');
const { shapeFixture, chunk, IDS_PER_CALL } = require('./lib/matchEvents');

const fixture = (status, events) => ({
  fixture: { id: 1234, status: { short: status } },
  teams: { home: { id: 10 }, away: { id: 20 } },
  events,
});

test('a side comes from the fixture team ids, both ways round', () => {
  const s = shapeFixture(fixture('FT', [
    { time: { elapsed: 12, extra: null }, team: { id: 20 }, player: { name: 'A' }, type: 'Goal', detail: 'Normal Goal' },
    { time: { elapsed: 90, extra: 3 }, team: { id: 10 }, player: { name: 'B' }, assist: { name: 'C' }, type: 'Goal', detail: 'Penalty' },
  ]), 'uuid-1');
  assert.strictEqual(s.final, true);
  assert.deepStrictEqual(s.rows.map(r => r.team_side), ['away', 'home']);
  assert.strictEqual(s.rows[1].extra, 3);
  assert.strictEqual(s.rows[1].assist, 'C');
  assert.strictEqual(s.rows[0].match_id, 'uuid-1');
  assert.deepStrictEqual(s.rows.map(r => r.seq), [0, 1]);
});

test('an unknown team is null, never guessed', () => {
  const s = shapeFixture(fixture('FT', [{ time: { elapsed: 5 }, team: { id: 99 }, type: 'Card', detail: 'Yellow Card' }]));
  assert.strictEqual(s.rows[0].team_side, null);
});

test('a fixture not yet final is not marked final', () => {
  assert.strictEqual(shapeFixture(fixture('2H', [])).final, false);
  assert.strictEqual(shapeFixture(fixture('PEN', [])).final, true);
});

test('a missing minute is null, not zero', () => {
  const s = shapeFixture(fixture('FT', [{ time: {}, team: { id: 10 }, type: 'Goal', detail: 'Normal Goal' }]));
  assert.strictEqual(s.rows[0].minute, null);
});

test('a goalless final match still shapes, with no rows', () => {
  const s = shapeFixture(fixture('FT', undefined));
  assert.strictEqual(s.final, true);
  assert.strictEqual(s.rows.length, 0);
});

test('ids are asked 20 at a time', () => {
  assert.strictEqual(IDS_PER_CALL, 20);
  assert.deepStrictEqual(chunk(Array.from({ length: 45 }, (_, i) => i)).map(c => c.length), [20, 20, 5]);
});
