/**
 * settleFollows.js — settle the Following tab, and DM members when one lands.
 *
 * WHAT IT IS FOR
 * A Plus member follows "Saka on target 1+" or "Over 9.5 corners" with no
 * stake and no price (migration 180). This job, run after fetchResults.js in
 * the engine workflow, does three things:
 *
 *   1. FETCH: player follows need /fixtures/players for their fixture. The
 *      nightly backfill (03:40 and 22:40 UTC) would leave a 3pm follow open
 *      until the small hours, so any completed fixture someone follows is
 *      fetched here as soon as the vendor has had time to settle it. One call
 *      per followed fixture, a handful a day against a 75k allowance.
 *   2. SETTLE: settle_follows() in the database. The rule lives there, in
 *      follow_measure(), because the live progress bar reads the same
 *      function. There is no second copy of it in this file on purpose.
 *   3. ALERT: a Discord DM to each member whose follow landed, through the
 *      MaxEdge bot, if they linked Discord on /me/settings (migration 138).
 *      Discord only lets a bot DM someone who shares a server with it and
 *      allows DMs, so a refused DM is recorded on the row (`alert_note`) and
 *      shown on /me, not retried forever.
 *
 * ABSENT IS NOT ZERO
 * A fetch that returns no player data is NOT logged, so the next run asks
 * again. settle_follows() voids a follow as not_reported only once 36 hours
 * have passed with nothing.
 *
 * ENV
 *   SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, API_FOOTBALL_KEY
 *   DISCORD_BOT_TOKEN          the MaxEdge bot (same one syncDiscordRoles uses)
 *   FOLLOW_ALERTS_ENABLED=1    actually send DMs; anything else is a dry run
 *   DRY_RUN=1                  no fetch writes, no settlement, no DMs
 *
 * Usage:  node settleFollows.js
 */
'use strict';

const { getClient } = require('./lib/supabaseClient');
const apiQuota = require('./lib/apiFootballQuota');
const { discordApi } = require('./lib/discordRoles');
const ps = require('./backfillPlayerStats');

/** The vendor needs time after full time to settle player stats (backfillPlayerStats SETTLE_HOURS is 3). */
const FETCH_AFTER_KICKOFF_MIN = 150;
const MAX_FETCHES = 60;
const MAX_DMS = 100;
const SITE = 'https://maxedge.live';

const STAT_WORDS = {
  shots: 'shots',
  shots_on_target: 'on target',
  fouls_committed: 'fouls',
  fouls_drawn: 'fouled',
  cards: 'cards',
  goals: 'goals',
  assists: 'assists',
  corners: 'corners',
  btts: 'both teams to score',
};

function lineWords(comparator, line) {
  const n = Number(line);
  if (comparator === 'gte') return `${n}+`;
  return `${comparator === 'over' ? 'Over' : 'Under'} ${n}`;
}

/** "Saka, on target 1+" · "Over 9.5 corners" · "Arsenal cards Under 2.5" · "Both teams to score". */
function followLabel(f) {
  const stat = STAT_WORDS[f.stat] ?? f.stat;
  if (f.stat === 'btts') return f.comparator === 'under' ? 'Both teams to score: No' : 'Both teams to score';
  if (f.subject === 'player') return `${f.player_name ?? 'Player'}, ${stat} ${lineWords(f.comparator, f.line)}`;
  const side = f.subject === 'home' ? f.home_name : f.subject === 'away' ? f.away_name : null;
  const core = f.comparator === 'gte' ? `${stat} ${lineWords(f.comparator, f.line)}` : `${lineWords(f.comparator, f.line)} ${stat}`;
  return side ? `${side} ${core}` : core.charAt(0).toUpperCase() + core.slice(1);
}

/** The DM. No odds, no tip language: a fact about a match, and the compliance line. */
function alertText(f) {
  const match = [f.home_name, f.away_name].filter(Boolean).join(' v ');
  const count = f.progress == null ? '' : ` (${Number(f.progress)})`;
  return [
    `Landed: ${followLabel(f)}${count}`,
    match,
    `${SITE}/match/${f.match_id}`,
    '18+ | BeGambleAware',
  ].filter(Boolean).join('\n');
}

