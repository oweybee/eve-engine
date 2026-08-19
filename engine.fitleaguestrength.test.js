'use strict';

/**
 * engine.fitleaguestrength.test.js — the refit, checked against ground truth.
 *
 * The offsets in `league_strength` cannot be verified by reading them: -108 for
 * the Championship is plausible whether the estimator is right or subtly wrong.
 * So the central test here SIMULATES matches from OFFSETS THIS FILE CHOSE and
 * asks the fitter to recover them. If the recovery is good, the estimator is
 * doing what it claims; if it drifts, the production numbers are suspect and
 * this fails without anyone needing to notice a number looked odd.
 *
 * Everything is deterministic — a seeded generator, no Math.random — so a
 * failure is reproducible rather than a flake to be re-run.
 */

const test = require('node:test');
const assert = require('node:assert');
const {
  seasonOf, replayPrematch, leagueBySeason, logLikelihood, fitOffsets, profileInterval,
} = require('./fitLeagueStrength');
const { DEFAULTS, drawProb } = require('./lib/eloProbs');
const { expectedHome, ELO_DEFAULT } = require('./lib/elo');

/** Deterministic uniform in [0,1). Mulberry32. */
function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6D2B79F5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// ── seasons ────────────────────────────────────────────────────────────────
test('a season is labelled by its start year and turns over in August', () => {
  assert.equal(seasonOf('2026-08-01T00:00:00Z'), 2026);
  assert.equal(seasonOf('2026-07-31T23:59:59Z'), 2025);
  assert.equal(seasonOf('2027-05-30T00:00:00Z'), 2026);
  assert.equal(seasonOf('2026-01-15T00:00:00Z'), 2025);
});

// ── the replay ─────────────────────────────────────────────────────────────
test('pre-match state is recorded BEFORE the fixture is applied', () => {
  const pm = replayPrematch([
    { id: 'm1', kickoff_at: '2026-01-01', result: 'home', home_key: 'a', away_key: 'b' },
    { id: 'm2', kickoff_at: '2026-01-08', result: 'home', home_key: 'a', away_key: 'b' },
  ]);
  // The first fixture sees both clubs untouched...
  assert.deepEqual(pm.get('m1'), { hElo: ELO_DEFAULT, aElo: ELO_DEFAULT, hGames: 0, aGames: 0 });
  // ...and the second sees the first one's effect, which is look-ahead-free.
  assert.equal(pm.get('m2').hGames, 1);
  assert.ok(pm.get('m2').hElo > ELO_DEFAULT, 'the home win should have raised a');
  assert.ok(pm.get('m2').aElo < ELO_DEFAULT, 'and lowered b');
});

test('every club-game is counted exactly once', () => {
  const matches = Array.from({ length: 50 }, (_, i) => ({
    id: `m${i}`, kickoff_at: `2026-01-${String((i % 28) + 1).padStart(2, '0')}`,
    result: ['home', 'draw', 'away'][i % 3],
    home_key: `t${i % 7}`, away_key: `t${(i + 3) % 7}`,
  })).filter(m => m.home_key !== m.away_key);
  const pm = replayPrematch(matches);
  assert.equal(pm.size, matches.length);
});

test('a fixture with an unusable result is skipped, not counted', () => {
  const pm = replayPrematch([
    { id: 'x', kickoff_at: '2026-01-01', result: 'postponed', home_key: 'a', away_key: 'b' },
    { id: 'y', kickoff_at: '2026-01-02', result: 'home', home_key: 'a', away_key: null },
  ]);
  assert.equal(pm.size, 0);
});

// ── league membership ──────────────────────────────────────────────────────
test('league membership is modal per season and ignores cups', () => {
  const comps = new Map([
    ['epl', { isDomestic: true }],
    ['championship', { isDomestic: true }],
    ['cup', { isDomestic: false }],
  ]);
  const m = (id, lg, home, away, when) =>
    ({ id, league_id: lg, home_key: home, away_key: away, kickoff_at: when, result: 'home' });
  const bySeason = leagueBySeason([
    m('1', 'epl', 'a', 'b', '2026-09-01'),
    m('2', 'epl', 'a', 'c', '2026-10-01'),
    m('3', 'championship', 'a', 'd', '2026-11-01'),   // one stray appearance
    m('4', 'cup', 'a', 'z', '2026-09-15'),            // cups confer nothing
  ], comps);
  assert.equal(bySeason.get('a|2026'), 'epl');
  assert.equal(bySeason.get('z|2026'), undefined, 'a cup-only club has no league');
});

test('a club that changes division gets a different league each season', () => {
  const comps = new Map([['epl', { isDomestic: true }], ['ch', { isDomestic: true }]]);
  const bySeason = leagueBySeason([
    { id: '1', league_id: 'ch',  home_key: 'x', away_key: 'y', kickoff_at: '2025-09-01', result: 'home' },
    { id: '2', league_id: 'epl', home_key: 'x', away_key: 'z', kickoff_at: '2026-09-01', result: 'home' },
  ], comps);
  assert.equal(bySeason.get('x|2025'), 'ch');
  assert.equal(bySeason.get('x|2026'), 'epl');
});

// ── the likelihood ─────────────────────────────────────────────────────────
test('the likelihood agrees with eloProbs on a single observation', () => {
  const obs = [{ homeLeague: 'A', awayLeague: 'B', result: 'draw', base: 120 }];
  const theta = new Map([['A', 0], ['B', -40]]);
  const d = 120 + 0 - (-40);
  const E = expectedHome(d, 0, 0);
  const expected = Math.log(drawProb(d, E, DEFAULTS));
  assert.ok(Math.abs(logLikelihood(obs, theta, DEFAULTS) - expected) < 1e-12);
});

