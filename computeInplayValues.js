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
const { categoryFor } = require('./lib/signalTier');
const sm             = require('./lib/secondaryMarkets');
const { buildHalftimeVector } = require('./lib/halftimeFeatures');
const { liveWinProb } = require('./lib/inplayWinProb');
const { sniperCandidates } = require('./lib/secondHalfSniper');
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

// Win-probability stage (Phase 2) — the competition-agnostic engine that serves
// internationals. Independent flag so it can roll out separately from the
// (top-5-league) supermodel stage.
const INPLAY_WINPROB_ENABLED = (process.env.INPLAY_WINPROB_ENABLED || '').toLowerCase() === 'true';
// Second Half Sniper (Stage 4) — half-time Over 1.5/2.5 on a hot scoreline.
// Independent flag; reuses the same inplay_baseline anchor as the win-prob stage.
const SECOND_HALF_SNIPER_ENABLED = (process.env.SECOND_HALF_SNIPER_ENABLED || '').toLowerCase() === 'true';
// Skip the chaotic closing minutes: thin liquidity + stoppage-time noise, and
// the model's constant-λ assumption is weakest there.
const INPLAY_WINPROB_MINUTE_CAP = parseInt(process.env.INPLAY_WINPROB_MINUTE_CAP || '85', 10);

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
      signal_category:    categoryFor({ odds: live.odds, edge }),
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

// ── STAGE 3: win-probability (competition-agnostic; serves internationals) ────

/**
 * Build win-prob value candidates for one live match against its frozen
 * pre-match baseline. Pure (no I/O) so it is unit-tested. Holds
 * liveWinProb(λ, current score, minute) against the best live price.
 *
 * @param {object} match     - live match with .odds, goals_home/away, minute
 * @param {object} baseline  - inplay_baseline row { lambda_home, lambda_away }
 * @param {object} opts      - { evThreshold, maxEdge, minuteCap }
 * @returns {Array<object>} value_signals candidates (phase='inplay')
 */
function winProbCandidates(match, baseline, opts = {}) {
  const evThreshold = opts.evThreshold ?? INPLAY_EV_THRESHOLD;
  const maxEdge     = opts.maxEdge ?? INPLAY_MAX_EDGE;
  const minuteCap   = opts.minuteCap ?? INPLAY_WINPROB_MINUTE_CAP;

  if (!baseline) return [];
  const lambdaHome = Number(baseline.lambda_home);
  const lambdaAway = Number(baseline.lambda_away);
  if (!Number.isFinite(lambdaHome) || !Number.isFinite(lambdaAway)) return [];

  const minute = Number(match.minute);
  if (!Number.isFinite(minute)) return [];      // no live clock yet — skip
  if (minute >= minuteCap) return [];           // chaotic closing minutes — skip

  const probs = liveWinProb({
    lambdaHome, lambdaAway,
    homeGoals: match.goals_home, awayGoals: match.goals_away, minute,
  });

  const best = inplay.bestH2hOdds(match.odds);
  const candidates = [];
  for (const outcome of ['home', 'draw', 'away']) {
    const live = best[outcome];
    if (!live) continue;
    const edge = inplay.inplayEdge(probs[outcome], live.odds);
    if (edge == null || edge < evThreshold || edge > maxEdge) continue;
    candidates.push({
      match_id:           match.id,
      outcome,
      detected_odds:      live.odds,
      detected_edge:      edge,
      detected_mes:       null,
      bookmaker:          live.book ?? null,
      kickoff_at:         match.kickoff_at ?? null,
      model_architecture: 'INPLAY_DIXON_COLES',
      signal_category:    categoryFor({ odds: live.odds, edge }),
      phase:              'inplay',
    });
  }
  return candidates;
}

async function winProbStage(supabase, matches) {
  const ids = matches.map(m => m.id);
  const { data, error } = await supabase
    .from('inplay_baseline')
    .select('match_id, lambda_home, lambda_away')
    .in('match_id', ids);
  if (error) { console.warn('[inplay] baseline read failed:', error.message); return 0; }

  const baseByMatch = new Map((data ?? []).map(r => [r.match_id, r]));
  const candidates = [];
  for (const m of matches) {
    candidates.push(...winProbCandidates(m, baseByMatch.get(m.id)));
  }
  const withBaseline = matches.filter(m => baseByMatch.has(m.id)).length;
  console.log(`[inplay] win-prob: ${withBaseline}/${matches.length} live match(es) have a baseline; ${candidates.length} candidate(s)`);
  return insertModelSignals(supabase, candidates);
}

// ── STAGE 4: Second Half Sniper (half-time Over 1.5/2.5 on a hot scoreline) ────

/**
 * Build + persist Second Half Sniper signals for the live matches at their
 * half-time break. Holds the frozen pre-match goal expectation (inplay_baseline)
 * against the live Over price via lib/secondHalfSniper. Inserts through the
 * secondary-market path (market='totals', outcome='over') so the dedup guard
 * gives us the once-per-fixture entry for free.
 *
 * @returns {number} signals inserted
 */
async function sniperStage(supabase, matches) {
  const ids = matches.map(m => m.id);
  const { data, error } = await supabase
    .from('inplay_baseline')
    .select('match_id, lambda_home, lambda_away')
    .in('match_id', ids);
  if (error) { console.warn('[inplay] sniper baseline read failed:', error.message); return 0; }

  const baseByMatch = new Map((data ?? []).map(r => [r.match_id, r]));
  const candidates = [];
  for (const m of matches) {
    candidates.push(...sniperCandidates(m, baseByMatch.get(m.id), {
      evThreshold: INPLAY_EV_THRESHOLD,
      maxEdge:     INPLAY_MAX_EDGE,
    }));
  }
  console.log(`[inplay] second-half sniper: ${candidates.length} candidate(s) from ${matches.length} live match(es)`);
  if (!candidates.length) return 0;
  return insertSecondarySignals(supabase, candidates, 'inplay');
}

// ── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  const supabase = getClient();
  console.log('[inplay] computeInplayValues — book-lag + model-vs-market + win-prob');
  console.log(`[inplay] model_stage=${INPLAY_MODEL_ENABLED ? 'on' : 'off'} winprob_stage=${INPLAY_WINPROB_ENABLED ? 'on' : 'off'} sniper_stage=${SECOND_HALF_SNIPER_ENABLED ? 'on' : 'off'} ev_threshold=${INPLAY_EV_THRESHOLD}`);

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

  // STAGE 3 — win-probability vs pre-match baseline (gated; internationals)
  if (INPLAY_WINPROB_ENABLED) {
    try {
      const n = await winProbStage(supabase, matches);
      console.log(`[inplay] win-prob signals: ${n}`);
    } catch (err) {
      console.error('[inplay] win-prob stage failed:', err.message);
    }
  }

  // STAGE 4 — Second Half Sniper (gated; half-time Over 1.5/2.5 on a hot scoreline)
  if (SECOND_HALF_SNIPER_ENABLED) {
    try {
      const n = await sniperStage(supabase, matches);
      console.log(`[inplay] second-half sniper signals: ${n}`);
    } catch (err) {
      console.error('[inplay] second-half sniper stage failed:', err.message);
    }
  }

  console.log('[inplay] done');
}

if (require.main === module) {
  main().catch(err => { console.error('[inplay] fatal:', err.message); process.exit(1); });
}

module.exports = { fetchLiveMatches, modelVsMarket, buildHalftimeFeatures, insertModelSignals, winProbCandidates, winProbStage, sniperStage };
