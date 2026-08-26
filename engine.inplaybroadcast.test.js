'use strict';

/**
 * engine.inplaybroadcast.test.js — the in-play Telegram channel.
 *
 * The `🔴 IN-PLAY VALUE` branch had sat in buildMessage since it was written
 * and had NEVER been reachable: fetchRecentSignals filters every row through
 * `isPublished`, and no in-play architecture is in PUBLICATION, so the row was
 * gone before the branch was consulted — whatever TELEGRAM_INPLAY_CHAT_ID was
 * set to. These pin the gate that admits it, the two switches that guard it,
 * and the disclosure it is admitted ON.
 *
 * Run: node engine.inplaybroadcast.test.js   (zero deps, no DB/network)
 */

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const pub = require('./lib/publication');
const st = require('./lib/inplayState');
const { bookmakerLabel } = require('./lib/bookmakers');

let passed = 0, failed = 0;
function test(label, fn) {
  const prev = process.env.INPLAY_BROADCAST_ENABLED;
  try { fn(); console.log(`  ✓ ${label}`); passed++; }
  catch (e) { console.error(`  ✗ ${label}\n    ${e.message}`); failed++; }
  finally {
    if (prev === undefined) delete process.env.INPLAY_BROADCAST_ENABLED;
    else process.env.INPLAY_BROADCAST_ENABLED = prev;
  }
}
const on  = () => { process.env.INPLAY_BROADCAST_ENABLED = 'true'; };
const off = () => { delete process.env.INPLAY_BROADCAST_ENABLED; };

console.log('the gate — two switches, both failing closed');
test('OFF by default: nothing broadcasts until somebody decides it should', () => {
  off();
  assert.strictEqual(pub.inplayBroadcastEnabled(), false);
  assert.strictEqual(pub.mayBroadcastInplay('INPLAY_DIXON_COLES'), false);
  assert.strictEqual(pub.mayBroadcastInplay('SECOND_HALF_SNIPER'), false);
});
test('ON admits only the NAMED architectures — a new one does not inherit it', () => {
  on();
  assert.strictEqual(pub.mayBroadcastInplay('INPLAY_DIXON_COLES'), true);
  assert.strictEqual(pub.mayBroadcastInplay('SECOND_HALF_SNIPER'), true);
  for (const unknown of ['SUPERMODEL_HALFTIME', 'INPLAY_MODEL', 'ELO', null, undefined, '']) {
    assert.strictEqual(pub.mayBroadcastInplay(unknown), false, `${unknown} must not inherit the channel`);
  }
});
test('THE PRE-MATCH GATE IS UNMOVED, flag on or off', () => {
  const before = pub.PUBLISHED_ARCHITECTURES.slice().sort();
  on();
  assert.deepStrictEqual(pub.PUBLISHED_ARCHITECTURES.slice().sort(), before);
  // The whole point of a separate set: these must never become publishable.
  assert.strictEqual(pub.isPublished('INPLAY_DIXON_COLES'), false);
  assert.strictEqual(pub.isPublished('SECOND_HALF_SNIPER'), false);
});

console.log('the disclosure it is admitted ON');
test('every admitted architecture has a note, and it names the absence', () => {
  for (const arch of Object.keys(pub.INPLAY_BROADCAST)) {
    const note = pub.inplayDisclosure(arch);
    assert.ok(note && note.length > 10, `${arch} must carry a disclosure`);
    assert.ok(/no measured error bar/i.test(note), `${arch}: must state there is no measured error bar`);
    assert.ok(/no settled record|no conviction/i.test(note), `${arch}: must state the record is empty`);
  }
});
test('an unknown architecture still gets a refusal, never an empty string', () => {
  assert.ok(pub.inplayDisclosure('NOT_A_MODEL').length > 10);
  assert.ok(pub.inplayLabel('NOT_A_MODEL').length > 0);
  assert.ok(!/NOT_A_MODEL/.test(pub.inplayLabel('NOT_A_MODEL')), 'never render the raw enum at a reader');
});

console.log('the message');
const { buildMessage } = require('./postToX.js');
const sig = (over = {}) => ({
  id: 'x', market: 'h2h', outcome: 'home', detected_odds: 1.166, detected_edge: 0.0473,
  detected_mes: null, bookmaker: 'apifootball_live', phase: 'inplay',
  model_architecture: 'INPLAY_DIXON_COLES',
  match: { goals_home: 1, goals_away: 0, minute: 76,
    home_team: { name: 'Rapid Vienna' }, away_team: { name: 'Heart Of Midlothian' },
    league: { name: 'UEFA Europa Conference League' } },
  ...over,
});

