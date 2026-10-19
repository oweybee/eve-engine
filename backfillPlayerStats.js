/**
 * backfillPlayerStats.js — per-player statistics for every finished fixture.
 *
 * WHAT IT IS FOR
 * NumbersGame-style player hit rates on the match card: shots, shots on
 * target, cards and fouls per player over the last N games. API-Football serves
 * all of it from /fixtures/players on the plan we already pay for; until 19 Oct
 * 2026 nothing here called it. `lineups` held who played, nothing held what
 * they did. migration 160 holds the tables and the public read, player_form().
 *
 * ONE SCRIPT, TWO JOBS
 *   - the BACKLOG: every finished fixture in the current + previous season
 *     (about 17k on 19 Oct 2026), fetched newest first so current form lands
 *     before old history does;
 *   - the DAILY TOP-UP: the same run, which by then only finds the fixtures
 *     finished since yesterday. Fully resumable, so there is one code path.
 *
 * "Every fixture" means every fixture in `matches` with a numeric API-Football
 * external_id and a final score, in every league we track. Not just the ones
 * we price, and not just England.
 *
 * ABSENT IS NOT ZERO
 * The vendor sends shots.total = null for a player who did not shoot, so inside
 * a covered fixture null means 0. In a league it does not cover at player
 * level, everything is null and "0 shots in 10" would be a lie about a striker.
 * So each fixture's log row records which stat families it actually reported
 * (fixtureCoverage below), and player_form() only counts a game toward a stat
 * when that family was there.
 *
 * COST AND SAFETY
 * One call per fixture, no bulk form. The daily allowance (75k) is shared with
 * odds ingestion, the live loop and match stats, which together spend ~33k a
 * day. So the run is budgeted (--max-calls), paced (--rpm, kept well under the
 * 450/min ceiling because backfill-match-stats may run alongside), and it
 * STOPS when the vendor's own remaining-today header drops under --reserve.
 * The odds feed is the product; this is a nice-to-have and must never starve it.
 *
 * WRITE ORDER
 * Player rows first, then the fixture's log row. The log row is what marks a
 * fixture done, so a crash between the two re-fetches it rather than leaving a
 * fixture marked done with no players.
 *
 * Usage:
 *   node backfillPlayerStats.js                         # current + previous season
 *   node backfillPlayerStats.js --seasons 2025,2026
 *   node backfillPlayerStats.js --max-calls 500 --rpm 120
 *   node backfillPlayerStats.js --fixture 1379123       # one fixture, prints the parse
 *   node backfillPlayerStats.js --dry-run               # plan only, no calls
 *   node backfillPlayerStats.js --refetch-empty         # retry fixtures that had nothing
 */
'use strict';

const https = require('https');
const { getClient }         = require('./lib/supabaseClient');
const apiQuota              = require('./lib/apiFootballQuota');
const { currentSeasonYear } = require('./backfillSeasonFixtures');
const { spanOf, isApiFixtureId, apiErrors, normaliseName, rateLimiter } = require('./backfillMatchStats');

const API_HOST = 'v3.football.api-sports.io';
const API_KEY  = process.env.API_FOOTBALL_KEY;

const args = process.argv.slice(2);
const flag = (name, fb) => {
  const i = args.indexOf(name);
  return i !== -1 && args[i + 1] ? args[i + 1] : fb;
};
const num = (name, fb) => {
  const v = parseInt(flag(name, ''), 10);
  return Number.isFinite(v) ? v : fb;
};

