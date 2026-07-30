/**
 * lib/oddsApiBudget.js — monthly credit pacing for The Odds API.
 *
 * WHY THIS IS A DIFFERENT PROBLEM TO lib/pollBudget.js
 * ───────────────────────────────────────────────────
 * API-Football is a DAILY quota — overspend and you lose one day. The Odds API is
 * a MONTHLY pool: overspend in week one and the board goes dark for three weeks.
 * So the guard can't just be a per-run cap; usage has to be PACED across the
 * month against how much football is actually left in it.
 *
 * THE COST DRIVER IS "LEAGUE-DAYS", NOT FIXTURES
 * One request returns every fixture in a league with every bookmaker, so a
 * (league, day) pair costs the same whether it holds 1 fixture or 15. Measured
 * on the corpus (2022-07→now, 39 divisions): a median month has ~347 league-days,
 * a busy one ~449, and one request covers 3.3 fixtures on average.
 *
 * PACING AGAINST FOOTBALL, NOT THE CALENDAR
 * Spend is compared to expected spend by *league-days elapsed*, not days elapsed.
 * A heavy Saturday is therefore allowed to cost more without tripping the
 * throttle, and a dead Tuesday doesn't bank false credit. This is the difference
 * between a budget that survives a fixture pile-up and one that panics at it.
 *
 * ALLOCATION ORDER (what gets the money)
 *   1. a guaranteed pre-match breadth floor per league-day — this is the whole
 *      point of the subscription (soft-book prices), so it is protected first
 *   2. the surplus goes to in-play cadence, where extra polls actually buy
 *      resolution
 *   3. leagues with more fixtures per request, and leagues the model has proven
 *      itself in, are weighted up — same credit, more value
 *
 * Pure functions — no I/O, no clock reads except the `now` you pass in.
 */
'use strict';

/** Cost per odds request: regions × markets (mirrors lib/oddsApi.requestCost). */
function costOf(regions, markets) {
  const r = String(regions).split(',').filter(Boolean).length;
  const m = String(markets).split(',').filter(Boolean).length;
  return Math.max(1, r * m);
}

/** Days in the month containing `d` (UTC). */
function daysInMonth(d) {
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0)).getUTCDate();
}

/**
 * Fraction of the month's FOOTBALL that has already happened.
 * Falls back to calendar fraction when no fixture forecast is supplied.
 */
function seasonProgress({ now, leagueDaysElapsed, leagueDaysTotal }) {
  if (leagueDaysTotal > 0 && leagueDaysElapsed != null) {
    return Math.min(1, Math.max(0, leagueDaysElapsed / leagueDaysTotal));
  }
  const dim = daysInMonth(now);
  return Math.min(1, Math.max(0, (now.getUTCDate() - 1 + now.getUTCHours() / 24) / dim));
}

/**
 * Plan today's Odds API spend.
 *
 * @param {object} o
 *   allowance          — monthly credits (e.g. 100000)
 *   used               — credits consumed so far this month (x-requests-used)
 *   reserve            — never spend below this many remaining
 *   now                — Date
 *   leagueDaysToday    — how many tracked leagues have fixtures today
 *   leagueDaysElapsed  — league-days already played this month (for pacing)
 *   leagueDaysTotal    — league-days forecast for the whole month
 *   regions, marketsPrematch, marketsInplay
 *   prematchFloor      — minimum pre-match polls per league-day (default 8)
 *   maxPrematchPolls   — sane upper bound (default 48)
 * @returns plan incl. per-league poll counts, in-play credit budget and pace state
 */