test('RED is the in-play mark and the live score carries it', () => {
  const m = buildMessage(sig());
  assert.ok(m.startsWith('🔴'), 'the first glyph tells a reader which channel they are in');
  assert.ok(/🔴 \*1-0 76'\*/.test(m), 'the clock and score are red too');
});
test('the disclosure and the moves-fast warning are BOTH in every message', () => {
  const m = buildMessage(sig());
  assert.ok(/no measured error bar/i.test(m), 'the post says what the model is');
  assert.ok(/Live price/i.test(m) && /may be gone/i.test(m), 'and that the price may not be there');
});
test('a man advantage is stated ABOVE the price, and names the side', () => {
  const mk = n => ({ stats: [{ type: 'Red Cards', value: n }] });
  const m = buildMessage(sig({ live_state: st.liveState(mk(0), mk(1)) }));
  assert.ok(/Heart Of Midlothian down to 10 men/.test(m), 'names the side that is short');
  assert.ok(m.indexOf('down to 10 men') < m.indexOf('@ *1.17*'), 'the reason comes before the price');
});
test('an UNREPORTED card draws no line at all — absent is not "none"', () => {
  assert.ok(!/down to \d+ men/.test(buildMessage(sig())), 'no live_state, no claim');
  const mk = n => ({ stats: [{ type: 'Red Cards', value: n }] });
  assert.ok(!/down to \d+ men/.test(buildMessage(sig({ live_state: st.liveState(mk(0), mk(0)) }))),
    'an even count is not a man advantage');
});
test('the totals form names the market and the line', () => {
  const m = buildMessage(sig({ market: 'totals', market_line: 2.5, outcome: 'over',
    model_architecture: 'SECOND_HALF_SNIPER' }));
  assert.ok(/TOTALS 2\.5/.test(m), '"OVER" alone says nothing about what is being counted');
  assert.ok(/Second-half goals/.test(m), 'and the reader-facing model name, not the enum');
  assert.ok(!/SECOND_HALF_SNIPER/.test(m), 'never render the raw enum');
});

console.log('Telegram Markdown — underscores are italic delimiters');
test('the bookmaker goes through bookmakerLabel, so a key cannot break the post', () => {
  // value_signals holds The Odds API's KEYS verbatim: unibet_uk, betfair_sb_uk,
  // apifootball_live. Printed raw, one underscore leaves a stray delimiter and
  // two silently italicise everything between them.
  for (const key of ['apifootball_live', 'unibet_uk', 'betfair_sb_uk', 'bet365']) {
    const m = buildMessage(sig({ bookmaker: key }));
    assert.ok(!m.includes(key), `${key} must be rendered as a label, not the raw key`);
    assert.strictEqual((m.match(/_/g) || []).length % 2, 0,
      `${key}: every italic delimiter must be paired`);
  }
});
test('and the live feed is named as a FEED, not as a bookmaker nobody has heard of', () => {
  assert.strictEqual(bookmakerLabel('apifootball_live'), 'Live feed (aggregated)');
  assert.ok(!/apifootballlive/.test(buildMessage(sig())), 'the slugified key must not reach a reader');
});
test('an underscore in an OUTCOME is still handled — the older half of the same bug', () => {
  const m = buildMessage(sig({ outcome: 'btts_yes' }));
  assert.ok(/BTTS YES/.test(m));
  assert.strictEqual((m.match(/_/g) || []).length % 2, 0);
});

console.log('wiring');
const src = fs.readFileSync(path.join(__dirname, 'postToX.js'), 'utf8');
const wf  = fs.readFileSync(path.join(__dirname, '.github/workflows/run-inplay.yml'), 'utf8');
test('fetchRecentSignals routes in-play through its OWN gate, not isPublished', () => {
  assert.ok(/isInplay\(r\)\s*\?\s*mayBroadcastInplay\(r\.model_architecture\)\s*:\s*isPublished\(r\.model_architecture\)/.test(src),
    'the door must split on phase — this is the gate that made the branch unreachable');
});
test('the workflow passes BOTH switches', () => {
  assert.ok(/INPLAY_BROADCAST_ENABLED/.test(wf), 'the flag must be in the job env');
  assert.ok(/TELEGRAM_INPLAY_CHAT_ID/.test(wf), 'and the channel id');
});
test('an in-play post can never reach the PRE-MATCH channel', () => {
  // chatIdForSignal returns the in-play id or null; null skips. A regression
  // here leaks live picks into the main channel, which is the one outcome the
  // separate channel exists to prevent.
  const { chatIdForSignal } = require('./postToX.js');
  const tg = { token: 't', chatId: 'MAIN', inplayChatId: null };
  assert.strictEqual(chatIdForSignal(tg, { phase: 'inplay' }), null);
  assert.strictEqual(chatIdForSignal(tg, { phase: 'prematch' }), 'MAIN');
  assert.strictEqual(chatIdForSignal({ ...tg, inplayChatId: 'LIVE' }, { phase: 'inplay' }), 'LIVE');
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