test('the offsets only ever enter as a difference', () => {
  const obs = [{ homeLeague: 'A', awayLeague: 'B', result: 'home', base: 0 }];
  const a = logLikelihood(obs, new Map([['A', 0],   ['B', -100]]), DEFAULTS);
  const b = logLikelihood(obs, new Map([['A', 250], ['B', 150]]),  DEFAULTS);
  assert.ok(Math.abs(a - b) < 1e-12, 'a common shift must not change the likelihood');
});

// ── recovery: the test that matters ────────────────────────────────────────
test('the fitter RECOVERS offsets it was never told, from simulated results', () => {
  const truth = new Map([['ref', 0], ['strong', -40], ['mid', -140], ['weak', -300]]);
  const ids = [...truth.keys()];
  const rand = rng(20260819);

  // Ratings are drawn around the pool mean, so a club's rating carries no
  // information about its league — the offset is the ONLY thing separating them,
  // which is exactly the situation the production fit is in.
  const observations = [];
  for (let i = 0; i < 6000; i++) {
    const hl = ids[Math.floor(rand() * ids.length)];
    let al = ids[Math.floor(rand() * ids.length)];
    if (al === hl) al = ids[(ids.indexOf(hl) + 1) % ids.length];
    const base = (rand() - 0.5) * 300 + DEFAULTS.homeAdv;
    const d = base + truth.get(hl) - truth.get(al);
    const E = expectedHome(d, 0, 0);
    const pD = drawProb(d, E, DEFAULTS);
    const u = rand();
    const result = u < E - pD / 2 ? 'home' : u < E + pD / 2 ? 'draw' : 'away';
    observations.push({ homeLeague: hl, awayLeague: al, result, base });
  }

  const fitted = fitOffsets(observations, ids, 'ref', DEFAULTS);
  assert.equal(fitted.get('ref'), 0, 'the pinned league must stay at the origin');
  for (const id of ids) {
    const err = Math.abs(fitted.get(id) - truth.get(id));
    assert.ok(err < 25, `${id}: recovered ${fitted.get(id).toFixed(1)} vs true ${truth.get(id)} (err ${err.toFixed(1)})`);
  }
});

test('the fit strictly improves the likelihood over all-zero', () => {
  const truth = new Map([['ref', 0], ['b', -150]]);
  const rand = rng(7);
  const observations = [];
  for (let i = 0; i < 1200; i++) {
    const [hl, al] = rand() < 0.5 ? ['ref', 'b'] : ['b', 'ref'];
    const base = (rand() - 0.5) * 200 + DEFAULTS.homeAdv;
    const d = base + truth.get(hl) - truth.get(al);
    const E = expectedHome(d, 0, 0);
    const pD = drawProb(d, E, DEFAULTS);
    const u = rand();
    observations.push({ homeLeague: hl, awayLeague: al, base,
      result: u < E - pD / 2 ? 'home' : u < E + pD / 2 ? 'draw' : 'away' });
  }
  const ids = ['ref', 'b'];
  const zero = new Map(ids.map(i => [i, 0]));
  const fitted = fitOffsets(observations, ids, 'ref', DEFAULTS);
  assert.ok(logLikelihood(observations, fitted, DEFAULTS) > logLikelihood(observations, zero, DEFAULTS));
});

// ── uncertainty ────────────────────────────────────────────────────────────
test('the profile interval brackets the estimate and narrows with more data', () => {
  const build = (n, seed) => {
    const rand = rng(seed);
    const truth = new Map([['ref', 0], ['b', -120]]);
    const out = [];
    for (let i = 0; i < n; i++) {
      const [hl, al] = rand() < 0.5 ? ['ref', 'b'] : ['b', 'ref'];
      const base = (rand() - 0.5) * 200 + DEFAULTS.homeAdv;
      const d = base + truth.get(hl) - truth.get(al);
      const E = expectedHome(d, 0, 0);
      const pD = drawProb(d, E, DEFAULTS);
      const u = rand();
      out.push({ homeLeague: hl, awayLeague: al, base,
        result: u < E - pD / 2 ? 'home' : u < E + pD / 2 ? 'draw' : 'away' });
    }
    return out;
  };
  const se = (n) => {
    const obs = build(n, 99);
    const theta = fitOffsets(obs, ['ref', 'b'], 'ref', DEFAULTS);
    const iv = profileInterval(obs, theta, 'b', DEFAULTS);
    assert.ok(iv.lo < theta.get('b') && theta.get('b') < iv.hi, 'the interval must bracket the estimate');
    return iv.se;
  };
  const small = se(200), large = se(3000);
  assert.ok(large < small, `se should shrink with data: ${large.toFixed(1)} vs ${small.toFixed(1)}`);
});

test('profiling leaves the offsets where it found them', () => {
  const obs = [{ homeLeague: 'A', awayLeague: 'B', result: 'home', base: 100 },
               { homeLeague: 'B', awayLeague: 'A', result: 'away', base: 100 }];
  const theta = new Map([['A', 0], ['B', -50]]);
  profileInterval(obs, theta, 'B', DEFAULTS);
  assert.equal(theta.get('B'), -50, 'the search must restore the optimum it perturbed');
});
