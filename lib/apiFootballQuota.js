'use strict';

/**
 * lib/apiFootballQuota.js — what the API-Football daily allowance actually is.
 *
 * IT HAS NEVER BEEN MEASURED. Twelve scripts in this repo call
 * v3.football.api-sports.io and **not one of them reads a response header** —
 * checked, rather than assumed. So the only number anywhere in the system is
 * `DAILY_REQUEST_BUDGET`, which planDay.js spends against and which is a
 * CONFIGURED INTENTION, not a reading: the workflows set 75000, the module
 * default is 200 and `.env.example` says 100. Three different beliefs about one
 * allowance, none of them the server's.
 *
 * The Odds API has had this since it was wired — `quotaFromHeaders` in
 * lib/oddsApi.js, persisted to `engine_state.odds_api_quota`, which is why the
 * question "how many credits are left" has an answer for one vendor and not the
 * other. This is that arrangement for the second one.
 *
 * ── MEASURING MUST NOT COST A REQUEST ────────────────────────────────────────
 *
 * API-Football has a `/status` endpoint that reports the counter, and calling it
 * SPENDS ONE against the counter it reports. A tracker that bills the quota it
 * measures is a tracker whose own cost grows with how often you want the truth.
 *
 * So this reads the headers off calls the engine is ALREADY making. The numbers
 * ride along on every response for free, and the only change at a call site is
 * to stop throwing them away.
 *
 * ── AND THE SERVER HOLDS THE COUNTER, WHICH IS WHY THIS IS CHEAP ─────────────
 *
 * `x-ratelimit-requests-remaining` is a fact the API maintains, not a total we
 * accumulate. So one report per run is enough and a missed report loses nothing
 * — the next response carries the current truth. There is no running total to
 * keep consistent, no double-count to guard against, and a script that never
 * reports simply contributes no reading. Contrast the momentum corpus, where a
 * missed tick is a row that never exists.
 *
 * ── THE HEADER NAMES ARE VERIFIED, 27 Aug 2026 ─────────────────────────────
 *
 * They were written from the v3 documentation with no key available, and the
 * first real run confirmed all four. `engine_state.api_football_quota` after
 * the 00:05 tick:
 *
 *     limitDay 75000   remainingDay 74823   spent_today 177
 *     limitMinute 450  remainingMinute 393
 *
 * The DAY's allowance is 75,000, which is what the workflows had been assuming
 * — so `DAILY_REQUEST_BUDGET` was right, and had been right by luck rather than
 * by measurement, since nothing had ever read it back.
 *
 * THE PER-MINUTE NUMBER IS THE ONE WORTH WATCHING. That tick used 57 of 450 in
 * a single minute. The in-play loop issues ~1.5 calls per live fixture per
 * pass and 71 concurrent fixtures have been observed, which is ~102 a minute —
 * comfortable, but it is the ceiling that would bind first, and a daily quota
 * with room in it says nothing about it.
 *
 * The four names, read case-insensitively and every one optional:
 *
 *     x-ratelimit-requests-limit       the DAY's allowance
 *     x-ratelimit-requests-remaining   what is left of it
 *     x-ratelimit-limit                the per-MINUTE allowance
 *     x-ratelimit-remaining            what is left of that
 *
 * The per-minute pair is worth carrying: at peak the in-play loop issues
 * ~1.5 calls per live fixture per pass, and 71 concurrent fixtures have been
 * observed. A daily quota with room in it says nothing about a minute that is
 * already full.
 *
 * ── IT IS A TRACKER, NOT A GUARD ────────────────────────────────────────────
 *
 * IT PERSISTS ON THE SUCCESS PATH ONLY, deliberately. A run that crashes leaves
 * its reading unwritten, and that costs nothing precisely because the counter is
 * the server's: the next response carries the current truth. Persisting from a
 * failure path would mean turning `process.exit(1)` into `process.exitCode`
 * across six scripts — a real behaviour change to ingestion, to save a number
 * that reappears sixty seconds later.
 *
 * Nothing here refuses a request. `canSpend` on the Odds API side exists because
 * that is a MONTHLY pool where overspending in week one darkens three weeks;
 * this is a daily one that resets. Turning a reading into a throttle changes
 * what the engine ingests and is a separate decision with its own measurement —
 * and it cannot be made honestly until there IS a reading, which is what this
 * produces. The one thing it does is make an exhausted quota LOUD instead of
 * showing up as a feed that mysteriously went quiet.
 */

