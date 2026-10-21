'use strict';
// lib/inplayFlags — which tracker flags are new, and what a post may say.

const assert = require('assert');
const { flagKey, postable, newFlags, flagPost, withCard, MAX_FLAGS_PER_MATCH, LATEST_MINUTE } = require('./lib/inplayFlags');
const { teamMark } = require('./lib/discordCards');

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
  // The brand's address (maxedge.live, also in the footer) is not an "edge" claim, so it is removed first.
  const s = `${e.title} ${e.description} ${e.footer.text}`.toLowerCase().replace(/maxedge\.live\S*/g, '');
  for (const w of ['bet now', 'back ', 'stake', 'edge', 'value', 'odds']) assert(!s.includes(w), `post mentions "${w}"`);
});

t('banned words refuse the post rather than soften it', () => {
  assert.throws(() => flagPost(match(), flag('pressure', 'home', { detail: 'A guaranteed goal is coming.' })));
});


t('the card rides as the embed image and the text survives', () => {
  const p = withCard(flagPost(match(), flag('red-card', 'away')), 'flag.png');
  assert.strictEqual(p.embeds[0].image.url, 'attachment://flag.png');
  assert(p.embeds[0].description.includes('Arsenal 0–1 Chelsea'));
  assert.deepStrictEqual(p.allowed_mentions, { parse: [] });
});

t('crests are replaced by a three-letter mark', () => {
  assert.strictEqual(teamMark('Tottenham'), 'TOT');
  assert.strictEqual(teamMark('Manchester United'), 'MU');
  assert.strictEqual(teamMark('Toronto FC'), 'TOR');
  assert.strictEqual(teamMark('CF Montreal'), 'MON');
  assert.strictEqual(teamMark(''), '?');
});

const { xEligible, xFlagText, FRAMES, DEFAULT_LEAGUES } = require('./lib/inplayFlagsX');
const { skeletonOf, mayPost } = require('./lib/xGuard');

t('X takes only alert flags from listed leagues, matched by id', () => {
  const L = new Set(DEFAULT_LEAGUES);
  assert(xEligible(flag('red-card', 'away'), '39', L));
  assert(xEligible(flag('fav-trailing', 'home'), 39, L));
  assert(!xEligible(flag('pressure', 'home'), '39', L));
  assert(!xEligible(flag('goals-due', null), '39', L));
  assert(!xEligible(flag('red-card', 'away'), '235', L));   // Russian "Premier League"
  assert(!xEligible(flag('red-card', 'away'), '71', L));    // Brazilian "Serie A"
  assert(!xEligible(flag('red-card', 'away'), null, L));
});

t('X text: facts, footer, no link, and every frame a different shape', () => {
  const m = match({ minute: 78, homeGoals: 1, awayGoals: 0, homeTeam: 'Manchester United', awayTeam: 'Tottenham' });
  const f = flag('red-card', 'away', { detail: "Rodrigo Bentancur sent off (78'). Tottenham down to 10 men." });
  const shapes = new Set();
  for (let i = 0; i < FRAMES.length; i++) {
    const s = xFlagText(m, f, i);
    assert(s.endsWith('18+ | GamCare 0808 8020 133 | Live match facts, not advice'));
    assert(s.includes('Manchester United 1-0 Tottenham'));
    assert(!/https?:|maxedge\.live/i.test(s));
    assert(s.length <= 280, `frame ${i} is ${s.length} chars`);
    shapes.add(skeletonOf(s));
  }
  assert.strictEqual(shapes.size, FRAMES.length);
  // More frames than the guard's window, or the channel deadlocks.
  assert(FRAMES.length > 4);
});

t('the guard always finds a free frame after four posts', () => {
  const m = match(); const f = flag('fav-trailing', 'home', { detail: 'Arsenal were 60% to win before kick-off and trail 0-1.' });
  const recent = [0, 1, 2, 3].map(i => skeletonOf(xFlagText(m, f, i)));
  const env = { X_POSTING_ENABLED: '1', X_DAILY_CAP: '6' };
  const free = FRAMES.map((_, i) => mayPost({ text: xFlagText(m, f, i), recentSkeletons: recent, postedToday: 4, env }).ok);
  assert(free.filter(Boolean).length >= 2);
});

console.log(`\n${n} passed`);
