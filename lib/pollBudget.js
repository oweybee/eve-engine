/**
 * lib/pollBudget.js — adaptive, budget-aware odds-polling planner.
 *
 * THE PROBLEM
 * ───────────
 * ingestOdds spends one API request per fixture per poll. Polling every fixture
 * at a flat interval burns the daily quota on fixtures that are three days away
 * and whose price barely moves, then leaves nothing for the hour before kickoff
 * — which is exactly where the line moves, where steam shows up, and where CLV
 * is won or lost.
 *
 * THE MODEL
 * ─────────
 * Spend requests in proportion to how fast the price is changing:
 *
 *      T-0 → 3h    every  5 min   (closing line forming — the valuable window)
 *      T-3h → 12h  every 30 min   (day-of drift)
 *      T-12h → 48h every  3 h     (occasional repricing)
 *      T-48h+      every 12 h     (a heartbeat, nothing more)
 *
 * That is ~68 polls over a fixture's whole life instead of ~192 at a flat 5 min,
 * and it puts over half of them in the final three hours.
 *
 * GRACEFUL DEGRADATION
 * ────────────────────
 * When the projected spend exceeds the budget the planner degrades in the order
 * that costs the least information — never by silently truncating:
 *   1. widen the far tiers (T-48h, then T-12h) — cheap to lose
 *   2. widen the day-of tier
 *   3. widen the closing tier (last resort — this is the valuable one)
 *   4. only then cover fewer fixtures, nearest-kickoff first
 * Every degradation is reported in the returned plan so the run logs say
 * exactly what was given up.
 *
 * Pure functions, no I/O — unit-tested in engine.pollbudget.test.js.
 */
'use strict';

const MIN = 60 * 1000;
const HOUR = 60 * MIN;

/**
 * Default tiers, ordered nearest-kickoff first.
 *
 * THE LADDER USED TO STOP AT 72 HOURS, AND THAT WAS THE PRODUCT'S HORIZON.
 * `tierFor` returns nothing past the last tier, so a fixture further out than
 * the final `untilHours` is dropped from the schedule entirely. Nothing read
 * as broken — on 28 Sep 2026 the engine completed 205 of 288 planned runs and
 * the feed wrote prices on the hour — but it was pricing 13 fixtures while 404
 * sat in `matches` inside the fortnight, 389 of them with no odds against them
 * at all. The board went dark for the whole international break, which lands
 * about five times a season and runs ten to fourteen days: roughly two months
 * a year of an empty product for paying subscribers.
 *
 * SO THE HORIZON IS 14 DAYS, AND IT COSTS ALMOST NOTHING. Measured against the
 * real fixture distribution that day: the two new tiers add 65 fixtures at
 * ~130 requests/day and 326 at ~163/day, taking the whole board to ~554/day
 * against a `DAILY_REQUEST_BUDGET` of 75,000. Under three quarters of one
 * percent. The 3-day horizon was never a budget decision; it was the shape of
 * this array, and `DAYS_AHEAD` was tuned to match it.
 *
 * THE FAR TIERS STAY DELIBERATELY COARSE. A price a fortnight out moves
 * slowly, and polling it hourly buys a number nobody reads at the cost of the
 * closing line, which is the one that settles whether the edge was real.
 */
const DEFAULT_TIERS = [
  { key: 'closing', untilHours: 3, everyMin: 5 },
  { key: 'dayof', untilHours: 12, everyMin: 30 },
  { key: 'near', untilHours: 48, everyMin: 180 },
  { key: 'far', untilHours: 72, everyMin: 720 },
  { key: 'horizon', untilHours: 168, everyMin: 720 },
  { key: 'distant', untilHours: 336, everyMin: 1440 },
];

/**
 * Widen order: sacrifice the far tiers before the closing line.
 *
 * The two new tiers go FIRST, and that ordering is what makes extending the
 * horizon safe. A fortnight-out price is the cheapest thing on the board to
 * lose, so if a day ever does run tight the planner gives those up before it
 * touches anything that matters.
 */
const DEGRADE_ORDER = ['distant', 'horizon', 'far', 'near', 'dayof', 'closing'];

/**
 * Requests one fixture consumes from `now` until kickoff under a tier set.
 * Counts only the portion of each tier that still lies ahead of us.
 */
function pollsForFixture(hoursToKickoff, tiers) {
  if (hoursToKickoff <= 0) return 0;
  let polls = 0;
  let prev = 0;
  for (const t of tiers) {
    const lo = prev;
    const hi = t.untilHours;
    prev = hi;
    if (hoursToKickoff <= lo) continue;          // fixture is nearer than this tier
    const span = Math.min(hoursToKickoff, hi) - lo;
    if (span <= 0) continue;
    polls += Math.floor((span * 60) / t.everyMin);
  }
  return polls;
}

/** Which tier a fixture sits in right now (null if past kickoff / out of range). */
function tierFor(hoursToKickoff, tiers) {
  if (hoursToKickoff <= 0) return null;
  for (const t of tiers) {
    if (hoursToKickoff <= t.untilHours) return t;
  }
  return null;
}

