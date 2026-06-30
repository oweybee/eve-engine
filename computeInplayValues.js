'use strict';

/**
 * computeInplayValues.js — In-play value detection engine.
 *
 * Sibling of computeValues.js, but for matches that have already kicked off.
 * Everything it writes is stamped phase='inplay', so it is measured by its own
 * performance row (yield / strike-rate, NO CLV) and never touches the pre-match
 * CLV headline. See README "In-play signals".
 *
 * Two stages, run in order (both gated independently):
 *
 *   STAGE 1 — Book-lag (MARKET_CONSENSUS, default ON)
 *     Re-runs the exact Kaunitz consensus engine (reused from computeValues.js)
 *     on LIVE odds. Fires only when one book trails the live crowd. This is
 *     latency arbitrage between books — real but shallow.
 *
 *   STAGE 2 — Model-vs-market (SUPERMODEL_HALFTIME, default OFF)
 *     The differentiator: hold an INDEPENDENT live probability from the
 *     half-time supermodel against the drifted live price. This is what can flag
 *     "the market overreacted to the goal — the favourite is still value".
 *     Gated behind INPLAY_MODEL_ENABLED=true because it needs a live feature
 *     vector at training parity (ELO + form + H2H + league OHE + HT state); the
 *     builder below sources what the DB has and SKIPS (never guesses) when the
 *     vector is incomplete, so it can be switched on safely once a parity
 *     feature service exists. Until then it is a no-op even when enabled.
 *
 * Prerequisite: ingestLiveOdds.js must have written current live odds (and
 * matches.status='live' + current score/minute) for the fixtures in play.
 */

const { getClient } = require('./lib/supabaseClient');
const inplay         = require('./lib/inplay');
const sm             = require('./lib/secondaryMarkets');
const { buildHalftimeVector } = require('./lib/halftimeFeatures');
const {
  fetchMatchesForComputation,
  computeMatch,
  upsertComputedValues,
  insertValueSignals,
  insertSecondarySignals,
  fetchStatsLookups,
} = require('./computeValues');

const COMPUTE_CONCURRENCY = parseInt(process.env.COMPUTE_CONCURRENCY || '5', 10);
const INPLAY_MODEL_ENABLED = (process.env.INPLAY_MODEL_ENABLED || '').toLowerCase() === 'true';
const INPLAY_EV_THRESHOLD  = parseFloat(process.env.INPLAY_EV_THRESHOLD || process.env.EV_THRESHOLD || '0.02');
// Out-of-distribution / miscalibration guard: reject implausibly large model
// edges (mirrors MAX_PLAUSIBLE_EDGE in computeApiValues.js). An in-play model
// "edge" above this is almost always a calibration artefact, not real value.
const INPLAY_MAX_EDGE = parseFloat(process.env.INPLAY_MAX_EDGE || '0.20');

const normTeam = s => (s ?? '').toLowerCase().replace(/[^a-z0-9]/g, '');

/** Live matches = kicked off and inside the live window (status may lag). */
async function fetchLiveMatches(supabase) {
  const candidates = await fetchMatchesForComputation(supabase, ['scheduled', 'live']);
  const now = Date.now();
  return candidates.filter(m => {
    const ko = m.kickoff_at ? new Date(m.kickoff_at).getTime() : NaN;
    return inplay.isWithinLiveWindow(ko, now);
  });
}

async function withPool(items, fn, concurrency) {
  const results = [];
  for (let start = 0; start < items.length; start += concurrency) {
    const settled = await Promise.allSettled(items.slice(start, start + concurrency).map(fn));
    for (const s of settled) {
      results.push(s.status === 'fulfilled' ? s.value : null);
      if (s.status === 'rejected') console.error('[inplay] match error:', s.reason?.message);
    }
  }
  return results;
}

// ── STAGE 2: model-vs-market (gated) ─────────────────────────────────────────

const normTeam2 = s => (s ?? '').toLowerCase().replace(/[^a-z0-9]/g, '');

/** team_elo lookup keyed by normalised team name for these matches. */
async function fetchEloLookup(supabase) {
  const map = new Map();
  const { data, error } = await supabase.from('team_elo').select('team_name, elo, games');
  if (error) { console.warn('[inplay] team_elo read failed:', error.message); return map; }
  for (const r of data ?? []) map.set(r.team_name, r);
  return map;
}

/**
 * Build the 32-feature half-time supermodel vector for a live match from DB
 * data, at training parity. Delegates the parity logic + honesty gates to
 * lib/halftimeFeatures.js: it returns null (with a logged reason) for
 * out-of-distribution fixtures (unsupported league, cold-start ELO, missing
 * form) rather than guessing — so Stage 2 only fires where it is trustworthy.
 *
 * @returns {number[]|null}
 */
function buildHalftimeFeatures(match, ctx) {
  const hKey = normTeam2(match.home_team?.name);
  const aKey = normTeam2(match.away_team?.name);
  const { vector, reason } = buildHalftimeVector({
    league:    match.league?.name,
    homeStats: ctx.statsByName.get(hKey),
    awayStats: ctx.statsByName.get(aKey),
    homeElo:   ctx.eloByName.get(hKey),
    awayElo:   ctx.eloByName.get(aKey),
    // H2H last-5 not yet materialised in production → trainer's cold-start
    // prior (0.45) inside the builder. Low-weight feature; documented gap.
    h2hHomeWinRate: undefined,
    live: {
      homeGoals: match.goals_home, awayGoals: match.goals_away,
      homeReds: 0, awayReds: 0,   // GAP: live red cards not ingested → 0
    },
  });
  if (!vector) {
    console.log(`[inplay] model skip ${match.home_team?.name} v ${match.away_team?.name}: ${reason}`);
    return null;
  }
  return vector;
}