/**
 * Only ask the vendor about a fixture once it has had time to settle, and
 * then back off: every run for the first half hour, then once an hour (the
 * first run past the top of the hour). A fixture the vendor never covers is
 * not logged, so without the back-off it would cost one call every five
 * minutes for the 36 hours before settle_follows() voids it.
 */
function readyToFetch(row, now = Date.now()) {
  const ko = Date.parse(row.kickoff_at);
  if (!Number.isFinite(ko)) return false;
  const age = now - ko;
  if (age < FETCH_AFTER_KICKOFF_MIN * 60e3) return false;
  if (age < (FETCH_AFTER_KICKOFF_MIN + 30) * 60e3) return true;
  return new Date(now).getUTCMinutes() < 6;
}

/** Why a DM failed, in words /me can show. Discord 50007 = cannot send to this user. */
function dmFailureNote(err) {
  if (err?.code === 50007) return 'dms_closed';
  if (err?.status === 403) return 'dms_closed';
  if (err?.status === 404) return 'not_found';
  return 'error';
}

async function fetchFollowedFixtures(supabase, { dry }) {
  const { data, error } = await supabase.from('follow_fixtures_to_fetch').select('*').limit(500);
  if (error) throw new Error(`follows[to_fetch]: ${error.message}`);
  const due = (data ?? []).filter(r => readyToFetch(r)).slice(0, MAX_FETCHES);
  if (!due.length) return { asked: 0, logged: 0 };
  if (!process.env.API_FOOTBALL_KEY) {
    console.log(`[follows] ${due.length} fixture(s) need player stats but API_FOOTBALL_KEY is not set`);
    return { asked: 0, logged: 0 };
  }
  const teams = await ps.teamMap(supabase);
  let asked = 0, logged = 0;
  for (const m of due) {
    asked++;
    try {
      const json = await ps.fetchPlayers(m.external_id);
      const errs = ps.apiErrors(json);
      if (errs.length) throw new Error(errs.join('; '));
      const home = teams.get(m.home_team_id) ?? {}, away = teams.get(m.away_team_id) ?? {};
      const oriented = ps.orientPlayerBlocks(json.response, {
        homeApiId: home.apiId, awayApiId: away.apiId, homeName: home.name, awayName: away.name,
      });
      const meta = { fixtureId: m.external_id, matchId: m.match_id, leagueId: m.league_id, kickoffAt: m.kickoff_at };
      const rows = oriented ? ps.playerRows(meta, oriented) : [];
      // Nothing yet: do not log, so the next run asks again (absent is not zero).
      if (!rows.length || dry) continue;
      await ps.upsert(supabase, 'player_match_stats', ps.uniqueBy(rows, r => `${r.fixture_id}:${r.player_id}`), 'fixture_id,player_id');
      await ps.upsert(supabase, 'player_stats_fetch_log', [ps.logRow(m.external_id, rows, oriented.by)], 'fixture_id');
      logged++;
    } catch (e) {
      console.log(`  warn fixture ${m.external_id}: ${e.message}`);
    }
  }
  await apiQuota.persistQuota(supabase).catch(() => {});
  return { asked, logged };
}

/**
 * LIVE PLAYER COUNTS. The vendor updates /fixtures/players every minute in
 * play, so each run asks about the live fixtures a member follows a player
 * on and writes the counts to player_live_stats (migration 183). That table
 * feeds the live bar only; settlement reads the full-time fetch above.
 */
function liveRows(fixtureId, playerRows, at = new Date().toISOString()) {
  return playerRows.map((r) => ({
    fixture_id: String(fixtureId), player_id: r.player_id, minutes: r.minutes,
    shots_total: r.shots_total, shots_on: r.shots_on, fouls_committed: r.fouls_committed,
    fouls_drawn: r.fouls_drawn, yellow: r.yellow, red: r.red, goals: r.goals, assists: r.assists,
    fetched_at: at,
  }));
}

