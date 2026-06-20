/**
 * features.js — Local Feature Engineering Engine
 *
 * Constructs the tabular feature vector for a fixture entirely from DB aggregates
 * pre-populated by the nightly post-match batch worker (updateMatchStats.js).
 * Zero external API calls at inference time.
 *
 * Feature vector (22 dimensions):
 *   Rolling 10-match window per team (primary):
 *     home_xg_created_10, home_xg_conceded_10, home_ppda_10, home_sot_ratio_10
 *     away_xg_created_10, away_xg_conceded_10, away_ppda_10, away_sot_ratio_10
 *   Rolling 5-match window per team (recency signal):
 *     home_xg_created_5,  home_xg_conceded_5,  home_ppda_5,  home_sot_ratio_5
 *     away_xg_created_5,  away_xg_conceded_5,  away_ppda_5,  away_sot_ratio_5
 *   Fixture-level:
 *     rest_days_differential  (home rest days − away rest days)
 *     is_neutral_venue        (0 | 1)
 *     home_goals_scored_10,   home_goals_conceded_10
 *     away_goals_scored_10,   away_goals_conceded_10
 *
 * Returns { features, completeness } where completeness ∈ [0,1] reflects what
 * fraction of fields are real data vs. league-wide fallback baselines.
 * When completeness < MIN_COMPLETENESS the caller should fall back to Dixon-Coles.
 */

'use strict';

// Minimum data completeness to trust the ML ensemble over Dixon-Coles.
// 0.6 = at least 60% of feature dimensions are real data (not baselines).
const MIN_COMPLETENESS = 0.60;

// ── League-wide statistical baselines (fallback for promoted / new teams) ─────
// Calibrated from multi-season European averages. Updated annually.
const LEAGUE_BASELINES = {
  xg_created:    1.30,   // xG generated per match, average team
  xg_conceded:   1.30,   // xG allowed per match, average team
  ppda_index:    9.50,   // passes allowed per defensive action (lower = more press)
  sot_ratio:     0.38,   // shots on target / total shots
  goals_scored:  1.35,
  goals_conceded: 1.35,
};

/**
 * Fetch rolling window stats for a single team from team_stats_cache.
 * Returns null if no cached row exists (caller uses LEAGUE_BASELINES).
 */
async function fetchTeamStats(supabase, teamId, rollWindow) {
  const { data, error } = await supabase
    .from('team_stats_cache')
    .select('*')
    .eq('team_id', teamId)
    .eq('roll_window', rollWindow)
    .order('as_of', { ascending: false })
    .limit(1)
    .maybeSingle();

  if (error || !data) return null;
  return data;
}

/**
 * Fetch the most recent fixture for a team (to compute rest days).
 */
async function fetchLastKickoff(supabase, teamId, beforeDate) {
  const { data } = await supabase
    .from('matches')
    .select('kickoff_at')
    .or(`home_team_id.eq.${teamId},away_team_id.eq.${teamId}`)
    .lt('kickoff_at', beforeDate)
    .not('result', 'is', null)       // only count completed matches
    .order('kickoff_at', { ascending: false })
    .limit(1)
    .maybeSingle();

  return data?.kickoff_at ?? null;
}

/**
 * Build the feature vector for a fixture.
 *
 * @param {object} supabase  - Supabase client
 * @param {object} match     - match row with home_team_id, away_team_id, kickoff_at, league
 * @returns {{ features: number[], featureNames: string[], completeness: number } | null}
 */
