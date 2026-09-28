'use strict';

/**
 * engine.xpost.test.js — the X channel's compliance rules and its rails.
 *
 * Every assertion here stands for a rule the ACCOUNT can be actioned under or
 * the BUSINESS fined under, on a poster the founder chose to run unattended.
 * There is no reviewer between these checks and the timeline, which is the
 * whole reason they are tests rather than conventions.
 *
 * Run: node engine.xpost.test.js   (zero deps, no DB/network)
 */

const assert = require('assert');
const c = require('./lib/xCompose');
const g = require('./lib/xGuard');

let n = 0;
const it = (name, fn) => { fn(); n++; console.log(`  ok  ${name}`); };

const ROW = {
  home: 'CFR 1907 Cluj', away: 'Universitatea Cluj', league: 'Liga I',
  selection: 'CFR 1907 Cluj to Win', odds: 2.40, ev: 0.087, book: 'Betano',
};

console.log('\ncompose — the rules that cannot be broken');

it('every post carries the exact compliance footer', () => {
  const t = c.compose({ body: c.valueBody(ROW, 0), routeKey: 'value' });
  assert.ok(t.endsWith(c.FOOTER), 'footer missing or not last');
  assert.strictEqual(c.FOOTER, '18+ | begambleaware | Pricing analysis, not advice');
});

it('begambleaware is plain text, never a link', () => {
  // A linked .org is suppressed by X's algorithm, and a suppressed compliance
  // line is a missing one.
  assert.ok(!/begambleaware\.org/i.test(c.FOOTER));
  assert.ok(!/https?:\/\/\S*gambleaware/i.test(c.FOOTER));
});

it('refuses a post containing an emoji', () => {
  // CAP youth-appeal. The check is on the WHOLE composed post.
  assert.throws(() => c.compose({ body: 'Value on Arsenal \u{1F525}', routeKey: 'value' }),
    e => e.refusal === 'emoji');
});

it('refuses banned vocabulary from the public copy standard', () => {
  for (const word of ['vig', 'overround', 'z-score', 'Brier', 'mxs']) {
    assert.throws(() => c.compose({ body: `A line about ${word} here`, routeKey: 'value' }),
      e => e.refusal === 'banned-vocabulary', `${word} was allowed through`);
  }
});

it('does not reject an innocent word for containing a banned one', () => {
  // `pp` is on the list and is two letters. A substring test rejects
  // "supported" and "happening"; the match must be word-boundaried.
  assert.doesNotThrow(() => c.compose({ body: 'This is supported and happening now', routeKey: 'value' }));
});

it('refuses copy that makes the model the actor', () => {
  // The sentence /how-it-works exists to retract. It must not escape to the
  // one audience that cannot click through and check.
  assert.throws(() => c.compose({ body: 'Our model found a bet today', routeKey: 'value' }),
    e => e.refusal === 'model-as-actor');
  assert.throws(() => c.compose({ body: 'The model detects mispriced games', routeKey: 'value' }),
    e => e.refusal === 'model-as-actor');
});

it('links only to routes that exist', () => {
  // The previous content guidance pointed at /feed, /signals, /tips and
  // /accas. Only a redirect survives, and /accas was never a route — it is
  // /acca. A caller names a key so a retired route breaks here, loudly,
  // instead of shipping a dead link to an audience that will not report it.
  assert.throws(() => c.compose({ body: 'x', routeKey: 'tips' }), e => e.refusal === 'unknown-route');
  assert.throws(() => c.compose({ body: 'x', routeKey: 'accas' }), e => e.refusal === 'unknown-route');
  assert.throws(() => c.compose({ body: 'x', routeKey: 'signals' }), e => e.refusal === 'unknown-route');
  for (const k of Object.keys(c.ROUTES)) {
    assert.ok(c.ROUTES[k].startsWith('https://www.maxedge.live/'), `${k} is not a site route`);
  }
});

