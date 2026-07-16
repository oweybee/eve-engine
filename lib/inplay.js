'use strict';

/**
 * lib/inplay.js — pure helpers for the in-play signal pipeline.
 *
 * Everything here is side-effect free and unit-tested (engine.inplay.test.js).
 * DB and HTTP access live in ingestLiveOdds.js / computeInplayValues.js.
 *
 * Two distinct in-play value mechanisms (see README "In-play signals"):
 *
 *   1. Book-lag (MARKET_CONSENSUS, run live) — the existing Kaunitz engine on
 *      live odds. Fires only when one book trails the live crowd. Cheap, but
 *      pure latency arbitrage; no independent opinion.
 *
 *   2. Model-vs-market (SUPERMODEL_HALFTIME) — hold an INDEPENDENT live
 *      probability (the half-time supermodel) against the drifted live price.
 *      This is the one that can say "the market overreacted to the goal, the
 *      favourite is still value". edge = p_model * live_odds - 1.
 */

// A football match plus stoppage rarely runs beyond ~2h40 wall-clock. After
// this window past kickoff a fixture is treated as finished, never in-play, so
// stale 'live' rows can't keep emitting signals.
const LIVE_WINDOW_MS = parseInt(process.env.LIVE_WINDOW_MIN || '160', 10) * 60 * 1000;

/**
 * Classify a signal as pre-match or in-play purely from timestamps.
 * A signal detected at/after kickoff is in-play.
 *
 * @param {number} detectedAtMs - Date.now()-style ms when the edge was detected
 * @param {number|null} kickoffMs - kickoff epoch ms (null/NaN → assume prematch)
 * @returns {'prematch'|'inplay'}
 */
function classifyPhase(detectedAtMs, kickoffMs) {
  if (!Number.isFinite(kickoffMs)) return 'prematch';
  return detectedAtMs >= kickoffMs ? 'inplay' : 'prematch';
}

/**
 * Is `nowMs` inside the live window of a match that kicked off at `kickoffMs`?
 * Used to pick which fixtures the in-play engine should process.
 *
 * @param {number} kickoffMs
 * @param {number} nowMs
 * @returns {boolean}
 */
function isWithinLiveWindow(kickoffMs, nowMs) {
  if (!Number.isFinite(kickoffMs)) return false;
  return nowMs >= kickoffMs && nowMs < kickoffMs + LIVE_WINDOW_MS;
}

/**
 * Expected value per unit stake for backing `liveOdds` when the model assigns
 * probability `pModel`. edge = p*odds - 1. Returns null on invalid input so a
 * bad price can never manufacture a phantom edge (mirrors computeEdge in the
 * pre-match engine's test suite).
 *
 * @param {number} pModel - model probability in [0,1]
 * @param {number} liveOdds - decimal odds (> 1)
 * @returns {number|null}
 */
function inplayEdge(pModel, liveOdds) {
  const p = Number(pModel);
  const o = Number(liveOdds);
  if (!Number.isFinite(p) || p <= 0 || p > 1) return null;
  if (!Number.isFinite(o) || o <= 1) return null;
  return +(p * o - 1).toFixed(6);
}

/**
 * Map the current goal margin (from the backed team's perspective) to the
 * half-time bucket one-hot the supermodel was trained on. Used both to build
 * the feature vector and to label the signal context in the alert.
 *
 * @param {number} backedLead - goals scored by backed team minus conceded
 * @returns {{ht_losing_2plus:number, ht_losing_1:number, ht_draw:number,
 *            ht_winning_1:number, ht_winning_2plus:number}}
 */
function marginBuckets(backedLead) {
  const lead = Number(backedLead) || 0;
  return {
    ht_losing_2plus:  lead <= -2 ? 1 : 0,
    ht_losing_1:      lead === -1 ? 1 : 0,
    ht_draw:          lead === 0 ? 1 : 0,
    ht_winning_1:     lead === 1 ? 1 : 0,
    ht_winning_2plus: lead >= 2 ? 1 : 0,
  };
}

/**
 * Short human label for the live game state, e.g. "1-0 38'". Pure formatting.
 *
 * @param {number|null} homeGoals
 * @param {number|null} awayGoals
 * @param {number|null} minute
 * @returns {string}
 */
function formatLiveState(homeGoals, awayGoals, minute) {
  const h = Number.isFinite(homeGoals) ? homeGoals : '?';
  const a = Number.isFinite(awayGoals) ? awayGoals : '?';
  const m = Number.isFinite(minute) ? ` ${minute}'` : '';
  return `${h}-${a}${m}`;
}

/**
 * Best available h2h decimal odds per outcome from raw `odds` rows. Unlike the
 * multi-book consensus, this needs only a SINGLE price — so the model-vs-market
 * stage works even when the live feed is single-source (API-Football /odds/live
 * is one aggregated feed, not a crowd of books). Latest row per book wins.
 *
 * @param {Array<{bookmaker:string, market?:string, home_odds:any, draw_odds:any,
 *                away_odds:any, fetched_at:string}>} oddsRows
 * @returns {{home:{odds:number,book:string}|null,
 *            draw:{odds:number,book:string}|null,
 *            away:{odds:number,book:string}|null}}
 */
function bestH2hOdds(oddsRows) {
  const h2h = (oddsRows ?? []).filter(r => (r.market ?? 'h2h') === 'h2h');
  const out = { home: null, draw: null, away: null };
  const cols = { home: 'home_odds', draw: 'draw_odds', away: 'away_odds' };
  for (const outcome of ['home', 'draw', 'away']) {
    for (const r of h2h) {
      const v = parseFloat(r[cols[outcome]]);
      if (!Number.isFinite(v) || v <= 1 || v >= 1000) continue;
      if (!out[outcome] || v > out[outcome].odds) {
        out[outcome] = { odds: v, book: r.bookmaker };
      }
    }
  }
  return out;
}

/**
 * Best available live Over/Under GOALS price per line, from raw `odds` rows.
 * Engine convention (shared with secondaryMarkets.bestTwoWay): over → home_odds,
 * under → away_odds, market = 'totals'. Like bestH2hOdds this needs only a single
 * live source, so it works off the aggregated /odds/live feed. Best (max) price
 * per side within each line wins.
 *
 * @param {Array<{market?:string, market_line:any, home_odds:any, away_odds:any,
 *                bookmaker:string}>} oddsRows
 * @returns {Map<number, {over:{odds:number,book:string}|null,
 *                        under:{odds:number,book:string}|null}>}
 */
function bestTotalsByLine(oddsRows) {
  const rows = (oddsRows ?? []).filter(r => (r.market ?? '') === 'totals');
  const byLine = new Map();
  for (const r of rows) {
    const line = Number(r.market_line);
    if (!Number.isFinite(line)) continue;
    const over = parseFloat(r.home_odds);
    const under = parseFloat(r.away_odds);
    let g = byLine.get(line);
    if (!g) { g = { over: null, under: null }; byLine.set(line, g); }
    if (Number.isFinite(over) && over > 1 && over < 1000 && (!g.over || over > g.over.odds)) {
      g.over = { odds: over, book: r.bookmaker };
    }
    if (Number.isFinite(under) && under > 1 && under < 1000 && (!g.under || under > g.under.odds)) {
      g.under = { odds: under, book: r.bookmaker };
    }
  }
  return byLine;
}

module.exports = {
  LIVE_WINDOW_MS,
  classifyPhase,
  isWithinLiveWindow,
  inplayEdge,
  marginBuckets,
  formatLiveState,
  bestH2hOdds,
  bestTotalsByLine,
};
