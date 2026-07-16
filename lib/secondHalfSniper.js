'use strict';

/**
 * lib/secondHalfSniper.js — the "Second Half Sniper" in-play signal.
 *
 * A half-time trigger: at the break, on a still-hot (low-scoring) scoreline in a
 * match where goals were expected pre-match, back Over goals (1.5 / 2.5) when the
 * live Over price beats the model's own P(final total > line). This is the
 * detection half of the product; the "first-goal exit / no-goal stop-loss" is
 * trade management handled downstream (a bot), not signal generation.
 *
 * Model: goalsOverProb() holds the frozen pre-match goal expectation (the
 * inplay_baseline λ, the same anchor the win-prob stage uses) against the current
 * score at the break. edge = p_model · live_over_odds − 1, exactly like every
 * other in-play stage. Pure and side-effect free (tested in engine.sniper.test.js);
 * DB access lives in computeInplayValues.js.
 *
 * Single entry per fixture: the value_signals dedup index is keyed on
 * (match, market, outcome, model) and NOT on the line, so every configured Over
 * line is evaluated but AT MOST ONE candidate — the highest-EV Over — is emitted.
 * That matches the product ("a single entry on a hot scoreline") and keeps the
 * two lines from colliding on the unique index.
 */

const { goalsOverProb } = require('./inplayWinProb');
const { bestTotalsByLine, inplayEdge } = require('./inplay');

// Over lines to consider at the break — "Over 1.5 / 2.5" on the card.
const SNIPER_LINES = (process.env.SNIPER_LINES || '1.5,2.5')
  .split(',').map(Number).filter(Number.isFinite);
// Half-time trigger window (elapsed minutes). API-Football reports elapsed≈45
// across the interval and into the restart; a small band catches the break even
// though the in-play cron only ticks every few minutes.
const SNIPER_MIN_MINUTE = parseInt(process.env.SNIPER_MIN_MINUTE || '44', 10);
const SNIPER_MAX_MINUTE = parseInt(process.env.SNIPER_MAX_MINUTE || '52', 10);
// "Hot scoreline": at most this many goals at the break (0 or 1 → both Over 1.5
// and Over 2.5 are still fully live). A 2-2 at HT is not a sniper spot.
const SNIPER_HOT_MAX_GOALS = parseInt(process.env.SNIPER_HOT_MAX_GOALS || '1', 10);
// Only fire where goals were expected pre-match: λ_home + λ_away ≥ this. Guards
// against sniping a low-scoring grind where the Over was never on.
const SNIPER_MIN_MATCH_XG = parseFloat(process.env.SNIPER_MIN_MATCH_XG || '2.3');

/** Is `minute` inside the half-time trigger window? */
function isHalftimeWindow(minute, min = SNIPER_MIN_MINUTE, max = SNIPER_MAX_MINUTE) {
  const m = Number(minute);
  return Number.isFinite(m) && m >= min && m <= max;
}

/**
 * Second Half Sniper candidates for one live match. Returns AT MOST ONE
 * value_signals candidate (totals / over), or [] when the fixture is not a
 * half-time sniper spot (wrong minute, cooled-off scoreline, goals-light game,
 * no baseline, no live Over price, or no positive edge).
 *
 * @param {object} match     live match with .odds, goals_home/away, minute, id
 * @param {object} baseline  inplay_baseline row { lambda_home, lambda_away }
 * @param {object} opts      threshold + gating overrides (see defaults above)
 * @returns {Array<object>}  0 or 1 candidate, phase='inplay'
 */
function sniperCandidates(match, baseline, opts = {}) {
  const evThreshold = opts.evThreshold ?? 0.02;
  const maxEdge     = opts.maxEdge ?? 0.20;
  const lines       = opts.lines ?? SNIPER_LINES;
  const hotMaxGoals = opts.hotMaxGoals ?? SNIPER_HOT_MAX_GOALS;
  const minMatchXg  = opts.minMatchXg ?? SNIPER_MIN_MATCH_XG;

  if (!baseline) return [];
  const lambdaHome = Number(baseline.lambda_home);
  const lambdaAway = Number(baseline.lambda_away);
  if (!Number.isFinite(lambdaHome) || !Number.isFinite(lambdaAway)) return [];
  if (lambdaHome + lambdaAway < minMatchXg) return [];        // goals not expected — not a sniper spot

  if (!isHalftimeWindow(match.minute, opts.minMinute, opts.maxMinute)) return [];

  const gh = Math.max(0, Math.round(Number(match.goals_home) || 0));
  const ga = Math.max(0, Math.round(Number(match.goals_away) || 0));
  const currentTotal = gh + ga;
  if (currentTotal > hotMaxGoals) return [];                  // scoreline already cooled off

  const byLine = bestTotalsByLine(match.odds);
  let best = null;
  for (const line of lines) {
    if (line <= currentTotal) continue;                       // line already settled — never back a dead Over
    const priced = byLine.get(line);
    if (!priced || !priced.over) continue;                    // no live Over price at this line
    const p = goalsOverProb({ lambdaHome, lambdaAway, homeGoals: gh, awayGoals: ga, minute: match.minute, line });
    const edge = inplayEdge(p, priced.over.odds);
    if (edge == null || edge < evThreshold || edge > maxEdge) continue;
    if (!best || edge > best.detected_edge) {
      best = {
        match_id:           match.id,
        market:             'totals',
        market_line:        line,
        outcome:            'over',
        detected_odds:      priced.over.odds,
        detected_edge:      edge,
        detected_mes:       null,
        bookmaker:          priced.over.book ?? null,
        kickoff_at:         match.kickoff_at ?? null,
        model_architecture: 'SECOND_HALF_SNIPER',
        model_prob:         p,
        phase:              'inplay',
      };
    }
  }
  return best ? [best] : [];
}

module.exports = {
  sniperCandidates,
  isHalftimeWindow,
  SNIPER_LINES,
  SNIPER_MIN_MINUTE,
  SNIPER_MAX_MINUTE,
  SNIPER_HOT_MAX_GOALS,
  SNIPER_MIN_MATCH_XG,
};
