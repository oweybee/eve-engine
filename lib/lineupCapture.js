'use strict';

/**
 * lib/lineupCapture.js — the ONE implementation of "get the confirmed XI".
 *
 * WHY IT IS A MODULE AND NOT A STEP. A confirmed lineup is the only thing this
 * engine fetches that EXPIRES: the XI is news until the whistle and a record
 * afterwards, so a capture that arrives late is not late, it is a different
 * (and much less useful) product. Everything else here — prices, predictions,
 * stats, closing lines — is either still true an hour later or is explicitly a
 * historical record.
 *
 * That means the cadence has to be its own, which is why `fetchLineups.js` runs
 * on a 5-minute cron of its own rather than as the tail of a 9-minute pipeline.
 * `fetchMatchDetails.js` calls this too, as a backstop, and the held-lineup
 * check below means the second caller costs ~nothing.
 *
 * ── WHAT THIS CAN AND CANNOT GUARANTEE ──────────────────────────────────────
 *
 * It guarantees we ASK, every tick, from LINEUP_WINDOW_MINUTES before kickoff
 * until we have the row — so the capture lands within one tick of whenever the
 * feed publishes.
 *
 * It CANNOT guarantee an hour of notice, because that is the feed's decision
 * and not ours. Measured over every lineup ever captured before kickoff
 * (32 rows, 22 Aug 2026) — this is capture time, so it is a LOWER bound on
 * availability rather than a measurement of publication:
 *
 *     FIFA World Cup           52 min before kickoff   <- the earliest, ever
 *     UEFA Europa League       18-21 min
 *     Scottish Premiership     14 min
 *     Ekstraklasa / Liga I     13 min
 *     Chinese Super League     12 min
 *     English League One        9 min
 *     Russian Premier League    2 min
 *
 * NOT ONE was captured 60 minutes out. The old job asked chaotically, so these
 * say "the XI existed by then", not "it did not exist earlier" — but they are
 * the only evidence there is, and they point at most competitions publishing
 * ~20 minutes out rather than ~60. `--report` prints the lead-time
 * distribution so this can be answered properly once the tight cadence has run
 * for a week; do not quote the table above as publication timing.
 */

const DEFAULTS = {
  /**
   * How long before kickoff to start asking.
   *
   * 90 rather than 60: to HOLD a lineup at T-60 we must have asked before it,
   * and the earliest observed availability is 52 minutes. Opening earlier than
   * this buys nothing but calls — the endpoint returns an empty array until
   * the clubs file the sheet.
   */
  windowMinutes: parseFloat(process.env.LINEUP_WINDOW_MINUTES || '90'),

  /**
   * How long PAST kickoff to keep asking. A late team sheet is still worth
   * having as a record, and this is where the 98%-captured-days-late rows used
   * to come from. Bounded, because after this it is nobody's news.
   */
  graceMinutes: parseFloat(process.env.LINEUP_GRACE_MINUTES || '45'),

  /** Pause between API calls, ms. */
  pauseMs: parseFloat(process.env.LINEUP_PAUSE_MS || '300'),

  /** A PostgREST filter is a URL; eve-engine has taken silent outages from oversized .in() lists. */
  idChunk: 60,
};

function chunk(arr, n) {
  const out = [];
  for (let i = 0; i < arr.length; i += n) out.push(arr.slice(i, i + n));
  return out;
}

const sleep = ms => new Promise(r => setTimeout(r, ms));

/**
 * Is this fixture close enough to kickoff for an XI to exist?
 *
 * Gated on the CLOCK, not on status, and that is load-bearing: production has
 * never written `status='live'` and a fixture sits at `scheduled` until
 * fetchResults settles it, so a status-based test would never open at all.
 */
function inLineupWindow(match, opts = {}, now = Date.now()) {
  const { windowMinutes, graceMinutes } = { ...DEFAULTS, ...opts };
  const status = String(match?.status ?? '').toLowerCase();
  if (status !== 'scheduled' && status !== 'live') return false;
  if (!match?.kickoff_at) return false;
  const ko = new Date(match.kickoff_at).getTime();
  if (!Number.isFinite(ko)) return false;
  const delta = ko - now;                       // >0 before kickoff
  return delta <= windowMinutes * 60_000 && delta >= -graceMinutes * 60_000;
}

/** Soonest kickoff first: a missed XI is not late, it is gone. */
function byKickoff(a, b) {
  return new Date(a.kickoff_at).getTime() - new Date(b.kickoff_at).getTime();
}

/**
 * Fixtures inside the window that we do not already hold, soonest first.
 *
 * A CONFIRMED lineup is FINAL — the XI does not change once it is filed — so a
 * fixture that has one is never asked again. That is what makes a 5-minute
 * cadence affordable: the per-fixture cost is bounded by how long the feed
 * takes to publish, not by how often we run.
 */