/** engine_state key. Mirrors `odds_api_quota` beside it. */
const STATE_KEY = 'api_football_quota';

/** Don't rewrite the row more often than this when nothing has moved. */
const MIN_PERSIST_SECONDS = parseFloat(process.env.API_FOOTBALL_QUOTA_MIN_PERSIST || '60');

/** Below this fraction of the day's allowance, the run says so loudly. */
const WARN_AT_FRACTION = parseFloat(process.env.API_FOOTBALL_QUOTA_WARN_AT || '0.10');

function intOrNull(v) {
  if (v == null || v === '') return null;
  const n = parseInt(String(v), 10);
  return Number.isFinite(n) ? n : null;
}

/** Case-insensitive header lookup — Node lowercases, other clients may not. */
function header(headers, name) {
  if (!headers) return null;
  if (headers[name] != null) return headers[name];
  const want = name.toLowerCase();
  for (const k of Object.keys(headers)) if (k.toLowerCase() === want) return headers[k];
  return null;
}

/**
 * The four numbers, out of one response's headers.
 *
 * @param {object} headers
 * @returns {{limitDay:number|null, remainingDay:number|null,
 *            limitMinute:number|null, remainingMinute:number|null}}
 */
function quotaFromHeaders(headers = {}) {
  return {
    limitDay:        intOrNull(header(headers, 'x-ratelimit-requests-limit')),
    remainingDay:    intOrNull(header(headers, 'x-ratelimit-requests-remaining')),
    limitMinute:     intOrNull(header(headers, 'x-ratelimit-limit')),
    remainingMinute: intOrNull(header(headers, 'x-ratelimit-remaining')),
  };
}

/** Did this response carry anything worth storing? */
function isEmpty(q) {
  return q == null || (q.limitDay == null && q.remainingDay == null
                    && q.limitMinute == null && q.remainingMinute == null);
}

/** UTC day stamp — the counter resets on the vendor's clock, which is UTC. */
function dayOf(now) {
  return new Date(now).toISOString().slice(0, 10);
}

/**
 * Fold a fresh reading into what is stored.
 *
 * `spentToday` is DERIVED from the day's limit and what is left, never
 * accumulated: a total we add up drifts the moment a run dies mid-flight, and
 * the server is already keeping this one. `usedAtDayStart` exists only so a
 * rollover is visible rather than looking like a sudden refund.
 *
 * @param {object|null} stored - previous state (parsed), or null
 * @param {object} fresh - quotaFromHeaders output
 * @param {Date|number} now
 * @returns {object} the state to store
 */
function mergeQuota(stored, fresh, now = new Date()) {
  const day = dayOf(now);
  const rolled = !stored || stored.day !== day;
  const next = {
    ...(rolled ? {} : stored),
    ...Object.fromEntries(Object.entries(fresh).filter(([, v]) => v != null)),
    day,
    checked_at: new Date(now).toISOString(),
  };
  if (rolled) next.rolled_over_at = next.checked_at;
  next.spent_today = (next.limitDay != null && next.remainingDay != null)
    ? next.limitDay - next.remainingDay
    : null;
  next.fraction_left = (next.limitDay > 0 && next.remainingDay != null)
    ? +(next.remainingDay / next.limitDay).toFixed(4)
    : null;
  return next;
}

/**
 * Is this reading worth a write?
 *
 * A rollover or a moved counter always is. Otherwise the row is left alone
 * until MIN_PERSIST_SECONDS have passed, so a 60-second in-play loop with two
 * reporting scripts in it does not rewrite one row twice a minute for ever.
 */
