/**
 * features.js — Local Feature Engineering Engine
 *
 * Constructs the tabular feature vector for a fixture entirely from DB aggregates
 * pre-populated by the nightly post-match batch worker (updateMatchStats.js).
 * Zero external API calls at inference time.
 *
 * Feature vector (22 dimensions):
 *   Rolling 10-match window per team (primary):
 *     home_xg_created_10, home_xg_conceded_10, home_ppda_10, home_sot_ratio_10,
 *     home_goals_scored_10, home_goals_conceded_10
 *   Rolling 5-match window per team (recency signal):
 *     home_xg_created_5,  home_xg_conceded_5,  home_ppda_5,  home_sot_ratio_5
 *   Same four 10-match + four 5-match blocks for the away team.
 *   Fixture-level:
 *     rest_days_differential  (home rest days − away rest days, clamped ±14)
 *     is_neutral_venue        (0 | 1)
 *
 * Completeness ∈ [0,1]: fraction of the 20 DB-sourced stat fields that are
 * real data rather than league-wide baselines. Used by computeValues.js to decide
 * whether to trust the ML ensemble over the Dixon-Coles fallback.
 *
 * Usage (within computeValues.js):
 *   const fv = await buildFeatureVector(supabase, match);
 *   if (!fv || fv.completeness < MIN_COMPLETENESS) { /* use Dixon-Coles *\/ }
 */

'use strict';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Total number of dimensions in the feature vector. */
const FEATURE_COUNT = 22;

/**
 * Number of DB-sourced stat fields (used as the denominator in the completeness
 * calculation). Does not include restDiff or isNeutral — those are always derivable.
 */
const STAT_FIELD_COUNT = 20;

/**
 * Minimum data completeness to trust the ML ensemble over Dixon-Coles.
 * 0.60 = at least 60% of stat fields are real data (not baselines).
 */
const MIN_COMPLETENESS = 0.60;

/**
 * League-wide statistical baselines. Used when a team has no cached stats row
 * (promoted clubs, tournament debutants, or first run before stats batch).
 * Calibrated from multi-season European averages. Updated annually.
 *
 * @type {Object.<string, number>}
 */
const LEAGUE_BASELINES = {
  xg_created:    1.30,  // xG generated per match, average team
  xg_conceded:   1.30,  // xG allowed per match, average team
  ppda_index:    9.50,  // passes allowed per defensive action (lower = more press)
  sot_ratio:     0.38,  // shots on target / total shots
  goals_scored:  1.35,
  goals_conceded: 1.35,
};

// ---------------------------------------------------------------------------
// Type definitions (JSDoc)
// ---------------------------------------------------------------------------

/**
 * @typedef {Object} TeamStatsRow
 * @property {string}      team_id
 * @property {number}      roll_window        - 5 or 10
 * @property {string}      as_of              - ISO date
 * @property {number|null} xg_created
 * @property {number|null} xg_conceded
 * @property {number|null} ppda_index
 * @property {number|null} sot_ratio
 * @property {number|null} goals_scored
 * @property {number|null} goals_conceded
 */

/**
 * @typedef {Object} MatchInput
 * @property {string|null}  home_team_id
 * @property {string|null}  away_team_id
 * @property {string|null}  kickoff_at     - ISO timestamp
 * @property {boolean}      [is_neutral]
 * @property {{ name?: string }} [league]
 */

/**
 * @typedef {Object} FeatureVector
 * @property {number[]}  features      - 22-dimensional array (see FEATURE_COUNT)
 * @property {string[]}  featureNames  - Human-readable label per dimension
 * @property {number}    completeness  - Fraction [0,1] of real vs. baseline fields
 */

/**
 * @typedef {{ count: number }} FieldCounter
 * Mutable counter threaded through fillStat calls to tally real DB values.
 */

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Reads one stat field from a stats row. When the field is present and numeric,
 * increments the shared FieldCounter and returns the parsed value. Falls back to
 * the given baseline so the feature vector is always fully populated.
 *
 * @param {TeamStatsRow|null} stats
 * @param {string}            key       - Column name in team_stats_cache
 * @param {number}            baseline  - LEAGUE_BASELINES fallback
 * @param {FieldCounter}      counter   - Mutated in place when real data is used
 * @returns {number}
 */
