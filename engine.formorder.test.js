/**
 * THE FORM STRING HAD NO ORDER.
 *
 * `form` is the results of a team's last-N fixtures joined in array order, and
 * the array was whatever `/fixtures?last=N` returned. Nothing sorted it,
 * nothing checked it, and the row carried no date to check it against. This
 * file's own JSDoc said "newest first" while the site's `MatchHero` reversed
 * the string on the stated belief that it arrives oldest-first.
 *
 * Measured 9 Oct 2026: `team_statistics.form` and our own `matches` rows held
 * THE SAME TEN RESULTS FOR BRADFORD IN A DIFFERENT ORDER. The games were
 * right; the sequence was not.
 *
 * It is oldest-first now, which is how the board already draws a run.
 */
const test = require('node:test');
const assert = require('node:assert');

/* The comparator under test, mirrored from fetchTeamWindow. */
function byKickoff(list) {
  return [...list].sort((a, b) => {
    const ta = Date.parse(a?.fixture?.date ?? '');
    const tb = Date.parse(b?.fixture?.date ?? '');
    if (!Number.isFinite(ta) && !Number.isFinite(tb)) return 0;
    if (!Number.isFinite(ta)) return 1;
    if (!Number.isFinite(tb)) return -1;
    return ta - tb;
  });
}
const fx = (date, tag) => ({ fixture: { date, id: tag } });
const ids = (l) => l.map((f) => f.fixture.id).join('');

test('orders a shuffled window oldest first', () => {
  const shuffled = [
    fx('2026-09-19T14:00:00+00:00', 'd'),
    fx('2026-08-29T14:00:00+00:00', 'a'),
    fx('2026-10-03T14:00:00+00:00', 'e'),
    fx('2026-09-05T14:00:00+00:00', 'b'),
    fx('2026-09-12T14:00:00+00:00', 'c'),
  ];
  assert.strictEqual(ids(byKickoff(shuffled)), 'abcde');
});

test('a window already newest-first is turned round, not left alone', () => {
  const newestFirst = [
    fx('2026-10-03T14:00:00+00:00', 'e'),
    fx('2026-09-19T14:00:00+00:00', 'd'),
    fx('2026-09-12T14:00:00+00:00', 'c'),
  ];
  assert.strictEqual(ids(byKickoff(newestFirst)), 'cde');
});

/* A NaN COMPARATOR LEAVES THE ORDER UNDEFINED, which is the failure this is
   replacing, so an undated fixture sorts last instead of poisoning the sort. */
test('an undated fixture goes last and the rest stay ordered', () => {
  const withBad = [
    fx('2026-09-19T14:00:00+00:00', 'b'),
    fx(null, 'z'),
    fx('2026-09-05T14:00:00+00:00', 'a'),
  ];
  assert.strictEqual(ids(byKickoff(withBad)), 'abz');
});

test('two undated fixtures do not throw and do not reorder each other', () => {
  const bad = [fx(null, 'y'), fx(undefined, 'z')];
  assert.strictEqual(ids(byKickoff(bad)), 'yz');
});

/* THE STRING THE ROW STORES. Oldest on the left, so the last character is the
   most recent result and a "last 5" is the final five characters. */
test('the joined string reads oldest to newest', () => {
  const window = [
    { kickoff: '2026-08-29T14:00:00Z', result: 'L' },
    { kickoff: '2026-09-05T14:00:00Z', result: 'W' },
    { kickoff: '2026-10-03T14:00:00Z', result: 'D' },
  ];
  assert.strictEqual(window.map((r) => r.result).join(''), 'LWD');
  assert.strictEqual(window.map((r) => r.result).join('').slice(-1), 'D');
});