function shouldPersist(stored, next, now = new Date(), minSeconds = MIN_PERSIST_SECONDS) {
  if (!stored) return true;
  if (stored.day !== next.day) return true;
  if (stored.remainingDay !== next.remainingDay) return true;
  const age = (new Date(now).getTime() - Date.parse(stored.checked_at ?? 0)) / 1000;
  return !(age >= 0 && age < minSeconds);
}

/** A one-line reading for a run log. */
function describeQuota(q) {
  if (!q) return 'api-football quota: never recorded';
  const day = (q.remainingDay != null && q.limitDay != null)
    ? `${q.remainingDay}/${q.limitDay} left today (spent ${q.spent_today})`
    : 'day unknown';
  const min = (q.remainingMinute != null && q.limitMinute != null)
    ? `, ${q.remainingMinute}/${q.limitMinute} this minute` : '';
  return `api-football quota: ${day}${min}`;
}

/** Is the day's allowance nearly gone? */
function isLow(q, at = WARN_AT_FRACTION) {
  return q?.fraction_left != null && q.fraction_left <= at;
}

// ── the in-process side ──────────────────────────────────────────────────────
// A module-level latest reading, so a call site's httpGet can hand its headers
// over in one line and pay nothing, and the run persists ONCE at the end.

let latest = null;

/**
 * Record one response's headers. Cheap, synchronous, never throws.
 * The FRESHEST reading wins — this is a server-held counter, not a tally.
 */
function report(headers) {
  try {
    const q = quotaFromHeaders(headers);
    if (!isEmpty(q)) latest = q;
  } catch { /* a tracker must never break an ingest */ }
}

/** The latest reading this process has seen, or null. */
function latestReading() { return latest; }

/** Test seam. */
function resetForTests() { latest = null; }

/**
 * Persist the latest reading to engine_state. Call once at the end of a run.
 *
 * Returns what it did rather than throwing, and NEVER throws: a quota row that
 * fails to write must not fail an ingest that succeeded. A run with no reading
 * writes nothing and says so — "not measured" and "measured as zero" are
 * different facts.
 *
 * @returns {Promise<{written:boolean, reason:string, quota:object|null}>}
 */
async function persistQuota(supabase, now = new Date()) {
  if (!latest) return { written: false, reason: 'no reading this run', quota: null };
  let stored = null;
  try {
    const { data, error } = await supabase
      .from('engine_state').select('value').eq('key', STATE_KEY).maybeSingle();
    if (error) throw new Error(error.message);
    if (data?.value) stored = JSON.parse(data.value);
  } catch (err) {
    console.warn(`[quota] could not read stored quota: ${err.message}`);
  }
  const next = mergeQuota(stored, latest, now);
  if (!shouldPersist(stored, next, now)) {
    return { written: false, reason: 'unchanged and recent', quota: next };
  }
  try {
    const { error } = await supabase.from('engine_state').upsert(
      { key: STATE_KEY, value: JSON.stringify(next), updated_at: next.checked_at },
      { onConflict: 'key' },
    );
    if (error) throw new Error(error.message);
  } catch (err) {
    console.warn(`[quota] could not write quota: ${err.message}`);
    return { written: false, reason: err.message, quota: next };
  }
  if (isLow(next)) {
    console.error(`::error::API-Football daily quota nearly gone — ${describeQuota(next)}`);
  }
  return { written: true, reason: 'stored', quota: next };
}

/** Read the stored quota without recording one. */
async function readQuota(supabase) {
  const { data, error } = await supabase
    .from('engine_state').select('value, updated_at').eq('key', STATE_KEY).maybeSingle();
  if (error) throw new Error(`quota read: ${error.message}`);
  if (!data?.value) return null;
  return JSON.parse(data.value);
}

module.exports = {
  STATE_KEY, MIN_PERSIST_SECONDS, WARN_AT_FRACTION,
  quotaFromHeaders, isEmpty, mergeQuota, shouldPersist, describeQuota, isLow,
  report, latestReading, resetForTests, persistQuota, readQuota,
};