function fillStat(stats, key, baseline, counter) {
  const raw = stats?.[key];
  const v = raw != null ? Number(raw) : NaN;
  if (Number.isFinite(v)) {
    counter.count++;
    return v;
  }
  return baseline;
}

// ---------------------------------------------------------------------------
// DB queries (each fires exactly once per buildFeatureVector call)
// ---------------------------------------------------------------------------

/**
 * Fetch the most recent rolling-window stats row for one team.
 * Returns null if no cached row exists (caller uses LEAGUE_BASELINES).
 *
 * @param {import('@supabase/supabase-js').SupabaseClient} supabase
 * @param {string} teamId
 * @param {5|10}   rollWindow
 * @returns {Promise<TeamStatsRow|null>}
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
 * Fetch the kickoff timestamp of the team's most recent completed fixture
 * before `beforeDate`. Used to compute rest days.
 *
 * @param {import('@supabase/supabase-js').SupabaseClient} supabase
 * @param {string} teamId
 * @param {string} beforeDate - ISO timestamp; only matches before this count
 * @returns {Promise<string|null>} ISO kickoff timestamp or null
 */
async function fetchLastKickoff(supabase, teamId, beforeDate) {
  const { data } = await supabase
    .from('matches')
    .select('kickoff_at')
    .or(`home_team_id.eq.${teamId},away_team_id.eq.${teamId}`)
    .lt('kickoff_at', beforeDate)
    .not('result', 'is', null)
    .order('kickoff_at', { ascending: false })
    .limit(1)
    .maybeSingle();

  return data?.kickoff_at ?? null;
}

// ---------------------------------------------------------------------------
// Main export
// ---------------------------------------------------------------------------

/**
 * Build the 22-dimensional feature vector for a fixture.
 *
 * All 6 DB sub-queries fire in parallel (Promise.all) so the I/O cost is one
 * network RTT per call, not 6. When called from inside a concurrency pool in
 * computeValues.js, multiple fixtures run concurrently — the total parallelism
 * is pool_size × 6 queries but each one is small and index-backed.
 *
 * Returns null only if home_team_id or away_team_id is missing from the row;
 * in all other cases a fully-populated vector is returned (using baselines where
 * real data is absent), along with the completeness fraction so the caller can
 * decide whether to trust the ML ensemble.
 *
 * @param {import('@supabase/supabase-js').SupabaseClient} supabase
 * @param {MatchInput} match
 * @returns {Promise<FeatureVector|null>}
 */
