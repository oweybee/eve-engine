'use strict';

/**
 * fetchInjuries.js — who is out, and who is a doubt, for the coming fixtures.
 *
 * Owner, 20 Oct 2026: "anything we can do to highlight injured players?" The
 * player hit-rate surfaces (Player Props, the match page's Player Stats) rank
 * a man on his last ten games and had no way to say he is not playing this
 * one. Migration 172 hides a player who has missed his club's last five games;
 * that catches a long absence a month late and a fresh one not at all.
 *
 * API-Football's /injuries lists, per fixture, the players the club or the
 * league has reported missing:
 *
 *     player.type    "Missing Fixture"  -> out
 *                    "Questionable"     -> doubt
 *     player.reason  "Knee Injury", "Suspended", "Red Card", ...
 *
 * ONE CALL PER FIXTURE, the soonest first. Every scheduled fixture in the next
 * 72 hours, about 300, every three hours: ~2,400 of a 75,000 daily allowance.
 * Per fixture rather than per date because a fixture is the unit the list is
 * replaced in (see below), and the fixture form is the documented one.
 *
 * REPLACED PER FIXTURE, never merged. A player who recovers drops off the
 * vendor's list, so the stored list for a fixture is deleted and re-written
 * from the latest answer. A fixture whose call FAILS keeps its previous list:
 * one bad response must not read as "everyone is fit".
 *
 * WHAT THIS DOES NOT CLAIM. The list is what clubs announce, which varies a
 * great deal by league, so a player absent from it is NOT confirmed fit. Only
 * the confirmed lineup (fetchLineups.js, `lineups`) says that, and
 * `player_availability()` (migration 173) prefers the lineup once it exists.
 */

const https             = require('https');
const { getClient }     = require('./lib/supabaseClient');
const { beginWatchdog } = require('./lib/watchdog');
const apiQuota          = require('./lib/apiFootballQuota');

const API_FOOTBALL_KEY = process.env.API_FOOTBALL_KEY;
const API_HOST         = 'v3.football.api-sports.io';

const args    = process.argv.slice(2);
const DRY_RUN = args.includes('--dry-run');

const HORIZON_HOURS  = parseFloat(process.env.INJURIES_HORIZON_HOURS || '72');
const BUDGET_SECONDS = parseFloat(process.env.INJURIES_BUDGET_SECONDS || '420');
// 450 a minute is the vendor's ceiling and the in-play loop shares it, so this
// stays well under: ~4 a second at most.
const SLEEP_MS       = parseInt(process.env.INJURIES_SLEEP_MS || '250', 10);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function httpGet(path) {
  if (!API_FOOTBALL_KEY) throw new Error('API_FOOTBALL_KEY not set');
  return new Promise((resolve, reject) => {
    https.request({ method: 'GET', hostname: API_HOST, path,
      headers: { 'x-apisports-key': API_FOOTBALL_KEY } },
      (res) => {
        let body = '';
        res.on('data', (c) => { body += c; });
        res.on('end', () => {
          apiQuota.report(res.headers);
          if (res.statusCode !== 200) {
            return reject(new Error(`HTTP ${res.statusCode}: ${body.slice(0, 200)}`));
          }
          try { resolve(JSON.parse(body)); } catch (e) { reject(new Error(`JSON parse: ${e.message}`)); }
        });
      }).on('error', reject).end();
  });
}

// ── Pure parsing (unit-tested) ───────────────────────────────────────────────

/** The vendor's type, as the two words this product prints. Unknown types are
    dropped rather than guessed at: a word we invent is a claim nobody made. */
function statusFor(type) {
  const t = String(type ?? '').trim().toLowerCase();
  if (t === 'missing fixture') return 'out';
  if (t === 'questionable') return 'doubt';
  return null;
}

/** An API-Football error body comes back 200 with `errors` set; an empty
    `errors` is an array or an empty object depending on the endpoint. */
function vendorError(payload) {
  const e = payload?.errors;
  if (!e) return null;
  if (Array.isArray(e)) return e.length ? JSON.stringify(e) : null;
  return Object.keys(e).length ? JSON.stringify(e) : null;
}

function positiveInt(v) {
  if (v == null || v === '') return null;
  const n = Number(v);
  if (!Number.isFinite(n)) return null;
  const i = Math.trunc(n);
  return i > 0 ? i : null;
}

/**
 * One fixture's answer as rows. A row needs a player id, a team id and a type
 * we recognise; the reason is optional and trimmed. A player listed twice (the
 * vendor does this when two sources report him) keeps the stronger status.
 */
