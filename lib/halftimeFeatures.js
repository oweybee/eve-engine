'use strict';

/**
 * lib/halftimeFeatures.js — build the 32-dim feature vector for the half-time
 * supermodel (models/supermodel_halftime_v2.onnx) from production DB data, at
 * training parity with ensemble/train_supermodel_v2.py.
 *
 * HONESTY GATES (the whole point of this module):
 *   The supermodel was trained ONLY on the top-5 European leagues with a running
 *   ELO ladder and rolling team form. It is out of distribution for anything
 *   else (e.g. the World Cup). So buildHalftimeVector returns { vector } only
 *   when ALL of these hold, and { vector: null, reason } otherwise:
 *     • the league is one of the five it was trained on;
 *     • both teams have an ELO with >= MIN_ELO_GAMES real games;
 *     • both teams have team_statistics form.
 *   A dormant return is the correct, safe outcome — never a guessed vector.
 *
 * Where production lacks a training field we fall back to the same per-league
 * priors the trainer used for cold-start (sot_rate, red_card_rate are not in
 * team_statistics), and document each gap inline.
 *
 * Pure (no I/O) so it is unit-tested. computeInplayValues.js gathers the DB
 * inputs and calls buildHalftimeVector().
 */

const { marginBuckets } = require('./inplay');

const MIN_ELO_GAMES = parseInt(process.env.INPLAY_MIN_ELO_GAMES || '5', 10);

// Per-league cold-start priors — copied verbatim from train_supermodel_v2.py
// LEAGUE_PRIORS so production fall-backs match the training distribution.
const LEAGUE_PRIORS = {
  epl:        { win_rate: 0.46, draw_rate: 0.26, goals_scored: 1.50, goals_conceded: 1.10, sot_rate: 4.5, clean_sheet_rate: 0.28, red_card_rate: 0.04 },
  laliga:     { win_rate: 0.47, draw_rate: 0.25, goals_scored: 1.60, goals_conceded: 1.00, sot_rate: 4.8, clean_sheet_rate: 0.30, red_card_rate: 0.05 },
  bundesliga: { win_rate: 0.45, draw_rate: 0.24, goals_scored: 1.70, goals_conceded: 1.10, sot_rate: 4.6, clean_sheet_rate: 0.27, red_card_rate: 0.03 },
  seriea:     { win_rate: 0.45, draw_rate: 0.28, goals_scored: 1.40, goals_conceded: 1.10, sot_rate: 4.2, clean_sheet_rate: 0.29, red_card_rate: 0.05 },
  ligue1:     { win_rate: 0.44, draw_rate: 0.27, goals_scored: 1.50, goals_conceded: 1.10, sot_rate: 4.3, clean_sheet_rate: 0.27, red_card_rate: 0.04 },
  // Extra leagues — pre-match supermodel only (the half-time model wasn't
  // trained on them; leagueKey() below keeps them out of the HT path).
  allsvenskan:{ win_rate: 0.43, draw_rate: 0.25, goals_scored: 1.40, goals_conceded: 1.40, sot_rate: 4.3, clean_sheet_rate: 0.26, red_card_rate: 0.04 },
  mls:        { win_rate: 0.50, draw_rate: 0.25, goals_scored: 1.45, goals_conceded: 1.45, sot_rate: 4.3, clean_sheet_rate: 0.24, red_card_rate: 0.04 },
};

// Authoritative training column order (models/supermodel_halftime_v2_features.json).
const FEATURE_ORDER = [
  'home_elo', 'away_elo', 'elo_differential',
  'home_win_rate_10', 'home_draw_rate_10', 'home_goals_scored_10', 'home_goals_conceded_10',
  'home_sot_rate_10', 'home_clean_sheet_rate_10', 'home_red_card_rate_10',
  'away_win_rate_10', 'away_draw_rate_10', 'away_goals_scored_10', 'away_goals_conceded_10',
  'away_sot_rate_10', 'away_clean_sheet_rate_10', 'away_red_card_rate_10',
  'h2h_home_win_rate_5',
  'league_epl', 'league_laliga', 'league_bundesliga', 'league_seriea', 'league_ligue1',
  'HTHG', 'HTAG', 'HR', 'AR',
  'ht_losing_2plus', 'ht_losing_1', 'ht_draw', 'ht_winning_1', 'ht_winning_2plus',
];

/** Map a free-text league name to a supported key, or null. */
function leagueKey(name) {
  const n = (name ?? '').toLowerCase();
  if (/premier league|epl|england/.test(n) && !/championship/.test(n)) return 'epl';
  if (/la ?liga|primera/.test(n)) return 'laliga';
  if (/bundesliga/.test(n) && !/2\.|zwei/.test(n)) return 'bundesliga';
  if (/serie a/.test(n)) return 'seriea';
  if (/ligue 1|ligue1/.test(n)) return 'ligue1';
  return null;
}