async function buildFeatureVector(supabase, match) {
  const { home_team_id, away_team_id, kickoff_at } = match;
  if (!home_team_id || !away_team_id) return null;

  const kickoffDate = new Date(kickoff_at ?? Date.now()).toISOString();

  // Six queries in parallel: two roll windows × two teams + two last kickoffs.
  const [h10, h5, a10, a5, homeLastKick, awayLastKick] = await Promise.all([
    fetchTeamStats(supabase, home_team_id, 10),
    fetchTeamStats(supabase, home_team_id, 5),
    fetchTeamStats(supabase, away_team_id, 10),
    fetchTeamStats(supabase, away_team_id, 5),
    fetchLastKickoff(supabase, home_team_id, kickoffDate),
    fetchLastKickoff(supabase, away_team_id, kickoffDate),
  ]);

  /** @type {FieldCounter} */
  const counter = { count: 0 };

  // 10-match home window (6 fields)
  const h_xgC_10  = fillStat(h10, 'xg_created',    LEAGUE_BASELINES.xg_created,    counter);
  const h_xgA_10  = fillStat(h10, 'xg_conceded',   LEAGUE_BASELINES.xg_conceded,   counter);
  const h_ppda_10 = fillStat(h10, 'ppda_index',     LEAGUE_BASELINES.ppda_index,    counter);
  const h_sot_10  = fillStat(h10, 'sot_ratio',      LEAGUE_BASELINES.sot_ratio,     counter);
  const h_gS_10   = fillStat(h10, 'goals_scored',   LEAGUE_BASELINES.goals_scored,  counter);
  const h_gC_10   = fillStat(h10, 'goals_conceded', LEAGUE_BASELINES.goals_conceded, counter);

  // 5-match home window (4 fields)
  const h_xgC_5   = fillStat(h5, 'xg_created',  LEAGUE_BASELINES.xg_created,  counter);
  const h_xgA_5   = fillStat(h5, 'xg_conceded', LEAGUE_BASELINES.xg_conceded, counter);
  const h_ppda_5  = fillStat(h5, 'ppda_index',  LEAGUE_BASELINES.ppda_index,  counter);
  const h_sot_5   = fillStat(h5, 'sot_ratio',   LEAGUE_BASELINES.sot_ratio,   counter);

  // 10-match away window (6 fields)
  const a_xgC_10  = fillStat(a10, 'xg_created',    LEAGUE_BASELINES.xg_created,    counter);
  const a_xgA_10  = fillStat(a10, 'xg_conceded',   LEAGUE_BASELINES.xg_conceded,   counter);
  const a_ppda_10 = fillStat(a10, 'ppda_index',     LEAGUE_BASELINES.ppda_index,    counter);
  const a_sot_10  = fillStat(a10, 'sot_ratio',      LEAGUE_BASELINES.sot_ratio,     counter);
  const a_gS_10   = fillStat(a10, 'goals_scored',   LEAGUE_BASELINES.goals_scored,  counter);
  const a_gC_10   = fillStat(a10, 'goals_conceded', LEAGUE_BASELINES.goals_conceded, counter);

  // 5-match away window (4 fields)
  const a_xgC_5   = fillStat(a5, 'xg_created',  LEAGUE_BASELINES.xg_created,  counter);
  const a_xgA_5   = fillStat(a5, 'xg_conceded', LEAGUE_BASELINES.xg_conceded, counter);
  const a_ppda_5  = fillStat(a5, 'ppda_index',  LEAGUE_BASELINES.ppda_index,  counter);
  const a_sot_5   = fillStat(a5, 'sot_ratio',   LEAGUE_BASELINES.sot_ratio,   counter);

  // Derived: rest days differential (clamped ±14, never from DB so not counted)
  const now      = new Date(kickoffDate).getTime();
  const homeRest = homeLastKick
    ? Math.round((now - new Date(homeLastKick).getTime()) / 864e5)
    : 7;
  const awayRest = awayLastKick
    ? Math.round((now - new Date(awayLastKick).getTime()) / 864e5)
    : 7;
  const restDiff = Math.min(Math.max(homeRest - awayRest, -14), 14);

  // Derived: neutral venue flag (not from DB, always available)
  const isNeutral = (
    match.league?.name?.includes('World Cup') ||
    match.league?.name?.includes('Euro') ||
    match.is_neutral
  ) ? 1 : 0;

  const features = [
    h_xgC_10,  h_xgA_10,  h_ppda_10, h_sot_10,  h_gS_10, h_gC_10,
    h_xgC_5,   h_xgA_5,   h_ppda_5,  h_sot_5,
    a_xgC_10,  a_xgA_10,  a_ppda_10, a_sot_10,  a_gS_10, a_gC_10,
    a_xgC_5,   a_xgA_5,   a_ppda_5,  a_sot_5,
    restDiff,
    isNeutral,
  ];

  const featureNames = [
    'home_xg_created_10',   'home_xg_conceded_10', 'home_ppda_10', 'home_sot_ratio_10',
    'home_goals_scored_10', 'home_goals_conceded_10',
    'home_xg_created_5',    'home_xg_conceded_5',  'home_ppda_5',  'home_sot_ratio_5',
    'away_xg_created_10',   'away_xg_conceded_10', 'away_ppda_10', 'away_sot_ratio_10',
    'away_goals_scored_10', 'away_goals_conceded_10',
    'away_xg_created_5',    'away_xg_conceded_5',  'away_ppda_5',  'away_sot_ratio_5',
    'rest_days_differential',
    'is_neutral_venue',
  ];

  if (features.length !== FEATURE_COUNT) {
    throw new Error(`buildFeatureVector: expected ${FEATURE_COUNT} features, got ${features.length}`);
  }

  return {
    features,
    featureNames,
    completeness: counter.count / STAT_FIELD_COUNT,
  };
}

module.exports = {
  buildFeatureVector,
  fetchTeamStats,
  fetchLastKickoff,
  fillStat,
  MIN_COMPLETENESS,
  FEATURE_COUNT,
  STAT_FIELD_COUNT,
  LEAGUE_BASELINES,
};