async function dueFixtures(supabase, opts = {}, now = Date.now()) {
  const o = { ...DEFAULTS, ...opts };
  const from = new Date(now - o.graceMinutes * 60_000).toISOString();
  const to   = new Date(now + o.windowMinutes * 60_000).toISOString();

  const { data, error } = await supabase
    .from('matches')
    .select('id, external_id, kickoff_at, status')
    .not('external_id', 'is', null)
    .in('status', ['scheduled', 'live'])
    .gte('kickoff_at', from)
    .lte('kickoff_at', to)
    .order('kickoff_at', { ascending: true })
    .limit(1000);
  if (error) throw new Error(`dueFixtures: ${error.message}`);

  const inWindow = (data ?? [])
    .filter(m => /^\d+$/.test(m.external_id ?? ''))
    .filter(m => inLineupWindow(m, o, now))
    .sort(byKickoff);
  if (!inWindow.length) return { due: [], held: 0, inWindow: 0 };

  const held = new Set();
  for (const ids of chunk(inWindow.map(m => m.external_id), o.idChunk)) {
    const { data: rows, error: e } = await supabase
      .from('lineups').select('fixture_id')
      .in('fixture_id', ids).eq('confirmed', true);
    // A FAILED held-read must re-ask, never skip: degrading to "we already have
    // everything" is silent and permanent.
    if (e) { console.warn(`[lineups] held read failed, will re-ask: ${e.message}`); break; }
    for (const r of rows ?? []) held.add(String(r.fixture_id));
  }

  return {
    due: inWindow.filter(m => !held.has(String(m.external_id))),
    held: held.size,
    inWindow: inWindow.length,
  };
}

async function upsertLineup(supabase, fixtureId, teamEntry) {
  const teamId = teamEntry?.team?.id ?? null;
  if (!teamId) return false;
  const { error } = await supabase
    .from('lineups')
    .upsert({
      fixture_id:              String(fixtureId),
      api_football_fixture_id: parseInt(fixtureId, 10),
      team_id:                 teamId,
      team_name:               teamEntry?.team?.name ?? null,
      formation:               teamEntry?.formation ?? null,
      starting_xi:             teamEntry?.startXI ?? [],
      substitutes:             teamEntry?.substitutes ?? [],
      team_colors:             teamEntry?.team?.colors?.player ?? null,
      coach:                   teamEntry?.coach?.name ?? null,
      confirmed:               (teamEntry?.startXI?.length ?? 0) > 0,
      fetched_at:              new Date().toISOString(),
    }, { onConflict: 'fixture_id,team_id' });
  if (error) throw new Error(`upsertLineup(${fixtureId}, team=${teamId}): ${error.message}`);
  return true;
}

/**
 * Capture every due fixture's XI.
 *
 * @param {object}   supabase
 * @param {function} fetchLineupsFor  async (fixtureId) => teamEntry[]  (injected, so this is testable)
 * @param {object}   opts             { windowMinutes, graceMinutes, pauseMs, deadlineAt, onCapture }
 */
async function captureLineups(supabase, fetchLineupsFor, opts = {}) {
  const o = { ...DEFAULTS, ...opts };
  const now = o.now ?? Date.now();

  const { due, held, inWindow } = await dueFixtures(supabase, o, now);

  // AN EMPTY LINEUPS TABLE HAS FOUR CAUSES AND THEY ARE INDISTINGUISHABLE FROM
  // OUTSIDE: nothing near kickoff, already held, not published yet, or out of
  // budget. Same principle as /api/inplay's `source` block — a silence that
  // does not say which is read as the feed going quiet.
  const census = {
    inWindow, held, due: due.length,
    calls: 0, rows: 0, fixtures: 0, notPublished: 0,
    errors: 0, unreached: 0, stoppedOnBudget: false,
    leads: [],   // minutes before kickoff, per captured fixture
  };

  for (let i = 0; i < due.length; i++) {
    if (o.deadlineAt != null && Date.now() >= o.deadlineAt) {
      census.stoppedOnBudget = true;
      census.unreached = due.length - i;
      break;
    }
    const m = due[i];
    try {
      const teams = await fetchLineupsFor(m.external_id);
      census.calls++;
      await sleep(o.pauseMs);
      if (!teams?.length) { census.notPublished++; continue; }

      let wrote = 0;
      for (const t of teams) if (await upsertLineup(supabase, m.external_id, t)) wrote++;
      if (wrote) {
        census.rows += wrote;
        census.fixtures++;
        const lead = Math.round((new Date(m.kickoff_at).getTime() - Date.now()) / 60_000);
        census.leads.push(lead);
        if (typeof o.onCapture === 'function') o.onCapture(m, lead);
      }
    } catch (err) {
      census.errors++;
      console.warn(`  [warn] lineups(${m.external_id}): ${err.message}`);
    }
  }
  return census;
}

/** One line that says which of the four silences this run was. */
function summarise(c) {
  const leads = c.leads.slice().sort((a, b) => a - b);
  const med = leads.length ? leads[Math.floor(leads.length / 2)] : null;
  const parts = [
    `${c.fixtures} fixture(s) captured (${c.rows} rows) from ${c.calls} call(s)`,
    `${c.notPublished} not published yet`,
    `${c.held} already held`,
    `${c.inWindow} in window`,
  ];
  if (med != null) parts.push(`lead median ${med}m, range ${leads[0]}..${leads[leads.length - 1]}m`);
  if (c.errors) parts.push(`${c.errors} error(s)`);
  if (c.stoppedOnBudget) parts.push(`STOPPED ON BUDGET, ${c.unreached} unreached`);
  return `[lineups] ${parts.join(' · ')}`;
}

module.exports = {
  DEFAULTS, chunk, inLineupWindow, byKickoff,
  dueFixtures, upsertLineup, captureLineups, summarise,
};