async function buildFeatureVector(supabase, match) {
  const { home_team_id, away_team_id, kickoff_at } = match;
  if (!home_team_id || !away_team_id) return null;

  const kickoffDate = new Date(kickoff_at ?? Date.now()).toISOString();

  // ── Fetch rolling stats for both windows ────────────────────────────────
  const [h10, h5, a10, a5, homeLastKick, awayLastKick] = await Promise.all([
    fetchTeamStats(supabase, home_team_id, 10),
    fetchTeamStats(supabase, home_team_id, 5),
    fetchTeamStats(supabase, away_team_id, 10),
    fetchTeamStats(supabase, away_team_id, 5),
    fetchLastKickoff(supabase, home_team_id, kickoffDate),
    fetchLastKickoff(supabase, away_team_id, kickoffDate),
  ]);

  // ── Fill missing values with league baselines ────────────────────────────
  let realFields = 0;
  const totalFields = 20; // xg/ppda/sot_ratio × 4 windows × 4 stats + 2 goals pairs + rest

  function fill(stats, key, baseline) {
    const v = stats?.[key];
    if (v != null && !isNaN(Number(v))) { realFields++; return Number(v); }
    return baseline;
  }

  // 10-match home
  const h_xgC_10  = fill(h10, 'xg_created',    LEAGUE_BASELINES.xg_created);
  const h_xgA_10  = fill(h10, 'xg_conceded',   LEAGUE_BASELINES.xg_conceded);
  const h_ppda_10 = fill(h10, 'ppda_index',     LEAGUE_BASELINES.ppda_index);
  const h_sot_10  = fill(h10, 'sot_ratio',      LEAGUE_BASELINES.sot_ratio);
  const h_gS_10   = fill(h10, 'goals_scored',   LEAGUE_BASELINES.goals_scored);
  const h_gC_10   = fill(h10, 'goals_conceded', LEAGUE_BASELINES.goals_conceded);

  // 5-match home
  const h_xgC_5   = fill(h5, 'xg_created',    LEAGUE_BASELINES.xg_created);
  const h_xgA_5   = fill(h5, 'xg_conceded',   LEAGUE_BASELINES.xg_conceded);
  const h_ppda_5  = fill(h5, 'ppda_index',     LEAGUE_BASELINES.ppda_index);
  const h_sot_5   = fill(h5, 'sot_ratio',      LEAGUE_BASELINES.sot_ratio);

  // 10-match away
  const a_xgC_10  = fill(a10, 'xg_created',    LEAGUE_BASELINES.xg_created);
  const a_xgA_10  = fill(a10, 'xg_conceded',   LEAGUE_BASELINES.xg_conceded);
  const a_ppda_10 = fill(a10, 'ppda_index',     LEAGUE_BASELINES.ppda_index);
  const a_sot_10  = fill(a10, 'sot_ratio',      LEAGUE_BASELINES.sot_ratio);
  const a_gS_10   = fill(a10, 'goals_scored',   LEAGUE_BASELINES.goals_scored);
  const a_gC_10   = fill(a10, 'goals_conceded', LEAGUE_BASELINES.goals_conceded);

  // 5-match away
  const a_xgC_5   = fill(a5, 'xg_created',    LEAGUE_BASELINES.xg_created);
  const a_xgA_5   = fill(a5, 'xg_conceded',   LEAGUE_BASELINES.xg_conceded);
  const a_ppda_5  = fill(a5, 'ppda_index',     LEAGUE_BASELINES.ppda_index);
  const a_sot_5   = fill(a5, 'sot_ratio',      LEAGUE_BASELINES.sot_ratio);

  // Rest days differential
  const now = new Date(kickoffDate).getTime();
  const homeRest = homeLastKick ? Math.round((now - new Date(homeLastKick).getTime()) / 864e5) : 7;
  const awayRest = awayLastKick ? Math.round((now - new Date(awayLastKick).getTime()) / 864e5) : 7;
  const restDiff = Math.min(Math.max(homeRest - awayRest, -14), 14); // clamp ±14 days

  // Neutral venue
  const isNeutral = match.league?.name?.includes('World Cup') ||
    match.league?.name?.includes('Euro') ||
    match.is_neutral ? 1 : 0;

  const features = [
    h_xgC_10,  h_xgA_10,  h_ppda_10, h_sot_10,  h_gS_10, h_gC_10,
    h_xgC_5,   h_xgA_5,   h_ppda_5,  h_sot_5,
    a_xgC_10,  a_xgA_10,  a_ppda_10, a_sot_10,  a_gS_10, a_gC_10,
    a_xgC_5,   a_xgA_5,   a_ppda_5,  a_sot_5,
    restDiff,
    isNeutral,
  ];

  const featureNames = [
    'home_xg_created_10',  'home_xg_conceded_10', 'home_ppda_10', 'home_sot_ratio_10',
    'home_goals_scored_10','home_goals_conceded_10',
    'home_xg_created_5',   'home_xg_conceded_5',  'home_ppda_5',  'home_sot_ratio_5',
    'away_xg_created_10',  'away_xg_conceded_10', 'away_ppda_10', 'away_sot_ratio_10',
    'away_goals_scored_10','away_goals_conceded_10',
    'away_xg_created_5',   'away_xg_conceded_5',  'away_ppda_5',  'away_sot_ratio_5',
    'rest_days_differential',
    'is_neutral_venue',
  ];

  const completeness = realFields / totalFields;

  return { features, featureNames, completeness };
}

module.exports = { buildFeatureVector, MIN_COMPLETENESS, LEAGUE_BASELINES };