const DRY           = args.includes('--dry-run');
const REFETCH_EMPTY = args.includes('--refetch-empty');
const ONE_FIXTURE   = flag('--fixture', '');
const MAX_CALLS     = num('--max-calls',   parseInt(process.env.PLAYER_STATS_MAX_CALLS   || '10000', 10));
const RPM           = num('--rpm',         parseInt(process.env.PLAYER_STATS_RPM         || '150',   10));
const CONCURRENCY   = num('--concurrency', parseInt(process.env.PLAYER_STATS_CONCURRENCY || '3',     10));
const RESERVE       = num('--reserve',     parseInt(process.env.PLAYER_STATS_RESERVE     || '20000', 10));
// The minute is shared (450/min): pause when fewer than this are left in it,
// and give up only after this many per-minute refusals in one run.
const MINUTE_FLOOR     = num('--minute-floor', parseInt(process.env.PLAYER_STATS_MINUTE_FLOOR || '60', 10));
const MAX_MINUTE_WAITS = 200;
const PAGE          = 1000;
const WRITE_CHUNK   = 500;
/** A fixture is only "finished" for our purposes once the vendor has had time to settle player stats. */
const SETTLE_HOURS  = 3;

// ── Pure helpers (unit-tested in engine.playerstats.test.js) ─────────────────

/**
 * The vendor's numbers arrive as numbers, numeric strings ("7.3", "85"),
 * percentage strings ("85%") or null. Anything else is null, never NaN.
 */
function toNum(v) {
  if (v == null || v === '') return null;
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  const n = parseFloat(String(v).replace('%', '').trim());
  return Number.isFinite(n) ? n : null;
}
const toInt = v => { const n = toNum(v); return n == null ? null : Math.round(n); };

/**
 * Which block is home and which is away. Three ways, best first:
 *   team_id — the API team id matches teams.external_id (exact, no guessing)
 *   name    — the loose name comparison backfillMatchStats already uses
 *   order   — the API's [home, away] convention, the old assumption
 * Reports which it used so a league with broken identity shows up as a number.
 */
function orientPlayerBlocks(response, ids = {}) {
  const blocks = Array.isArray(response) ? response.filter(b => b && b.team) : [];
  if (!blocks.length) return null;
  const { homeApiId, awayApiId, homeName, awayName } = ids;

  const withSides = (homeIdx, by) => ({
    by,
    blocks: blocks.map((b, i) => ({
      side: blocks.length === 2 ? (i === homeIdx ? 'home' : 'away') : (i === 0 ? 'home' : 'away'),
      team: b.team, players: Array.isArray(b.players) ? b.players : [],
    })),
  });

  if (blocks.length === 2) {
    const id0 = toInt(blocks[0].team.id), id1 = toInt(blocks[1].team.id);
    const h = toInt(homeApiId), a = toInt(awayApiId);
    if (h && a) {
      if (id0 === h && id1 === a) return withSides(0, 'team_id');
      if (id0 === a && id1 === h) return withSides(1, 'team_id');
    }
    const hn = normaliseName(homeName), an = normaliseName(awayName);
    const n0 = normaliseName(blocks[0].team.name), n1 = normaliseName(blocks[1].team.name);
    const hit = (x, y) => Boolean(x && y) && (x.includes(y) || y.includes(x));
    if (hit(n0, hn) && hit(n1, an)) return withSides(0, 'name');
    if (hit(n0, an) && hit(n1, hn)) return withSides(1, 'name');
  }
  return withSides(0, 'order');
}

