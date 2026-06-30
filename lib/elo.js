'use strict';

/**
 * lib/elo.js — pure ELO rating math, mirroring ensemble/train_supermodel_v2.py
 * (EloSystem) so production ratings match the supermodel's training
 * distribution. Constants are identical: K=30, home advantage=80, default=1500.
 *
 * Pure and unit-tested (engine.inplay.test.js). The stateful ladder lives in
 * computeElo.js, which walks completed matches chronologically and persists
 * ratings to the team_elo table.
 */

const ELO_K        = parseFloat(process.env.ELO_K || '30');
const ELO_HOME_ADV = parseFloat(process.env.ELO_HOME_ADV || '80');
const ELO_DEFAULT  = parseFloat(process.env.ELO_DEFAULT || '1500');

/** P(home wins) including home-field advantage. */
function expectedHome(homeElo, awayElo, homeAdv = ELO_HOME_ADV) {
  return 1.0 / (1.0 + Math.pow(10, -((homeElo + homeAdv) - awayElo) / 400));
}

/**
 * New (homeElo, awayElo) after a result. `result` is 'H' | 'D' | 'A'.
 * Mirrors EloSystem.update: symmetric zero-sum update around the expectation.
 *
 * @returns {{home:number, away:number}}
 */
function updatePair(homeElo, awayElo, result, k = ELO_K, homeAdv = ELO_HOME_ADV) {
  const exp = expectedHome(homeElo, awayElo, homeAdv);
  const sHome = result === 'H' ? 1.0 : result === 'D' ? 0.5 : 0.0;
  const sAway = 1.0 - sHome;
  return {
    home: homeElo + k * (sHome - exp),
    away: awayElo + k * (sAway - (1.0 - exp)),
  };
}

module.exports = { ELO_K, ELO_HOME_ADV, ELO_DEFAULT, expectedHome, updatePair };
