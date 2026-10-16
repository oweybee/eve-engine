'use strict';

/**
 * lib/matchEvents.js — goals and cards for a finished match, from API-Football.
 *
 * Feeds the Results page (owner, 16 Oct 2026: "add extra api call"). One call
 * to `/fixtures?ids=a-b-c…` returns up to 20 fixtures WITH their events and
 * both teams, so a day of ~60 finished matches costs ~3 requests, against a
 * 75,000 daily allowance.
 *
 * PURE: shapes a response into rows. The job (fetchMatchEvents.js) does the I/O.
 *
 * THE SIDE COMES FROM THE FIXTURE'S OWN TEAM IDS, never from a name. An own
 * goal is listed under the team that BENEFITS in API-Football's feed, which is
 * what a scoreline wants, so it is stored as given and labelled by `detail`.
 */

/** API-Football's finished states. Anything else is not final and is not marked done. */
const FINAL_STATUSES = new Set(['FT', 'AET', 'PEN', 'AWD', 'WO']);

/** At most 20 ids per `/fixtures?ids=` call — the vendor's documented cap. */
const IDS_PER_CALL = 20;

const intOrNull = v => (Number.isInteger(v) ? v : (typeof v === 'string' && /^\d+$/.test(v) ? parseInt(v, 10) : null));

function sideOf(event, fixture) {
  const id = event?.team?.id;
  if (id == null) return null;
  if (id === fixture?.teams?.home?.id) return 'home';
  if (id === fixture?.teams?.away?.id) return 'away';
  return null;
}

/**
 * One fixture object from the response → { fixtureId, statusShort, final, rows }.
 * `rows` is every event in feed order; `seq` keeps that order and is the
 * upsert key with fixture_id, so a re-fetch overwrites rather than duplicates.
 */
function shapeFixture(fixture, matchId = null) {
  const fixtureId = fixture?.fixture?.id != null ? String(fixture.fixture.id) : null;
  const statusShort = fixture?.fixture?.status?.short ?? null;
  if (!fixtureId) return null;
  const events = Array.isArray(fixture.events) ? fixture.events : [];
  const rows = [];
  events.forEach((e, i) => {
    const type = typeof e?.type === 'string' ? e.type : null;
    if (!type) return;
    rows.push({
      fixture_id: fixtureId,
      match_id: matchId,
      seq: i,
      team_side: sideOf(e, fixture),
      minute: intOrNull(e?.time?.elapsed),
      extra: intOrNull(e?.time?.extra),
      type,
      detail: typeof e?.detail === 'string' ? e.detail : null,
      player: e?.player?.name ?? null,
      assist: e?.assist?.name ?? null,
    });
  });
  return { fixtureId, statusShort, final: FINAL_STATUSES.has(statusShort), rows };
}

function chunk(list, n = IDS_PER_CALL) {
  const out = [];
  for (let i = 0; i < list.length; i += n) out.push(list.slice(i, i + n));
  return out;
}

module.exports = { FINAL_STATUSES, IDS_PER_CALL, shapeFixture, sideOf, chunk };