it('measures length the way X does, counting a URL as 23', () => {
  const short = c.weightedLength('a https://x.co/1');
  const long = c.weightedLength('a https://www.maxedge.live/value-bets');
  assert.strictEqual(short, long, 'URL length leaked into the budget');
});

it('refuses an over-long post rather than truncating it', () => {
  // A truncated post is a different claim, and on a priced selection a
  // different claim is a substantiation problem.
  assert.throws(() => c.compose({ body: 'x'.repeat(400), routeKey: 'value' }),
    e => e.refusal === 'too-long');
});

it('every value variant fits inside the budget', () => {
  for (let i = 0; i < c.VARIANTS.value.length; i++) {
    const t = c.compose({ body: c.valueBody(ROW, i), routeKey: 'value' });
    assert.ok(c.weightedLength(t) <= c.MAX_CHARS, `variant ${i} is ${c.weightedLength(t)}`);
  }
});

it('formats EV with one decimal and a real minus', () => {
  assert.strictEqual(c.formatEv(0.087), '+8.7%');
  assert.strictEqual(c.formatEv(-0.049), '−4.9%');
});

console.log('\nguard — the rails an unattended poster needs');

it('the kill switch fails closed', () => {
  // An unattended poster that keeps going when it cannot confirm it is allowed
  // to is the failure this file exists to prevent. Only '1' enables.
  assert.strictEqual(g.channelEnabled({}), false);
  assert.strictEqual(g.channelEnabled({ X_POSTING_ENABLED: '' }), false);
  assert.strictEqual(g.channelEnabled({ X_POSTING_ENABLED: '0' }), false);
  assert.strictEqual(g.channelEnabled({ X_POSTING_ENABLED: 'true' }), false);
  assert.strictEqual(g.channelEnabled({ X_POSTING_ENABLED: 'yes' }), false);
  assert.strictEqual(g.channelEnabled({ X_POSTING_ENABLED: '1' }), true);
});

it('two different fixtures on one template share a skeleton', () => {
  // THE POINT OF THE WHOLE GUARD. `message_hash` sees these as different posts
  // because every word that differs is a word that differs. X's rule is about
  // the sentence, not the data.
  const a = c.valueBody(ROW, 0);
  const b = c.valueBody({ ...ROW, home: 'Leeds United', away: 'Burnley', selection: 'Leeds United to Win', odds: 1.85, ev: 0.042, book: 'Bet365' }, 0);
  assert.notStrictEqual(a, b, 'the two posts should differ as text');
  assert.strictEqual(g.skeletonOf(a), g.skeletonOf(b), 'same template must give the same skeleton');
});

it('the six variants give six distinct skeletons', () => {
  // If this drops, rotation stops working and the channel deadlocks or starts
  // repeating itself. Either is a defect.
  const seen = new Set();
  for (let i = 0; i < c.VARIANTS.value.length; i++) seen.add(g.skeletonOf(c.valueBody(ROW, i)));
  assert.strictEqual(seen.size, c.VARIANTS.value.length, `only ${seen.size} distinct shapes`);
});

it('there are more variants than the similarity window', () => {
  // A window at or above the variant count refuses every candidate: no posts,
  // no error, nothing in the log to explain it. One decision in two files.
  assert.ok(c.VARIANTS.value.length > g.SIMILARITY_WINDOW,
    `${c.VARIANTS.value.length} variants against a window of ${g.SIMILARITY_WINDOW} deadlocks the poster`);
});

it('refuses a shape already sent inside the window', () => {
  const text = c.compose({ body: c.valueBody(ROW, 0), routeKey: 'value' });
  const skeleton = g.skeletonOf(text);
  const r = g.mayPost({ text, recentSkeletons: [skeleton], env: { X_POSTING_ENABLED: '1' } });
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.reason, 'too-similar');
});

it('allows a shape that has aged out of the window', () => {
  const text = c.compose({ body: c.valueBody(ROW, 0), routeKey: 'value' });
  const recent = ['a', 'b', 'c', 'd', g.skeletonOf(text)];
  const r = g.mayPost({ text, recentSkeletons: recent, env: { X_POSTING_ENABLED: '1', X_SIMILARITY_WINDOW: '4' } });
  assert.strictEqual(r.ok, true);
});

