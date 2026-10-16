'use strict';
// inChunks must survive a chunk far past V8's ~120k spread-argument limit.
const assert = require('assert');
const { inChunks, PAGE_SIZE } = require('./lib/pagedRead');
const N = 300_000;
const rows = Array.from({ length: N }, (_, i) => ({ id: i, match_id: 'm' }));
const build = () => {
  const q = { range(a, b) { return Promise.resolve({ data: rows.slice(a, b + 1), error: null }); } };
  q.order = () => q;
  return q;
};
inChunks(['m'], 'id', 'big', build).then(out => {
  assert.strictEqual(out.length, N);
  assert.strictEqual(out[N - 1].id, N - 1);
  console.log('engine.pagedreadlarge.test.js: ok');
}).catch(e => { console.error(e); process.exit(1); });