function parseInjuries(payload, fixtureId) {
  const items = Array.isArray(payload?.response) ? payload.response : [];
  const byPlayer = new Map();
  for (const it of items) {
    const playerId = positiveInt(it?.player?.id);
    const teamId = positiveInt(it?.team?.id);
    const status = statusFor(it?.player?.type);
    if (playerId == null || teamId == null || status == null) continue;
    // The fixture is the one asked for. A row the vendor files under another
    // fixture is not this fixture's news.
    const itsFixture = positiveInt(it?.fixture?.id);
    if (itsFixture != null && itsFixture !== fixtureId) continue;
    const reason = it?.player?.reason == null ? null : String(it.player.reason).trim() || null;
    const row = {
      fixture_id: fixtureId,
      player_id: playerId,
      team_api_id: teamId,
      player_name: it?.player?.name == null ? null : String(it.player.name).trim() || null,
      status,
      reason,
    };
    const prev = byPlayer.get(playerId);
    if (!prev || (prev.status === 'doubt' && status === 'out')) byPlayer.set(playerId, row);
  }
  return [...byPlayer.values()];
}

// ── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  const summary = { fixtures: 0, written: 0, out: 0, doubt: 0, empty: 0, failed: [] };
  const dog = beginWatchdog('fetchInjuries', {
    onTerminate: ({ stage }) => {
      console.error(`[injuries] partial: ${summary.fixtures} fixture(s) done before the kill at `
        + `"${stage}". Each fixture is replaced on its own, so what is written is whole.`);
    },
  });

  try {
    if (!API_FOOTBALL_KEY) {
      console.log('[injuries] API_FOOTBALL_KEY not set — skipping');
      return;
    }
    const supabase = getClient();
    const now = new Date();
    const until = new Date(now.getTime() + HORIZON_HOURS * 3600e3);

    const { data: fixtures, error } = await supabase
      .from('matches')
      .select('id, external_id, kickoff_at')
      .eq('status', 'scheduled')
      .gte('kickoff_at', now.toISOString())
      .lte('kickoff_at', until.toISOString())
      .order('kickoff_at', { ascending: true })
      .limit(1000);
    if (error) throw new Error(`matches read: ${error.message}`);

    const targets = (fixtures ?? [])
      .map((m) => ({ matchId: m.id, fixtureId: positiveInt(m.external_id), kickoffAt: m.kickoff_at }))
      .filter((m) => m.fixtureId != null);
    console.log(`[injuries] ${targets.length} fixture(s) in the next ${HORIZON_HOURS}h`);

    const startedAt = Date.now();
    for (const f of targets) {
      if ((Date.now() - startedAt) / 1000 > BUDGET_SECONDS) {
        console.log(`[injuries] stopping on budget after ${summary.fixtures} fixture(s); the later `
          + 'kickoffs keep their previous list and are asked first-come next run');
        break;
      }
      dog.stage(`fixture ${f.fixtureId}`);
      let rows;
      try {
        const payload = await httpGet(`/injuries?fixture=${f.fixtureId}`);
        const err = vendorError(payload);
        if (err) throw new Error(`vendor: ${err}`);
        rows = parseInjuries(payload, f.fixtureId).map((r) => ({
          ...r, match_id: f.matchId, kickoff_at: f.kickoffAt, fetched_at: new Date().toISOString(),
        }));
      } catch (e) {
        summary.failed.push(`${f.fixtureId}: ${e.message}`);
        await sleep(SLEEP_MS);
        continue;
      }
      summary.fixtures++;
      if (rows.length === 0) summary.empty++;
      for (const r of rows) summary[r.status]++;

      if (!DRY_RUN) {
        // DELETE THEN INSERT, per fixture: a recovered player must drop off.
        const { error: dErr } = await supabase.from('player_injuries').delete().eq('fixture_id', f.fixtureId);
        if (dErr) { summary.failed.push(`${f.fixtureId}: clear ${dErr.message}`); continue; }
        if (rows.length) {
          const { error: iErr } = await supabase.from('player_injuries').insert(rows);
          if (iErr) { summary.failed.push(`${f.fixtureId}: insert ${iErr.message}`); continue; }
        }
      }
      summary.written += rows.length;
      await sleep(SLEEP_MS);
    }

    // Lists for fixtures that have kicked off are history the surfaces never
    // ask about; keep a week of them for checking, then let them go.
    if (!DRY_RUN) {
      const cutoff = new Date(now.getTime() - 7 * 24 * 3600e3).toISOString();
      await supabase.from('player_injuries').delete().lt('kickoff_at', cutoff);
    }

    console.log(`[injuries] ${summary.fixtures} fixture(s) asked · ${summary.written} player(s) listed `
      + `(${summary.out} out, ${summary.doubt} doubt) · ${summary.empty} with an empty list`
      + (DRY_RUN ? ' · DRY RUN, nothing written' : ''));
    if (summary.failed.length) {
      console.log(`[injuries] ${summary.failed.length} failed:`);
      for (const f of summary.failed.slice(0, 20)) console.log(`  ${f}`);
    }
    // Every call failing is an outage, not a quiet slate, and must go red.
    if (targets.length > 0 && summary.fixtures === 0) process.exitCode = 1;
    const q = apiQuota.latestReading();
    if (q) console.log(`[injuries] ${apiQuota.describeQuota(q)}`);
  } finally {
    dog.finish();
  }
}

module.exports = { parseInjuries, statusFor, vendorError };

if (require.main === module) {
  main()
    .then(() => apiQuota.persistQuota(getClient()))
    .catch((e) => { console.error(`[injuries] fatal: ${e.message}`); process.exit(1); });
}