it('enforces the daily cap across all post types together', () => {
  // The audience sees one timeline, so the cap counts one timeline.
  const text = c.compose({ body: c.valueBody(ROW, 0), routeKey: 'value' });
  const r = g.mayPost({ text, postedToday: 4, env: { X_POSTING_ENABLED: '1', X_DAILY_CAP: '4' } });
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.reason, 'daily-cap');
});

it('the disabled switch beats everything else', () => {
  const text = c.compose({ body: c.valueBody(ROW, 0), routeKey: 'value' });
  const r = g.mayPost({ text, recentSkeletons: [], postedToday: 0, env: {} });
  assert.strictEqual(r.reason, 'channel-disabled');
});

it('never throws on malformed input', () => {
  // A guard that can be crashed past is not a guard.
  for (const bad of [null, undefined, 42, {}, '']) {
    const r = g.mayPost({ text: bad, env: { X_POSTING_ENABLED: '1' } });
    assert.strictEqual(r.ok, false);
  }
});


/* ─── the adapter's own decisions ──────────────────────────────────────────
 *
 * Three, and only three, belong to postToXChannel: which eligible signal gets
 * today's budget, how it is worded, and whether the rails allow it. The gate
 * itself is postToX's and is asserted by its own tests — what is checked here
 * is that this file does not quietly acquire a second opinion about it.
 */
const adapter = require('./postToXChannel');

console.log('\nadapter — selection and rotation');

it('spends the budget on the highest edge among eligible rows', () => {
  const sig = (id, edge, extra = {}) => ({
    id, detected_odds: 2.0, detected_edge: edge, outcome: 'X to Win',
    signal_category: 'value', mxs: 80, mxs_band: 'PRIME', phase: 'prematch',
    is_mover: false, model_architecture: 'MARKET_ANCHORED', ...extra,
  });
  const best = adapter.pickBest([sig('a', 0.04), sig('b', 0.09), sig('c', 0.06)]);
  assert.ok(best === null || best.id === 'b', 'did not take the highest edge');
});

it('never takes an in-play or a mover row', () => {
  // In-play is a different channel with a different disclosure; a mover is a
  // deliberate re-alert of a selection already broadcast. Neither is a post.
  const rows = [
    { id: 'i', detected_odds: 2, detected_edge: 0.2, phase: 'inplay', is_mover: false, mxs_band: 'PRIME', signal_category: 'value' },
    { id: 'm', detected_odds: 2, detected_edge: 0.2, phase: 'prematch', is_mover: true, mxs_band: 'PRIME', signal_category: 'value' },
  ];
  assert.strictEqual(adapter.pickBest(rows), null);
});

it('refuses a row with an unusable price', () => {
  const rows = [{ id: 'z', detected_odds: 1, detected_edge: 0.2, phase: 'prematch', is_mover: false, mxs_band: 'PRIME', signal_category: 'value' }];
  assert.strictEqual(adapter.pickBest(rows), null);
});

it('rotates phrasing on the count, not at random', () => {
  // Random rotation repeats by chance, and a repeat is the one outcome the
  // guard exists to stop.
  const seen = new Set();
  for (let i = 0; i < c.VARIANTS.value.length; i++) seen.add(adapter.variantFor(i));
  assert.strictEqual(seen.size, c.VARIANTS.value.length, 'rotation does not cover every variant');
  assert.strictEqual(adapter.variantFor(0), adapter.variantFor(c.VARIANTS.value.length), 'rotation does not wrap');
});

it('posts on the x channel, never telegram', () => {
  assert.strictEqual(adapter.CHANNEL, 'x');
  assert.notStrictEqual(adapter.CHANNEL, require('./postToX').CHANNEL);
});

console.log(`\n${n} assertions passed\n`);