function planDailySpend({
  allowance = 100000, used = 0, reserve = 2000, now = new Date(),
  leagueDaysToday = 0, leagueDaysElapsed = null, leagueDaysTotal = null,
  regions = 'uk', marketsPrematch = 'h2h,totals', marketsInplay = 'h2h',
  prematchFloor = 8, maxPrematchPolls = 48,
} = {}) {
  const costPre = costOf(regions, marketsPrematch);
  const costLive = costOf(regions, marketsInplay);
  const spendable = Math.max(0, allowance - used - reserve);

  // Expected spend by now, paced against football played (not calendar time).
  const progress = seasonProgress({ now, leagueDaysElapsed, leagueDaysTotal });
  const expectedUsed = (allowance - reserve) * progress;
  const drift = used - expectedUsed;               // >0 = overspending
  const budgetBand = Math.max(1, (allowance - reserve) * 0.05);
  const pace = drift > budgetBand ? 'ahead' : (drift < -budgetBand ? 'behind' : 'on-track');

  // Throttle scales spend when we're ahead of plan, loosens (mildly) when behind.
  let throttle = 1;
  if (pace === 'ahead') throttle = Math.max(0.35, 1 - drift / (allowance - reserve));
  else if (pace === 'behind') throttle = Math.min(1.4, 1 + (-drift) / (allowance - reserve));

  // What's left to cover: today's league-days plus the rest of the month's.
  const remainingLeagueDays = Math.max(
    leagueDaysToday,
    (leagueDaysTotal != null && leagueDaysElapsed != null)
      ? leagueDaysTotal - leagueDaysElapsed : leagueDaysToday);

  const creditsPerLeagueDay = remainingLeagueDays > 0
    ? (spendable / remainingLeagueDays) : spendable;

  // 1. protect the pre-match breadth floor
  let prematchPolls = Math.floor((creditsPerLeagueDay * throttle) / costPre);
  prematchPolls = Math.min(maxPrematchPolls, Math.max(0, prematchPolls));
  if (creditsPerLeagueDay >= prematchFloor * costPre) {
    prematchPolls = Math.max(prematchFloor, prematchPolls);
  }
  const prematchCost = prematchPolls * costPre * leagueDaysToday;

  // 2. surplus → in-play cadence
  const todayAllocation = Math.floor(creditsPerLeagueDay * Math.max(leagueDaysToday, 1) * throttle);
  const inplayCredits = Math.max(0, todayAllocation - prematchCost);
  const inplayPolls = Math.floor(inplayCredits / costLive);

  return {
    spendable, creditsPerLeagueDay: Math.round(creditsPerLeagueDay),
    progress: +progress.toFixed(3), expectedUsed: Math.round(expectedUsed),
    drift: Math.round(drift), pace, throttle: +throttle.toFixed(3),
    remainingLeagueDays,
    costPerPrematchRequest: costPre, costPerInplayRequest: costLive,
    prematchPolls, prematchCost,
    inplayCredits, inplayPolls,
    todayAllocation,
    exhausted: spendable <= 0,
  };
}

/**
 * Value weight for a league-day — same credit, different value.
 * More fixtures per request = more coverage bought; proven leagues (measured
 * out-of-sample) are worth more than the ones the model loses in.
 */
function leagueDayWeight({ fixtures = 1, tag = 'neutral' } = {}) {
  const fx = Math.min(3, 0.6 + 0.25 * Math.max(0, fixtures));   // saturating
  const t = tag === 'proven' ? 1.25 : tag === 'avoid' ? 0.5 : 1;
  return +(fx * t).toFixed(3);
}

/**
 * Split a day's poll allocation across leagues by value weight, preserving the
 * per-league floor so no tracked league is ever starved to zero.
 */
function allocateByValue(leagues, totalPolls, { floor = 2 } = {}) {
  if (!leagues.length) return {};
  const weights = leagues.map(l => ({ key: l.key, w: leagueDayWeight(l) }));
  const sumW = weights.reduce((s, x) => s + x.w, 0) || 1;
  const budgetAfterFloor = Math.max(0, totalPolls - floor * leagues.length);
  const out = {};
  for (const { key, w } of weights) {
    out[key] = floor + Math.floor((budgetAfterFloor * w) / sumW);
  }
  return out;
}

module.exports = { costOf, daysInMonth, seasonProgress, planDailySpend,
                   leagueDayWeight, allocateByValue };