/** One table row per player who actually played (minutes > 0). Unused subs are skipped. */
function playerRows(meta, oriented, at = new Date().toISOString()) {
  const out = [];
  for (const blk of oriented?.blocks ?? []) {
    for (const p of blk.players) {
      const pid = toInt(p?.player?.id);
      const st  = Array.isArray(p?.statistics) ? (p.statistics[0] ?? {}) : {};
      const g   = st.games ?? {};
      const minutes = toInt(g.minutes);
      if (!pid || !minutes || minutes <= 0) continue;
      out.push({
        fixture_id:        String(meta.fixtureId),
        player_id:         pid,
        match_id:          meta.matchId ?? null,
        league_id:         meta.leagueId ?? null,
        kickoff_at:        meta.kickoffAt,
        team_api_id:       toInt(blk.team?.id),
        team_name:         blk.team?.name ?? null,
        team_side:         blk.side,
        player_name:       p.player.name ?? null,
        player_position:   g.position ?? null,
        shirt_number:      toInt(g.number),
        is_sub:            g.substitute == null ? null : Boolean(g.substitute),
        captain:           g.captain == null ? null : Boolean(g.captain),
        minutes,
        rating:            toNum(g.rating),
        shots_total:       toInt(st.shots?.total),
        shots_on:          toInt(st.shots?.on),
        goals:             toInt(st.goals?.total),
        assists:           toInt(st.goals?.assists),
        goals_conceded:    toInt(st.goals?.conceded),
        saves:             toInt(st.goals?.saves),
        passes_total:      toInt(st.passes?.total),
        passes_key:        toInt(st.passes?.key),
        pass_accuracy:     toInt(st.passes?.accuracy),
        tackles:           toInt(st.tackles?.total),
        blocks:            toInt(st.tackles?.blocks),
        interceptions:     toInt(st.tackles?.interceptions),
        duels_total:       toInt(st.duels?.total),
        duels_won:         toInt(st.duels?.won),
        dribbles_attempts: toInt(st.dribbles?.attempts),
        dribbles_success:  toInt(st.dribbles?.success),
        fouls_committed:   toInt(st.fouls?.committed),
        fouls_drawn:       toInt(st.fouls?.drawn),
        yellow:            toInt(st.cards?.yellow),
        red:               toInt(st.cards?.red),
        offsides:          toInt(st.offsides),
        pen_won:           toInt(st.penalty?.won),
        pen_committed:     toInt(st.penalty?.commited ?? st.penalty?.committed),
        pen_scored:        toInt(st.penalty?.scored),
        pen_missed:        toInt(st.penalty?.missed),
        pen_saved:         toInt(st.penalty?.saved),
        raw:               st,
        fetched_at:        at,
      });
    }
  }
  return out;
}

/**
 * Which stat families this fixture REPORTED. The rule per family:
 *   shots  — some player has a non-null shots.total. Nobody shooting in a whole
 *            match does not happen, so all-null means "not covered".
 *   cards / fouls — the vendor zero-fills cards even where it has no player
 *            detail, so a 0 there proves nothing on its own. These count only
 *            when the fixture also shows real player detail (a rating or a pass
 *            count) AND some non-null value in the family.
 *   detail — some player has a pass count. Every covered match has passes, so
 *            this is the coverage for the "full detail" stats: tackles, saves,
 *            offsides and passes, where the vendor sends null for zero (a keeper
 *            who made no saves, a game with no offsides). Added 19 Oct 2026 for
 *            the second batch of player markets (migration 164).
 */
function fixtureCoverage(rows) {
  const any = (f) => rows.some(f);
  const detail = any(r => r.rating != null || r.passes_total != null);
  return {
    has_shots: any(r => r.shots_total != null),
    has_cards: detail && any(r => r.yellow != null || r.red != null),
    has_fouls: detail && any(r => r.fouls_committed != null || r.fouls_drawn != null),
    has_detail: any(r => r.passes_total != null),
  };
}

function logRow(fixtureId, rows, by, at = new Date().toISOString()) {
  return {
    fixture_id: String(fixtureId),
    fetched_at: at,
    players:    rows.length,
    oriented_by: rows.length ? by : null,
    ...(rows.length ? fixtureCoverage(rows) : { has_shots: false, has_cards: false, has_fouls: false, has_detail: false }),
  };
}

/**
 * The vendor's PER-MINUTE ceiling (450, shared with the live loop and odds
 * ingestion) arrives as a 200 with "...requests per minute..." in `errors`.
 * Unlike the daily allowance it clears within the minute, so it is a reason to
 * wait and retry the fixture, never to end the run. (19 Oct 2026: the first
 * full run stopped after 58 calls on exactly this, with 48k of the day left.)
 */