function cloneTiers(tiers) {
  return tiers.map(t => ({ ...t }));
}

/**
 * Build a polling plan that fits the budget.
 *
 * @param {object} opts
 *   fixtures  — [{ id, kickoffAt }]  upcoming fixtures (any horizon)
 *   budget    — total API requests available today
 *   now       — Date (defaults to now)
 *   reserve   — requests to hold back for other consumers
 *               { live, details, planner } (all optional)
 *   tiers     — override DEFAULT_TIERS
 * @returns {{
 *   schedule: Array<{id, kickoffAt, hoursToKickoff, tier, everyMin, nextPollAt, polls}>,
 *   cost: {prematch, reserved, total, budget, utilisation},
 *   tiers, degradations: string[], dropped: number, covered: number
 * }}
 */
function planPolling({ fixtures = [], budget = 100, now = new Date(),
                       reserve = {}, tiers = DEFAULT_TIERS } = {}) {
  const nowMs = now.getTime();
  const reserved =
    (reserve.live ?? 0) + (reserve.details ?? 0) + (reserve.planner ?? 0);
  const spendable = Math.max(0, budget - reserved);

  // Upcoming only, nearest kickoff first — the priority order for coverage.
  const upcoming = fixtures
    .map(f => ({
      id: f.id,
      kickoffAt: f.kickoffAt,
      hoursToKickoff: (new Date(f.kickoffAt).getTime() - nowMs) / HOUR,
    }))
    .filter(f => f.hoursToKickoff > 0 && Number.isFinite(f.hoursToKickoff))
    .sort((a, b) => a.hoursToKickoff - b.hoursToKickoff);

  let active = cloneTiers(tiers);
  const degradations = [];

  const project = ts => upcoming.reduce(
    (sum, f) => sum + pollsForFixture(f.hoursToKickoff, ts), 0);

  // ── 1-3. Widen tiers, cheapest information first ─────────────────────────
  for (const key of DEGRADE_ORDER) {
    let guard = 0;
    while (project(active) > spendable && guard++ < 12) {
      const t = active.find(x => x.key === key);
      if (!t) break;
      const before = t.everyMin;
      t.everyMin *= 2;
      degradations.push(`${key}: ${before}m → ${t.everyMin}m`);
    }
    if (project(active) <= spendable) break;
  }

  // ── 4. Still over: cover fewer fixtures, nearest kickoff wins ────────────
  let covered = upcoming;
  if (project(active) > spendable) {
    const kept = [];
    let running = 0;
    for (const f of upcoming) {
      const c = pollsForFixture(f.hoursToKickoff, active);
      if (running + c > spendable) break;
      kept.push(f);
      running += c;
    }
    if (kept.length < upcoming.length) {
      degradations.push(
        `coverage: ${kept.length}/${upcoming.length} fixtures (nearest kickoff first)`);
    }
    covered = kept;
  }

  const schedule = covered.map(f => {
    const t = tierFor(f.hoursToKickoff, active);
    return {
      id: f.id,
      kickoffAt: f.kickoffAt,
      hoursToKickoff: Number(f.hoursToKickoff.toFixed(2)),
      tier: t ? t.key : null,
      everyMin: t ? t.everyMin : null,
      nextPollAt: t ? new Date(nowMs + t.everyMin * MIN).toISOString() : null,
      polls: pollsForFixture(f.hoursToKickoff, active),
    };
  });

  const prematch = schedule.reduce((s, x) => s + x.polls, 0);
  return {
    schedule,
    cost: {
      prematch,
      reserved,
      total: prematch + reserved,
      budget,
      utilisation: budget > 0 ? Number(((prematch + reserved) / budget).toFixed(3)) : null,
    },
    tiers: active,
    degradations,
    dropped: upcoming.length - covered.length,
    covered: covered.length,
  };
}

/** Fixtures due for a poll right now, given their stored nextPollAt. */
function dueNow(schedule, now = new Date()) {
  const t = now.getTime();
  return schedule.filter(s => !s.nextPollAt || new Date(s.nextPollAt).getTime() <= t);
}

/** One-line human summary for run logs. */
function summarise(plan) {
  const byTier = {};
  for (const s of plan.schedule) byTier[s.tier] = (byTier[s.tier] ?? 0) + 1;
  const tiers = Object.entries(byTier).map(([k, v]) => `${k}=${v}`).join(' ');
  return `[budget] ${plan.covered} fixtures (${tiers || 'none'}) — ` +
    `${plan.cost.prematch} pre-match + ${plan.cost.reserved} reserved = ` +
    `${plan.cost.total}/${plan.cost.budget} (${Math.round((plan.cost.utilisation ?? 0) * 100)}%)` +
    (plan.degradations.length ? ` | degraded: ${plan.degradations.join('; ')}` : '') +
    (plan.dropped ? ` | DROPPED ${plan.dropped} fixtures` : '');
}

module.exports = { planPolling, pollsForFixture, tierFor, dueNow, summarise,
                   DEFAULT_TIERS };