/** Win/draw rate from a form string like 'WWDLW'. Returns null if unusable. */
function formRates(formStr) {
  const s = String(formStr ?? '').toUpperCase().replace(/[^WDL]/g, '');
  if (!s.length) return null;
  const wins  = (s.match(/W/g) || []).length;
  const draws = (s.match(/D/g) || []).length;
  return { win_rate: wins / s.length, draw_rate: draws / s.length };
}

/** clean_sheet_pct may be stored 0-1 or 0-100; normalise to a rate in [0,1]. */
function asRate(v) {
  const x = Number(v);
  if (!Number.isFinite(x)) return null;
  return x > 1 ? x / 100 : x;
}

/** Per-team form block, blending team_statistics with league priors for gaps. */
function teamForm(stats, prior) {
  const rates = formRates(stats?.form);
  if (!rates) return null; // require real form — the core gate
  const cs = asRate(stats?.clean_sheet_pct);
  return {
    win_rate:         rates.win_rate,
    draw_rate:        rates.draw_rate,
    goals_scored:     Number.isFinite(Number(stats?.goals_for_avg))     ? Number(stats.goals_for_avg)     : prior.goals_scored,
    goals_conceded:   Number.isFinite(Number(stats?.goals_against_avg)) ? Number(stats.goals_against_avg) : prior.goals_conceded,
    sot_rate:         prior.sot_rate,         // GAP: SOT not in team_statistics → league prior
    clean_sheet_rate: cs != null ? cs : prior.clean_sheet_rate,
    red_card_rate:    prior.red_card_rate,    // GAP: red-card rate not tracked → league prior
  };
}

/**
 * Build the half-time feature vector (or explain why it can't).
 *
 * @param {object} p
 * @param {string} p.league          - league name
 * @param {object} p.homeStats       - team_statistics row for home (form, avgs)
 * @param {object} p.awayStats       - team_statistics row for away
 * @param {object} p.homeElo         - team_elo row { elo, games }
 * @param {object} p.awayElo         - team_elo row { elo, games }
 * @param {number} [p.h2hHomeWinRate]- last-5 H2H home win rate (default 0.45)
 * @param {object} p.live            - { homeGoals, awayGoals, homeReds, awayReds }
 * @returns {{vector:number[]}|{vector:null, reason:string}}
 */
function buildHalftimeVector({ league, homeStats, awayStats, homeElo, awayElo, h2hHomeWinRate, live }) {
  const key = leagueKey(league);
  if (!key) return { vector: null, reason: `unsupported league: ${league}` };

  const hGames = Number(homeElo?.games) || 0;
  const aGames = Number(awayElo?.games) || 0;
  if (hGames < MIN_ELO_GAMES || aGames < MIN_ELO_GAMES) {
    return { vector: null, reason: `insufficient ELO history (home=${hGames}, away=${aGames})` };
  }

  const prior = LEAGUE_PRIORS[key];
  const hForm = teamForm(homeStats, prior);
  const aForm = teamForm(awayStats, prior);
  if (!hForm || !aForm) return { vector: null, reason: 'missing team form' };

  const hElo = Number(homeElo.elo);
  const aElo = Number(awayElo.elo);
  const hg = Number(live?.homeGoals) || 0;
  const ag = Number(live?.awayGoals) || 0;
  const buckets = marginBuckets(hg - ag);

  const f = {
    home_elo: hElo, away_elo: aElo, elo_differential: hElo - aElo,
    home_win_rate_10: hForm.win_rate, home_draw_rate_10: hForm.draw_rate,
    home_goals_scored_10: hForm.goals_scored, home_goals_conceded_10: hForm.goals_conceded,
    home_sot_rate_10: hForm.sot_rate, home_clean_sheet_rate_10: hForm.clean_sheet_rate,
    home_red_card_rate_10: hForm.red_card_rate,
    away_win_rate_10: aForm.win_rate, away_draw_rate_10: aForm.draw_rate,
    away_goals_scored_10: aForm.goals_scored, away_goals_conceded_10: aForm.goals_conceded,
    away_sot_rate_10: aForm.sot_rate, away_clean_sheet_rate_10: aForm.clean_sheet_rate,
    away_red_card_rate_10: aForm.red_card_rate,
    h2h_home_win_rate_5: Number.isFinite(Number(h2hHomeWinRate)) ? Number(h2hHomeWinRate) : 0.45,
    league_epl: key === 'epl' ? 1 : 0,
    league_laliga: key === 'laliga' ? 1 : 0,
    league_bundesliga: key === 'bundesliga' ? 1 : 0,
    league_seriea: key === 'seriea' ? 1 : 0,
    league_ligue1: key === 'ligue1' ? 1 : 0,
    HTHG: hg, HTAG: ag,
    HR: Number(live?.homeReds) || 0, AR: Number(live?.awayReds) || 0,
    ...buckets,
  };

  const vector = FEATURE_ORDER.map(name => {
    const v = f[name];
    return Number.isFinite(v) ? v : 0;
  });
  return { vector };
}