function isMinuteLimit(message) {
  return /per minute/i.test(String(message ?? ''));
}

/** Leave this many calls of the shared minute to the live loop and odds jobs. */
function minuteHeadroomLow(reading, floor) {
  return Boolean(reading && Number.isFinite(reading.remainingMinute) && reading.remainingMinute < floor);
}

/** Should the run stop to protect the shared daily allowance? */
function quotaTooLow(reading, reserve) {
  return Boolean(reading && Number.isFinite(reading.remainingDay) && reading.remainingDay < reserve);
}

// ── HTTP ────────────────────────────────────────────────────────────────────

const sleep = ms => new Promise(r => setTimeout(r, ms));

function getOnce(path) {
  return new Promise((resolve, reject) => {
    const req = https.request(
      { method: 'GET', hostname: API_HOST, path, headers: { 'x-apisports-key': API_KEY } },
      res => {
        let body = '';
        res.on('data', c => { body += c; });
        res.on('end', () => {
          apiQuota.report(res.headers);
          if (res.statusCode === 429) { reject(Object.assign(new Error('429 rate limited'), { is429: true })); return; }
          if (res.statusCode !== 200) { reject(new Error(`HTTP ${res.statusCode}: ${body.slice(0, 200)}`)); return; }
          try { resolve(JSON.parse(body)); } catch (e) { reject(new Error(`JSON parse: ${e.message}`)); }
        });
      });
    req.setTimeout(30_000, () => req.destroy(new Error('timeout')));
    req.on('error', reject).end();
  });
}

async function fetchPlayers(fixtureId) {
  for (let attempt = 1; ; attempt++) {
    try { return await getOnce(`/fixtures/players?fixture=${fixtureId}`); }
    catch (e) {
      if (attempt >= 3) throw e;
      await sleep(e.is429 ? 15_000 : 1_000 * attempt);
    }
  }
}

// ── Data access ─────────────────────────────────────────────────────────────

async function selectAll(query, describe) {
  const out = [];
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await query().range(from, from + PAGE - 1);
    if (error) throw new Error(`${describe}: ${error.message}`);
    out.push(...(data ?? []));
    if (!data || data.length < PAGE) return out;
  }
}

async function candidateFixtures(supabase, span) {
  const settled = new Date(Date.now() - SETTLE_HOURS * 3600e3).toISOString();
  const rows = await selectAll(() => supabase
    .from('matches')
    .select('id, external_id, league_id, home_team_id, away_team_id, kickoff_at')
    .not('external_id', 'is', null)
    .not('goals_home', 'is', null)
    .gte('kickoff_at', `${span.from}T00:00:00Z`)
    .lte('kickoff_at', settled)
    .order('kickoff_at', { ascending: false }), 'playerStats[candidates]');
  return uniqueFixtures(rows.filter(r => isApiFixtureId(r.external_id)));
}

/**
 * One fixture id, one call. `matches` can hold the same API fixture twice
 * (the 15 Oct duplicate-matches issue), and fetching it twice put the same
 * (fixture_id, player_id) into one upsert, which Postgres refuses outright
 * ("ON CONFLICT DO UPDATE command cannot affect row a second time"): the
 * 19 Oct run died on it after 442 fixtures. Keeps the first (newest) row.
 */
function uniqueFixtures(rows) {
  const seen = new Set();
  return rows.filter(r => { const k = String(r.external_id); if (seen.has(k)) return false; seen.add(k); return true; });
}

/** Last write wins per key, so one upsert never names a row twice. */
function uniqueBy(rows, keyOf) {
  const m = new Map();
  for (const r of rows) m.set(keyOf(r), r);
  return [...m.values()];
}

async function alreadyCovered(supabase, { refetchEmpty }) {
  const rows = await selectAll(() => {
    let q = supabase.from('player_stats_fetch_log').select('fixture_id');
    if (refetchEmpty) q = q.gt('players', 0);
    return q;
  }, 'playerStats[covered]');
  return new Set(rows.map(r => String(r.fixture_id)));
}