/**
 * Stage 2 for a single live match: run the supermodel and emit a model-vs-market
 * signal when the independent probability beats the live price. Reads the live
 * price directly (single source is enough — does NOT require the multi-book
 * consensus, which is the whole point of holding our own opinion against it).
 *
 * @returns {Array<object>} value_signals candidates (phase='inplay')
 */
async function modelVsMarket(match, ctx) {
  let infer;
  try {
    infer = require('./ensemble/inference');
  } catch {
    return [];
  }
  if (!infer.ensembleAvailable?.()) return [];

  const features = buildHalftimeFeatures(match, ctx);
  if (!features) return []; // out of distribution / insufficient data — dormant

  const probs = await infer.supermodelHalftimeInference(features);
  if (!probs) return [];

  const best = inplay.bestH2hOdds(match.odds);
  const candidates = [];
  for (const outcome of ['home', 'draw', 'away']) {
    const live = best[outcome];
    if (!live) continue;
    const edge = inplay.inplayEdge(probs[outcome], live.odds);
    if (edge == null || edge < INPLAY_EV_THRESHOLD) continue;
    if (edge > INPLAY_MAX_EDGE) {
      console.log(`[inplay] reject ${match.home_team?.name} ${outcome} edge=${edge} > max ${INPLAY_MAX_EDGE} (likely miscalibration)`);
      continue;
    }
    candidates.push({
      match_id:           match.id,
      outcome,
      detected_odds:      live.odds,
      detected_edge:      edge,
      detected_mes:       null,
      bookmaker:          live.book ?? null,
      kickoff_at:         match.kickoff_at ?? null,
      model_architecture: 'SUPERMODEL_HALFTIME',
      signal_category:    'InPlay',
      phase:              'inplay',
    });
  }
  return candidates;
}

async function insertModelSignals(supabase, candidates) {
  if (!candidates.length) return 0;
  // Same widened dedup key as the secondary path: one signal per
  // (match, market, outcome, model). The unique index handles collisions.
  const { error } = await supabase
    .from('value_signals')
    .insert(candidates.map(c => ({ market: 'h2h', ...c })));
  if (error && !/duplicate key/i.test(error.message)) {
    throw new Error(`insertModelSignals: ${error.message}`);
  }
  return candidates.length;
}

// ── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  const supabase = getClient();
  console.log('[inplay] computeInplayValues — book-lag consensus + model-vs-market');
  console.log(`[inplay] model_stage=${INPLAY_MODEL_ENABLED ? 'enabled' : 'disabled'} ev_threshold=${INPLAY_EV_THRESHOLD}`);

  const matches = await fetchLiveMatches(supabase);
  if (!matches.length) {
    console.log('[inplay] no live matches with odds — done');
    return;
  }
  console.log(`[inplay] processing ${matches.length} live match(es)`);

  // STAGE 1 — book-lag consensus (reuses the pre-match compute core)
  const results = await withPool(matches, computeMatch, COMPUTE_CONCURRENCY);
  const live = results.filter(r => r && !r.skipped);

  const computedRows = live.map(r => r.row);
  const valueRows    = live.filter(r => r.hasValue).map(r => r.row);
  console.log(`[inplay] computed=${live.length} value=${valueRows.length}`);

  if (computedRows.length) await upsertComputedValues(supabase, computedRows);
  if (valueRows.length)    await insertValueSignals(supabase, valueRows, 'inplay');

  // Secondary live markets (O/U, BTTS, …) priced off the live consensus.
  try {
    const { statsByName, refByName } = await fetchStatsLookups(supabase, live.map(r => r.match));
    const secondary = [];
    for (const r of live) {
      const hs = statsByName.get(normTeam(r.match.home_team?.name));
      const as = statsByName.get(normTeam(r.match.away_team?.name));
      const rs = r.match.referee ? refByName.get(r.match.referee) : null;
      for (const c of sm.buildSecondarySignals(r.match, r.consensus, hs, as, rs)) {
        secondary.push({ ...c, kickoff_at: r.match.kickoff_at ?? null });
      }
    }
    if (secondary.length) await insertSecondarySignals(supabase, secondary, 'inplay');
  } catch (err) {
    console.error('[inplay] secondary pricing failed (1X2 unaffected):', err.message);
  }

  // STAGE 2 — model-vs-market (gated)
  if (INPLAY_MODEL_ENABLED) {
    try {
      // Shared lookups: team form (team_statistics) + ELO ladder (team_elo).
      const { statsByName } = await fetchStatsLookups(supabase, matches);
      const eloByName = await fetchEloLookup(supabase);
      const ctx = { statsByName, eloByName };

      // Loop over ALL live matches (not just consensus-passed ones): the model
      // stage needs only a single live price, so it works even where Stage 1's
      // multi-book consensus could not form.
      const modelCandidates = [];
      for (const m of matches) {
        modelCandidates.push(...await modelVsMarket(m, ctx));
      }
      const n = await insertModelSignals(supabase, modelCandidates);
      console.log(`[inplay] model-vs-market signals: ${n}`);
    } catch (err) {
      console.error('[inplay] model stage failed:', err.message);
    }
  }

  console.log('[inplay] done');
}

if (require.main === module) {
  main().catch(err => { console.error('[inplay] fatal:', err.message); process.exit(1); });
}

module.exports = { fetchLiveMatches, modelVsMarket, buildHalftimeFeatures, insertModelSignals };