async function fetchLivePlayers(supabase, { dry }) {
  const { data, error } = await supabase.from('follow_live_fixtures').select('*').limit(60);
  if (error) throw new Error(`follows[live]: ${error.message}`);
  const live = data ?? [];
  if (!live.length || !process.env.API_FOOTBALL_KEY) return { asked: 0, written: 0 };
  const teams = await ps.teamMap(supabase);
  let asked = 0, written = 0;
  for (const m of live) {
    asked++;
    try {
      const json = await ps.fetchPlayers(m.external_id);
      if (ps.apiErrors(json).length) continue;
      const home = teams.get(m.home_team_id) ?? {}, away = teams.get(m.away_team_id) ?? {};
      const oriented = ps.orientPlayerBlocks(json.response, {
        homeApiId: home.apiId, awayApiId: away.apiId, homeName: home.name, awayName: away.name,
      });
      const meta = { fixtureId: m.external_id, matchId: m.match_id, leagueId: m.league_id, kickoffAt: m.kickoff_at };
      const rows = oriented ? liveRows(m.external_id, ps.playerRows(meta, oriented)) : [];
      if (!rows.length || dry) continue;
      await ps.upsert(supabase, 'player_live_stats', ps.uniqueBy(rows, (r) => `${r.fixture_id}:${r.player_id}`), 'fixture_id,player_id');
      written += rows.length;
    } catch (e) {
      console.log(`  warn live fixture ${m.external_id}: ${e.message}`);
    }
  }
  return { asked, written };
}

async function sendAlerts(supabase, { send }) {
  const { data, error } = await supabase.from('follow_alerts_due').select('*').limit(MAX_DMS);
  if (error) throw new Error(`follows[alerts]: ${error.message}`);
  const due = data ?? [];
  const token = process.env.DISCORD_BOT_TOKEN;
  let sent = 0, failed = 0;
  for (const f of due) {
    if (!send || !token) { console.log(`[follows] would DM ${f.discord_user_id}: ${alertText(f).split('\n')[0]}`); continue; }
    let note = 'sent';
    try {
      const channel = await discordApi('/users/@me/channels', { method: 'POST', token, json: { recipient_id: f.discord_user_id } });
      await discordApi(`/channels/${channel.id}/messages`, { method: 'POST', token, json: { content: alertText(f) } });
      sent++;
    } catch (e) {
      note = dmFailureNote(e); failed++;
    }
    // A closed DM or an unknown user is final. Anything else (a timeout, a
    // 5xx) is left owed, so the next run tries again while the 24-hour
    // window in follow_alerts_due lasts.
    const final = note !== 'error';
    const { error: upErr } = await supabase.from('follows')
      .update(final ? { alerted_at: new Date().toISOString(), alert_note: note } : { alert_note: note }).eq('id', f.id);
    if (upErr) console.log(`  warn alert ${f.id}: ${upErr.message}`);
  }
  return { due: due.length, sent, failed };
}

async function main() {
  const dry = process.env.DRY_RUN === '1';
  const send = !dry && process.env.FOLLOW_ALERTS_ENABLED === '1';
  const supabase = getClient();

  const live = await fetchLivePlayers(supabase, { dry });
  console.log(`[follows] live player stats: ${live.asked} fixture(s), ${live.written} row(s)`);

  const fetched = await fetchFollowedFixtures(supabase, { dry });
  console.log(`[follows] player stats: asked ${fetched.asked}, logged ${fetched.logged}`);

  if (!dry) {
    const { data, error } = await supabase.rpc('settle_follows');
    if (error) throw new Error(`settle_follows: ${error.message}`);
    const r = Array.isArray(data) ? data[0] : data;
    console.log(`[follows] settled ${r?.settled ?? 0}, voided ${r?.voided ?? 0}, waiting ${r?.waiting ?? 0}`);
  }

  const alerts = await sendAlerts(supabase, { send });
  console.log(`[follows] alerts due ${alerts.due}, sent ${alerts.sent}, failed ${alerts.failed}${send ? '' : ' (dry: FOLLOW_ALERTS_ENABLED is not 1)'}`);
}

if (require.main === module) {
  main().catch(err => { console.error('[follows] FATAL:', err.message); process.exit(1); });
}

module.exports = { followLabel, alertText, lineWords, readyToFetch, dmFailureNote, liveRows, FETCH_AFTER_KICKOFF_MIN };