async function teamMap(supabase) {
  const rows = await selectAll(() => supabase.from('teams').select('id, name, external_id'), 'playerStats[teams]');
  return new Map(rows.map(r => [r.id, { name: r.name, apiId: r.external_id }]));
}

async function upsert(supabase, table, rows, onConflict) {
  for (let i = 0; i < rows.length; i += WRITE_CHUNK) {
    const { error } = await supabase.from(table).upsert(rows.slice(i, i + WRITE_CHUNK), { onConflict });
    if (error) throw new Error(`playerStats[${table} @${i}]: ${error.message}`);
  }
}

// ── The run ─────────────────────────────────────────────────────────────────

async function main() {
  if (!API_KEY && !DRY) {
    console.log('[playerStats] API_FOOTBALL_KEY not set — aborting');
    process.exit(1);
  }
  const supabase = getClient();
  const teams = await teamMap(supabase);

  const seasons = flag('--seasons', '').split(',').map(s => parseInt(s.trim(), 10)).filter(Number.isFinite);
  const resolved = seasons.length ? seasons : [currentSeasonYear(), currentSeasonYear() - 1];
  const span = spanOf(resolved);

  let candidates = await candidateFixtures(supabase, span);
  if (ONE_FIXTURE) candidates = candidates.filter(m => String(m.external_id) === ONE_FIXTURE);
  const covered = ONE_FIXTURE ? new Set() : await alreadyCovered(supabase, { refetchEmpty: REFETCH_EMPTY });
  const todo = candidates.filter(m => !covered.has(String(m.external_id)));

  console.log(`[playerStats] seasons ${resolved.sort().join(', ')} · ${candidates.length} finished fixture(s) · ` +
              `${covered.size} already logged · ${todo.length} to fetch`);
  console.log(`[playerStats] budget ${MAX_CALLS} call(s), ${RPM}/min, concurrency ${CONCURRENCY}, ` +
              `stop when vendor remaining-today < ${RESERVE}`);
  if (DRY || !todo.length) return;

  const queue = todo.slice(0, MAX_CALLS);
  const take  = rateLimiter(RPM);
  let cursor = 0, calls = 0, fixturesDone = 0, playerCount = 0, empties = 0, failures = 0, stopped = null;
  let minuteWaits = 0, minuteYields = 0;
  const by = { team_id: 0, name: 0, order: 0 };
  const cov = { has_shots: 0, has_cards: 0, has_fouls: 0, has_detail: 0 };
  let pendingPlayers = [], pendingLogs = [];

  async function flush() {
    if (!pendingLogs.length) return;
    const p = pendingPlayers, l = pendingLogs;
    pendingPlayers = []; pendingLogs = [];
    // The vendor can also list one player twice in a fixture; same rule.
    await upsert(supabase, 'player_match_stats', uniqueBy(p, r => `${r.fixture_id}:${r.player_id}`), 'fixture_id,player_id');
    await upsert(supabase, 'player_stats_fetch_log', uniqueBy(l, r => r.fixture_id), 'fixture_id');
    console.log(`[playerStats] ${fixturesDone}/${queue.length} fixture(s) · ${playerCount} player row(s) written`);
  }

  async function worker() {
    for (;;) {
      if (stopped) return;
      const m = queue[cursor++];
      if (!m) return;
      if (quotaTooLow(apiQuota.latestReading(), RESERVE)) {
        stopped = `vendor reports ${apiQuota.latestReading().remainingDay} left today, under the ${RESERVE} reserve`;
        return;
      }
      if (minuteHeadroomLow(apiQuota.latestReading(), MINUTE_FLOOR)) {
        minuteYields++;
        await sleep(10_000);
      }
      await take();
      calls++;
      try {
        const json = await fetchPlayers(m.external_id);
        const errs = apiErrors(json);
        if (errs.length) throw new Error(`API error: ${errs.join('; ')}`);
        const home = teams.get(m.home_team_id) ?? {}, away = teams.get(m.away_team_id) ?? {};
        const oriented = orientPlayerBlocks(json.response, {
          homeApiId: home.apiId, awayApiId: away.apiId, homeName: home.name, awayName: away.name,
        });
        const meta = { fixtureId: m.external_id, matchId: m.id, leagueId: m.league_id, kickoffAt: m.kickoff_at };
        const rows = oriented ? playerRows(meta, oriented) : [];
        const log  = logRow(m.external_id, rows, oriented?.by);
        if (ONE_FIXTURE) {
          console.log(JSON.stringify({ oriented_by: oriented?.by, log, sample: rows.slice(0, 3).map(r => ({ ...r, raw: undefined })) }, null, 2));
        }
        if (!rows.length) empties++;
        else { by[oriented.by]++; for (const k of Object.keys(cov)) if (log[k]) cov[k]++; }
        pendingPlayers.push(...rows); pendingLogs.push(log);
        playerCount += rows.length; fixturesDone++;
      } catch (e) {
        if (isMinuteLimit(e.message)) {
          // Not a failure: put the fixture back and give the minute time to clear.
          minuteWaits++;
          if (minuteWaits > MAX_MINUTE_WAITS) { stopped = `per-minute limit hit ${minuteWaits} times`; return; }
          queue.push(m);
          await sleep(30_000);
          continue;
        }
        failures++;
        if (/quota|exceeded|request limit/i.test(e.message)) { stopped = `quota: ${e.message}`; return; }
        if (failures <= 20) console.log(`  warn fixture ${m.external_id}: ${e.message}`);
      }
      if (pendingPlayers.length >= WRITE_CHUNK * 2 || pendingLogs.length >= 200) await flush();
    }
  }

  await Promise.all(Array.from({ length: Math.max(1, CONCURRENCY) }, worker));
  await flush();
  const persisted = await apiQuota.persistQuota(getClient());

  const withRows = fixturesDone - empties;
  const pct = n => (withRows ? `${Math.round((100 * n) / withRows)}%` : '—');
  console.log(`\n[playerStats] ${calls} call(s) · ${fixturesDone} fixture(s) logged · ${playerCount} player row(s) · ` +
              `${empties} with no player data · ${failures} failure(s)`);
  console.log(`[playerStats] of fixtures with players: shots reported ${pct(cov.has_shots)}, ` +
              `cards ${pct(cov.has_cards)}, fouls ${pct(cov.has_fouls)}, detail ${pct(cov.has_detail)}`);
  console.log(`[playerStats] home/away by team id ${by.team_id}, by name ${by.name}, by order ${by.order}`);
  console.log(`[playerStats] quota: ${persisted.written ? apiQuota.describeQuota(persisted.quota) : persisted.reason}`);
  if (minuteWaits || minuteYields) {
    console.log(`[playerStats] shared minute: ${minuteWaits} limit hit(s) retried, ${minuteYields} pause(s) to leave headroom`);
  }
  if (stopped) console.log(`[playerStats] stopped early: ${stopped}. Re-run to continue; nothing logged is refetched.`);
  const remaining = todo.length - fixturesDone;
  if (remaining > 0) console.log(`[playerStats] ${remaining} fixture(s) still to do.`);

  if (calls > 0 && failures === calls && !stopped) {
    console.error(`[playerStats] FATAL: all ${calls} call(s) failed — nothing loaded.`);
    process.exit(1);
  }
}

if (require.main === module) {
  main().catch(err => { console.error('[playerStats] FATAL:', err.message); process.exit(1); });
}

module.exports = { toNum, toInt, orientPlayerBlocks, playerRows, fixtureCoverage, logRow, quotaTooLow, isMinuteLimit, minuteHeadroomLow, uniqueFixtures, uniqueBy };
