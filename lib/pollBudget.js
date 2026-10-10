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
/*
 * ── TIGHTENED 10 Oct 2026 (owner: "if we have so much api usage we may as
 * well use it") ──────────────────────────────────────────────────────────
 *
 * The far tiers above were sized when the spend was unmeasured. It is
 * measured now (`engine_state.api_football_quota`): the plan allows 75,000 a
 * day and the whole engine spends a small fraction of it. Meanwhile the
 * hit-rate board withholds any price older than six hours, so a fixture on the
 * 12-hour tier read "No price yet" for half of every day it sat there, beside
 * a match page showing a price. Inside 48 hours is where readers look, so
 * that is where the spend goes; the far tiers are kept inside the board's
 * six-hour window so nothing on it goes dark.
 *
 * Projected against the real 14-day fixture list on 10 Oct: ~30,000 requests
 * over the next 24 hours against 75,000, before the other scripts' share.
 * `planPolling` still widens the far tiers first if a day ever runs tight.
 */
const DEFAULT_TIERS = [
  { key: 'closing', untilHours: 3, everyMin: 5 },
  { key: 'dayof', untilHours: 12, everyMin: 10 },
  { key: 'near', untilHours: 48, everyMin: 20 },
  { key: 'far', untilHours: 72, everyMin: 60 },
  { key: 'horizon', untilHours: 168, everyMin: 120 },
  { key: 'distant', untilHours: 336, everyMin: 240 },
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
 * How long the FIRST poll of a freshly built schedule is spread over, in
 * minutes.
 *
 * ── A FIXTURE USED TO WAIT A WHOLE TIER INTERVAL FOR ITS FIRST LOOK ───────
 *
 * `nextPollAt` was `now + everyMin`, which is right for every poll after the
 * first and wrong for the first, because at that moment the fixture has never
 * been priced at all. On the `distant` tier that is a 24-hour wait — and
 * `planDay` rebuilds the schedule every day, which reset the wait before it
 * ever elapsed. Measured 7 Oct 2026, with the feed healthy and the planner
 * writing a 728-fixture plan:
 *
 *     closing    1 fixture    due
 *     dayof      6            first poll 20:22
 *     near      11            first poll 20:48
 *     far      129            first poll 02:43 tomorrow
 *     horizon  202            first poll 02:43 tomorrow
 *     distant  379            first poll 14:43 tomorrow
 *
 * 710 of 728 had never been looked at, the 379 on `distant` never would be,
 * and `odds` held a price for 18 fixtures of the 741 inside the fortnight. The
 * boards were empty for the same reason the 3-day horizon used to empty them,
 * one layer down: the horizon was extended and the first poll was not.
 *
 * ── SO THE FIRST POLL IS NOW, SPREAD ──────────────────────────────────────
 *
 * Due immediately for every fixture would put 728 requests in one run. Instead
 * each tier's fixtures are dealt evenly across this ramp, so the backlog
 * clears inside the hour at about sixty requests a run, and a tier tighter
 * than the ramp keeps its own interval rather than being slowed down by it.
 */
const FIRST_POLL_RAMP_MIN = 60;

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

/**
 * Requests one fixture consumes over the NEXT `windowHours`, walking it down
 * the ladder as kickoff approaches.
 *
 * ── THE BUDGET IS A DAY, SO THE COST MUST BE A DAY ───────────────────────
 *
 * `planPolling` used to price every fixture at `pollsForFixture` — its whole
 * remaining LIFE — and compare the sum against ONE day's allowance. With a
 * fourteen-day horizon that counts up to two weeks of polls against one day,
 * so the planner believed the old ladder cost 53,450 of 75,000 when the next
 * 24 hours actually cost ~9,000, and any tighter ladder tripped degradation
 * that doubled the far tiers out to intervals measured in years. The allowance
 * resets daily; what has to fit inside it is what the next day spends.
 */
function pollsInWindow(hoursToKickoff, tiers, windowHours = 24) {
  if (hoursToKickoff <= 0) return 0;
  const floor = Math.max(0, hoursToKickoff - windowHours);
  let polls = 0;
  let prev = 0;
  for (const t of tiers) {
    const lo = Math.max(prev, floor);
    const hi = Math.min(t.untilHours, hoursToKickoff);
    prev = t.untilHours;
    if (hi <= lo) continue;
    polls += Math.floor(((hi - lo) * 60) / t.everyMin);
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
    (sum, f) => sum + pollsInWindow(f.hoursToKickoff, ts), 0);

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
      const c = pollsInWindow(f.hoursToKickoff, active);
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

  // How many fixtures sit in each tier, so the first poll can be dealt evenly
  // across the ramp rather than all landing on one run.
  const tierSize = new Map();
  for (const f of covered) {
    const t = tierFor(f.hoursToKickoff, active);
    if (t) tierSize.set(t.key, (tierSize.get(t.key) ?? 0) + 1);
  }

  const dealt = new Map();
  const schedule = covered.map(f => {
    const t = tierFor(f.hoursToKickoff, active);
    let nextPollAt = null;
    if (t) {
      const i = dealt.get(t.key) ?? 0;
      dealt.set(t.key, i + 1);
      // A TIER TIGHTER THAN THE RAMP KEEPS ITS OWN INTERVAL. Spreading the
      // closing tier over an hour would be the old bug wearing the fix's name.
      const ramp = Math.min(t.everyMin, FIRST_POLL_RAMP_MIN);
      const size = tierSize.get(t.key) ?? 1;
      nextPollAt = new Date(nowMs + (i / size) * ramp * MIN).toISOString();
    }
    return {
      id: f.id,
      kickoffAt: f.kickoffAt,
      hoursToKickoff: Number(f.hoursToKickoff.toFixed(2)),
      tier: t ? t.key : null,
      everyMin: t ? t.everyMin : null,
      nextPollAt,
      polls: pollsInWindow(f.hoursToKickoff, active),
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

/**
 * The interval a fixture should be on NOW, given the ladder its plan was built
 * with. `planDay` builds the schedule once a day, so without this a fixture
 * keeps the interval it had at plan time all day long — one 50 hours out at
 * 05:00 stayed on the 12-hour tier while it walked to 26 hours. `ingestOdds`
 * re-tiers each fixture as it advances it. Null past the last tier or kickoff.
 */
function intervalFor(hoursToKickoff, tiers = DEFAULT_TIERS) {
  const t = tierFor(hoursToKickoff, tiers);
  return t ? { tier: t.key, everyMin: t.everyMin } : null;
}

module.exports = { planPolling, pollsForFixture, pollsInWindow, tierFor, intervalFor, dueNow,
                   summarise, FIRST_POLL_RAMP_MIN, DEFAULT_TIERS };
