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

// How far back a price may have been fetched and still count as a LIVE price.
//
// captureInplaySeries.js has read a 10-minute window since it was written, and
// the signal engine read `ODDS_MAX_AGE_HOURS` (24h) — so the chart and the
// signals beside it held two different beliefs about what the live price is,
// and the one drawing the chart was the correct one. computeInplayValues.js
// reads THIS now; the pre-match path is untouched and still reads 24 hours,
// which is right for a market that has not started moving.
//
// Measured over the 3,798 h2h selection-ticks in inplay_market_series (model
// probability present, minute under the 85 cap): replayed against a 24-hour
// bucket, 72.7% of them price an "edge" above INPLAY_MAX_EDGE; against this
// window, 42.4%. The window is 30 of those 78 points. The rest is the model
// (see INPLAY_MAX_ODDS below).
//
// IT DOES NOT STARVE THE BOOK-LAG STAGE, which is the one thing a tighter
// window could break — it needs a multi-book pack, not one price. Measured over
// 400 recent live captures: a 10-minute window holds a mean of 10.5 distinct
// h2h books and NEVER zero (the 24-hour figure is 23.17, and the difference is
// the pre-match panel, which is exactly what must not count as a live price).
// It is also tighter than lib/dataQuality's own 15-minute maxPriceAgeMinutes,
// so nothing surviving this window can then fail that gate on age.
const INPLAY_ODDS_MAX_AGE_MIN = parseFloat(process.env.INPLAY_ODDS_MAX_AGE_MIN || '10');

// Longest price an in-play stage may back — the SAME 3.00 the pre-match
// eligibility box cuts at, READ from lib/signalTier rather than typed, because
// a constant typed twice in this repo drifted inside twenty-four hours once
// already (see PRIME_EDGE_MIN's own note).
//
// WHY IT EXISTS. Every pre-match signal path has an odds band; the three
// in-play stages had none, and liveWinProb advances a FROZEN pre-match lambda
// by minute and score without ever reading the live market. That is a textbook
// favourite-longshot bias and it is monotonic in price. Median model
// probability over the market's own implied probability, same 3,798 ticks:
//
//     price < 2.0    0.80        price 5-10     1.38
//     price 2-3      1.10        price 10-25    2.40
//     price 3-5      1.06        price 25+      2.47
//
// So above 3.00 the model claims roughly half again to two and a half times
// the market's chance, and that is what INPLAY_MAX_EDGE has been catching:
//
//     market   band          ticks   med ratio   above max     fires
//     h2h      <= 3.00        1349       0.868    175 (13.0%)    258
//     h2h      >  3.00        2449       1.431   1434 (58.6%)    206
//     totals   <= 3.00         882       0.751    155 (17.6%)    156
//     totals   >  3.00         276       3.491    265 (96.0%)      0
//
// The totals row is the plainest statement of it: above 3.00 that stage has
// never once produced a candidate inside the band, only rejects. Applying the
// ceiling removes 1,434 of the 1,609 above-max rejects (89%) and keeps 258 of
// the 464 in-band candidates (56%).
//
// INPLAY_MAX_EDGE IS NOT MOVED AND MUST NOT BE. It is the last guard, it is
// correctly rejecting a miscalibration, and lowering a threshold to make a
// signal appear is the move this repo forbids. This fixes the INPUT.
//
// NO LOWER BOUND, deliberately. The box's 1.40 floor is a staking rule, not a
// calibration one: under 2.00 the model claims 0.80x the market and produces
// 52 above-max ticks in 993. Adding the floor would cut fires 258 -> 164 and
// the rejects only 175 -> 172 — all cost, no correction.
const INPLAY_MAX_ODDS = parseFloat(
  process.env.INPLAY_MAX_ODDS || String(require('./signalTier').THRESHOLDS.PRIME_ODDS_MAX),
);

/**
 * Is `odds` a price an in-play stage may back? Fails CLOSED on a
 * non-numeric or absent price, so a missing quote is never treated as backable.
 *
 * Deliberately NOT applied inside bestH2hOdds: that map also feeds
 * devigLiveH2h, which needs all three legs to remove the margin, and dropping a
 * leg there would silently de-vig a two-legged 1X2 vector. The ceiling belongs
 * on the CANDIDATE, which is what it is a statement about.
 *
 * @param {number} odds - decimal odds
 * @param {number} [maxOdds] - ceiling, exclusive (defaults to INPLAY_MAX_ODDS)
 * @returns {boolean}
 */
function isBackablePrice(odds, maxOdds = INPLAY_MAX_ODDS) {
  const o = Number(odds);
  if (!Number.isFinite(o)) return false;
  return o > 1 && o < maxOdds;
}

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
  INPLAY_ODDS_MAX_AGE_MIN,
  INPLAY_MAX_ODDS,
  isBackablePrice,
  classifyPhase,
  isWithinLiveWindow,
  inplayEdge,
  marginBuckets,
  formatLiveState,
  bestH2hOdds,
  bestTotalsByLine,
};
