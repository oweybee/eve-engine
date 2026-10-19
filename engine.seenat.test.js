'use strict';
// The board's price age is when a quote was last SEEN, not when it last MOVED.
const assert = require('assert');
const { seenAt, computeConsensus } = require('./computeValues');

const moved = '2026-10-19T08:00:00.000Z';
const seen = '2026-10-19T12:55:00.000Z';
const row = { bookmaker: 'pinnacle', home_odds: 2.1, draw_odds: 3.4, away_odds: 3.6, fetched_at: moved };
const conf = (o) => new Map([['pinnacle', { confirmed_at: seen, home_odds: '2.10', draw_odds: '3.40', away_odds: '3.60', ...o }]]);

assert.strictEqual(seenAt(row, null), moved, 'no confirmation: move time');
assert.strictEqual(seenAt(row, conf()), seen, 'same price confirmed later: confirmation time');
assert.strictEqual(seenAt(row, conf({ home_odds: '2.20' })), moved, 'a different confirmed price says nothing about this row');
assert.strictEqual(seenAt(row, conf({ confirmed_at: '2026-10-19T07:00:00.000Z' })), moved, 'never earlier than the move');
assert.strictEqual(seenAt({ ...row, bookmaker: 'bet365' }, conf()), moved, 'another book\'s confirmation does not count');
assert.strictEqual(computeConsensus([]), null);
console.log('engine.seenat.test.js: ok');
