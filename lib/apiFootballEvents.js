'use strict';

/**
 * API-Football adapter: turn a fixture's event feed into a normalised goal
 * timeline that lib/earlyPayout.js can replay.
 *
 * The /fixtures/events endpoint returns one row per match event. We keep only
 * real goals that counted on the scoreboard, attribute own goals to the side
 * they benefit, and drop penalty-shootout goals (those decide the tie but never
 * change the 90/120-minute scoreline a 2UP payout is judged on).
 */

const API_FOOTBALL_HOST = 'v3.football.api-sports.io';

/**
 * Normalise an API-Football events payload into `[{ team, minute }]` ordered by
 * minute, where `team` is 'home' | 'away' relative to the supplied team names.
 * Callers pass the DB team names so we don't need the fixture object here; a
 * `namesMatch` comparator (fuzzy) is injected to reuse each script's own matcher.
 *
 * @param {Array} events           API-Football `response` array
 * @param {string} homeName        home team name (DB canonical)
 * @param {string} awayName        away team name (DB canonical)
 * @param {(a:string,b:string)=>boolean} namesMatch fuzzy name comparator
 * @returns {Array<{team:'home'|'away', minute:number}>}
 */
function goalTimelineFromEvents(events, homeName, awayName, namesMatch) {
  const goals = [];
  for (const ev of events ?? []) {
    if ((ev?.type ?? '').toLowerCase() !== 'goal') continue;

    const detail = (ev?.detail ?? '').toLowerCase();
    const comments = (ev?.comments ?? '').toLowerCase();
    if (detail.includes('missed')) continue;      // missed penalty — not a goal
    if (comments.includes('shootout')) continue;  // PSO goals don't move the FT score

    const name = ev?.team?.name;
    let side = namesMatch(homeName, name) ? 'home'
             : namesMatch(awayName, name) ? 'away'
             : null;
    if (side == null) continue;

    // An own goal is recorded under the conceding team but scores for the other.
    if (detail.includes('own goal')) side = side === 'home' ? 'away' : 'home';

    const minute = Number(ev?.time?.elapsed);
    goals.push({ team: side, minute: Number.isFinite(minute) ? minute : 0 });
  }
  return goals.sort((x, y) => x.minute - y.minute);
}

/**
 * Fetch a fixture's goal timeline from API-Football, keyed by numeric fixture id
 * (matches.external_id). Results are memoised in the shared `cache` so a single
 * run never pulls the same fixture twice. Returns null on any error or when the
 * key isn't set — the caller then simply can't confirm an early payout.
 *
 * @param {string|number} fixtureId  API-Football fixture id
 * @param {string} apiKey            x-apisports-key
 * @param {Map} cache                shared per-run memoisation map
 * @returns {Promise<Array|null>}    raw events array, or null
 */
async function fetchFixtureEvents(fixtureId, apiKey, cache = new Map()) {
  if (!apiKey || !/^\d+$/.test(String(fixtureId ?? ''))) return null;
  const cacheKey = `events:${fixtureId}`;
  if (cache.has(cacheKey)) return cache.get(cacheKey);

  const url = `https://${API_FOOTBALL_HOST}/fixtures/events?fixture=${fixtureId}`;
  const res = await fetch(url, { headers: { 'x-apisports-key': apiKey } });
  if (!res.ok) throw new Error(`API-Football events ${fixtureId}: HTTP ${res.status}`);
  const json = await res.json();
  const events = json?.response ?? [];
  cache.set(cacheKey, events);
  return events;
}

module.exports = { API_FOOTBALL_HOST, goalTimelineFromEvents, fetchFixtureEvents };