// ---------------------------------------------------------------------------
// PRE-MATCH supermodel (models/supermodel_prematch_v2.onnx)
// ---------------------------------------------------------------------------
// Same ELO + form + H2H block as the half-time vector, MINUS the in-play block,
// and with a SEVEN-league one-hot (adds Allsvenskan + MLS). The pre-match model
// was retrained on those two leagues; the half-time model was NOT, so the two
// paths deliberately use different league encodings and different gates.

// Column order must match models/supermodel_prematch_v2_features.json exactly.
const PREMATCH_LEAGUES = ['epl', 'laliga', 'bundesliga', 'seriea', 'ligue1', 'allsvenskan', 'mls'];
const PREMATCH_FEATURE_ORDER = [
  'home_elo', 'away_elo', 'elo_differential',
  'home_win_rate_10', 'home_draw_rate_10', 'home_goals_scored_10', 'home_goals_conceded_10',
  'home_sot_rate_10', 'home_clean_sheet_rate_10', 'home_red_card_rate_10',
  'away_win_rate_10', 'away_draw_rate_10', 'away_goals_scored_10', 'away_goals_conceded_10',
  'away_sot_rate_10', 'away_clean_sheet_rate_10', 'away_red_card_rate_10',
  'h2h_home_win_rate_5',
  ...PREMATCH_LEAGUES.map(k => `league_${k}`),
];

/** Map a free-text league name to a supported PRE-MATCH key (7 leagues), or null. */
function prematchLeagueKey(name) {
  const key = leagueKey(name); // the 5 big leagues
  if (key) return key;
  const n = (name ?? '').toLowerCase();
  if (/allsvenskan/.test(n)) return 'allsvenskan';
  if (/mls|major league soccer/.test(n)) return 'mls';
  return null;
}

/**
 * Build the 25-dim pre-match feature vector, or explain why it can't. Same
 * honesty gates as buildHalftimeVector (known league, warm ELO, real form) so
 * we only emit a model probability where it is trustworthy.
 */
function buildPrematchVector({ league, homeStats, awayStats, homeElo, awayElo, h2hHomeWinRate }) {
  const key = prematchLeagueKey(league);
  if (!key) return { vector: null, reason: `unsupported league: ${league}` };

  const hGames = Number(homeElo?.games) || 0;
  const aGames = Number(awayElo?.games) || 0;
  if (hGames < MIN_ELO_GAMES || aGames < MIN_ELO_GAMES) {
    return { vector: null, reason: `insufficient ELO history (home=${hGames}, away=${aGames})` };
  }

  const prior = LEAGUE_PRIORS[key];
  const hForm = teamForm(homeStats, prior);
  const aForm = teamForm(awayStats, prior);
  if (!hForm || !aForm) return { vector: null, reason: 'missing team form' };

  const hElo = Number(homeElo.elo);
  const aElo = Number(awayElo.elo);

  const f = {
    home_elo: hElo, away_elo: aElo, elo_differential: hElo - aElo,
    home_win_rate_10: hForm.win_rate, home_draw_rate_10: hForm.draw_rate,
    home_goals_scored_10: hForm.goals_scored, home_goals_conceded_10: hForm.goals_conceded,
    home_sot_rate_10: hForm.sot_rate, home_clean_sheet_rate_10: hForm.clean_sheet_rate,
    home_red_card_rate_10: hForm.red_card_rate,
    away_win_rate_10: aForm.win_rate, away_draw_rate_10: aForm.draw_rate,
    away_goals_scored_10: aForm.goals_scored, away_goals_conceded_10: aForm.goals_conceded,
    away_sot_rate_10: aForm.sot_rate, away_clean_sheet_rate_10: aForm.clean_sheet_rate,
    away_red_card_rate_10: aForm.red_card_rate,
    h2h_home_win_rate_5: Number.isFinite(Number(h2hHomeWinRate)) ? Number(h2hHomeWinRate) : 0.45,
    ...Object.fromEntries(PREMATCH_LEAGUES.map(k => [`league_${k}`, k === key ? 1 : 0])),
  };

  const vector = PREMATCH_FEATURE_ORDER.map(name => {
    const v = f[name];
    return Number.isFinite(v) ? v : 0;
  });
  return { vector };
}

module.exports = {
  buildHalftimeVector, leagueKey, formRates, FEATURE_ORDER, LEAGUE_PRIORS, MIN_ELO_GAMES,
  buildPrematchVector, prematchLeagueKey, PREMATCH_FEATURE_ORDER,
};
