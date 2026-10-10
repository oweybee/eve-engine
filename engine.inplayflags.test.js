'use strict';
// lib/inplayFlags — which tracker flags are new, and what a post may say.

const assert = require('assert');
const { flagKey, postable, newFlags, flagPost, MAX_FLAGS_PER_MATCH, LATEST_MINUTE } = require('./lib/inplayFlags');

let n = 0;
const t = (name, fn) => { fn(); n++; console.log(`ok ${n} ${name}`); };

const flag = (kind, side, extra = {}) => ({ kind, side, tone: 'alert', title: 'Red card', detail: 'Something happened.', ...extra });
const match = (over = {}) => ({
  id: '11111111-1111-1111-1111-111111111111', homeTeam: 'Arsenal', awayTeam: 'Chelsea', league: 'Premier League',
  minute: 34, period: '1H', homeGoals: 0, awayGoals: 1, flags: [], ...over,
});

t('the same flag re-read is the same key; a second red is a new one', () => {
  assert.strictEqual(flagKey(flag('pressure', 'home')), 'pressure:home');
  assert.strictEqual(flagKey(flag('goals-due', null)), 'goals-due:match');
  assert.strictEqual(flagKey(flag('red-card', 'away')), 'red-card:away:1');
  assert.strictEqual(flagKey(flag('red-card', 'away', { title: '2 red cards' })), 'red-card:away:2');
  // "Favourite behind early" becoming "Favourite behind" is not a new event
  assert.strictEqual(flagKey(flag('fav-trailing', 'home', { title: 'Favourite behind early' })),
    flagKey(flag('fav-trailing', 'home', { title: 'Favourite behind' })));
});

t('a finished or late match posts nothing', () => {
  assert(postable(match()));
  assert(postable(match({ period: 'HT', minute: 45 })));
  assert(!postable(match({ period: 'FT' })));
  assert(!postable(match({ minute: LATEST_MINUTE + 1 })));
  assert(!postable({ minute: 10 }));
});

t('only flags the ledger has not seen are new', () => {
  const m = match({ flags: [flag('red-card', 'away'), flag('pressure', 'home')] });
  const posted = new Map([[m.id, new Set(['red-card:away:1'])]]);
  const out = newFlags([m], posted);
  assert.deepStrictEqual(out.map(x => x.key), ['pressure:home']);
});

t('a busy match is capped', () => {
  const kinds = ['red-card', 'fav-trailing', 'pressure', 'goals-due', 'drift'];
  const m = match({ flags: kinds.map(k => flag(k, k === 'goals-due' ? null : 'home')) });
  assert.strictEqual(newFlags([m], new Map()).length, MAX_FLAGS_PER_MATCH);
  const full = new Map([[m.id, new Set(['a', 'b', 'c', 'd'])]]);
  assert.strictEqual(newFlags([m], full).length, 0);
});

t('a post carries the score, the clock and the flag sentence, and links the match', () => {
  const m = match();
  const p = flagPost(m, flag('red-card', 'away', { detail: 'R. James sent off (34\'). Chelsea down to 10 men.' }));
  const e = p.embeds[0];
  assert(e.description.includes('Arsenal 0–1 Chelsea'));
  assert(e.description.includes("34'"));
  assert(e.description.includes('R. James sent off'));
  assert.strictEqual(e.url, `https://maxedge.live/match/${m.id}`);
  assert(e.footer.text.includes('18+'));
  assert(e.footer.text.includes('not tips'));
  assert.deepStrictEqual(p.allowed_mentions, { parse: [] });
});

t('a post never names a price, a stake or a pick', () => {
  const p = flagPost(match(), flag('pressure', 'home', { detail: 'Arsenal: 6 shots on target to 1, still behind at 0–1.' }));
  const e = p.embeds[0];
  const s = `${e.title} ${e.description} ${e.footer.text}`.toLowerCase();   // not the url: maxedge.live
  for (const w of ['bet now', 'back ', 'stake', 'edge', 'value', 'odds']) assert(!s.includes(w), `post mentions "${w}"`);
});

t('banned words refuse the post rather than soften it', () => {
  assert.throws(() => flagPost(match(), flag('pressure', 'home', { detail: 'A guaranteed goal is coming.' })));
});

console.log(`\n${n} passed`);
