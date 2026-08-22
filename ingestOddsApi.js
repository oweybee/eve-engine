/**
 * ingestOddsApi.js — The Odds API ingest: UK soft-book BREADTH.
 *
 * Complements ingestOdds.js (API-Football) rather than replacing it. Writes into
 * the same `odds` table under each book's own key, so computeValues /
 * computeModelBoard automatically pick the best price across the UNION of both
 * feeds — no downstream changes.
 *
 * WHY IT'S CHEAP
 * One request per league returns every upcoming event with every bookmaker, so
 * cost scales with leagues × polls, not fixtures. And because API-Football
 * already supplies high-frequency polling, we only need The Odds API often
 * enough to know where the soft books sit. Sized for the 100k-credit tier:
 *
 *   pre-match  ~13 polls/league/day, regions=uk, markets=h2h,totals  ≈ 19k/mo
 *   in-play     60s while matches are live, markets=h2h              ≈ 62k/mo
 *
 * HARD CREDIT GUARD
 * Every response returns x-requests-remaining — the authoritative counter. We
 * persist it and refuse to issue another request once ODDS_API_RESERVE credits
 * remain, so a misconfigured loop cannot drain the month. The free /v4/sports
 * catalogue call is used to resolve sport keys, so a renamed key surfaces as a
 * logged warning instead of a silently dropped league.
 *
 * Usage:
 *   node ingestOddsApi.js                 # pre-match sweep
 *   node ingestOddsApi.js --inplay        # live sweep (h2h only)
 *   node ingestOddsApi.js --dry-run
 */
'use strict';

const { getClient } = require('./lib/supabaseClient');
const { clubKey } = require('./lib/lambdaBoard');
const {
  httpGetJson, quotaFromHeaders, requestCost, canSpend, mapSportKeys, parseEvent,
} = require('./lib/oddsApi');
const { planDailySpend, dailyLedger, withinDailyBudget } = require('./lib/oddsApiBudget');

const KEY = process.env.ODDS_API_KEY;
const DRY = process.argv.includes('--dry-run');
const INPLAY = process.argv.includes('--inplay');

const REGIONS = process.env.ODDS_API_REGIONS || 'uk';
const MARKETS = INPLAY
  ? (process.env.ODDS_API_MARKETS_INPLAY || 'h2h')
  : (process.env.ODDS_API_MARKETS_PREMATCH || 'h2h,totals');
const RESERVE = parseInt(process.env.ODDS_API_RESERVE || '2000', 10);
// Monthly pool (not daily) — the pacer divides it across the month's football.
const ALLOWANCE = parseInt(process.env.ODDS_API_MONTHLY_CREDITS || '100000', 10);
const INCLUDE_CUPS = process.env.ODDS_API_INCLUDE_CUPS !== 'false';
// Kickoff horizon for the pre-match sweep — no point pulling next month's games.
const HORIZON_HOURS = parseFloat(process.env.ODDS_API_HORIZON_HOURS || '72');
const MATCH_WINDOW_MIN = 90;   // fixture-matching tolerance on kickoff time

/** Persisted quota so the guard survives process restarts. */
async function loadQuota(supabase) {
  const { data } = await supabase
    .from('engine_state').select('value').eq('key', 'odds_api_quota').maybeSingle();
  try { return data?.value ? JSON.parse(data.value) : {}; } catch { return {}; }
}
async function saveQuota(supabase, q) {
  await supabase.from('engine_state')
    .upsert({ key: 'odds_api_quota', value: JSON.stringify(q), updated_at: new Date().toISOString() },
            { onConflict: 'key' });
}

/** Our fixtures, indexed for matching against Odds API events. */
async function loadFixtureIndex(supabase) {
  const statuses = INPLAY ? ['live'] : ['scheduled'];
  const { data, error } = await supabase
    .from('matches')
    .select(`id, kickoff_at, status,
             home_team:teams!matches_home_team_id_fkey ( name ),
             away_team:teams!matches_away_team_id_fkey ( name )`)
    .in('status', statuses);
  if (error) throw new Error(`oddsApi[matches]: ${error.message}`);
  const idx = new Map();
  for (const m of data ?? []) {
    const h = clubKey(m.home_team?.name);
    const a = clubKey(m.away_team?.name);
    if (!h || !a) continue;
    const list = idx.get(`${h}|${a}`) ?? [];
    list.push({ id: m.id, ko: new Date(m.kickoff_at).getTime() });
    idx.set(`${h}|${a}`, list);
  }
  return idx;
}

/**
 * Count "league-days" — the real cost driver, since one request covers a whole
 * league. Returns { today, elapsed, total } for the current UTC month:
 *   today   — tracked leagues with a fixture today (what this run may spend on)
 *   elapsed — league-days already played this month (pacing denominator)
 *   total   — league-days across the whole month (forecast; scheduled + played)
 * Falls back to safe defaults if the fixture calendar is thin.
 */
async function countLeagueDays(supabase) {
  const now = new Date();
  const monthStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
  const monthEnd = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1));
  const { data, error } = await supabase
    .from('matches')
    .select('kickoff_at, league_id')
    .gte('kickoff_at', monthStart.toISOString())
    .lt('kickoff_at', monthEnd.toISOString());
  if (error) {
    console.log(`[oddsApi] league-day count failed (${error.message}) — using defaults`);
    return { today: 1, elapsed: null, total: null };
  }
  const todayKey = now.toISOString().slice(0, 10);
  const all = new Set(), past = new Set(), todaySet = new Set();
  for (const m of data ?? []) {
    if (!m.league_id || !m.kickoff_at) continue;
    const day = String(m.kickoff_at).slice(0, 10);
    const key = `${m.league_id}|${day}`;
    all.add(key);
    if (day < todayKey) past.add(key);
    if (day === todayKey) todaySet.add(m.league_id);
  }
  return {
    today: Math.max(1, todaySet.size),
    elapsed: past.size,
    total: Math.max(all.size, past.size + todaySet.size) || null,
  };
}

/** Resolve an Odds API event to one of our match ids (names + kickoff proximity). */
function resolveMatch(idx, event) {
  const k = `${clubKey(event.home_team)}|${clubKey(event.away_team)}`;
  const cands = idx.get(k);
  if (!cands?.length) return null;
  const ko = new Date(event.commence_time).getTime();
  let best = null;
  for (const c of cands) {
    const gap = Math.abs(c.ko - ko);
    if (gap <= MATCH_WINDOW_MIN * 60_000 && (!best || gap < best.gap)) best = { ...c, gap };
  }
  return best?.id ?? null;
}

async function main() {
  if (!KEY) { console.log('[oddsApi] ODDS_API_KEY not set — skipping'); return; }
  const supabase = getClient();
  const quota = await loadQuota(supabase);
  const cost = requestCost(REGIONS, MARKETS);
  console.log(`[oddsApi] mode=${INPLAY ? 'inplay' : 'prematch'} regions=${REGIONS} ` +
              `markets=${MARKETS} cost/req=${cost} remaining=${quota.remaining ?? 'unknown'}`);

  if (!canSpend({ remaining: quota.remaining, cost, reserve: RESERVE })) {
    console.log(`[oddsApi] GUARD: ${quota.remaining} credits left (reserve ${RESERVE}) — stopping`);
    return;
  }

  // ── Monthly pacing ────────────────────────────────────────────────────────
  // The pool is MONTHLY, so spend is paced against how much football is left in
  // the month (league-days), not against calendar time. countLeagueDays() reads
  // the real fixture calendar; the plan then caps this run's spend.
  const cal = await countLeagueDays(supabase);
  const used = quota.remaining != null ? (ALLOWANCE - quota.remaining) : (quota.used ?? 0);
  const plan = planDailySpend({
    allowance: ALLOWANCE, used, reserve: RESERVE, now: new Date(),
    leagueDaysToday: cal.today, leagueDaysElapsed: cal.elapsed, leagueDaysTotal: cal.total,
    regions: REGIONS, marketsPrematch: MARKETS, marketsInplay: MARKETS,
  });
  console.log(`[oddsApi] pace=${plan.pace} throttle=${plan.throttle} ` +
              `progress=${(plan.progress * 100).toFixed(0)}% drift=${plan.drift} ` +
              `league-days today=${cal.today} month=${cal.total} ` +
              `→ ${plan.creditsPerLeagueDay} credits/league-day`);
  if (plan.exhausted) {
    console.log('[oddsApi] monthly pool exhausted — stopping');
    return;
  }
  // THE DAY'S CEILING, NOT THIS RUN'S. `plan.prematchCost` is polls x cost x
  // league-days — a DAY's allocation. This used to read `plan.prematchPolls`
  // as a per-run league cap, so every tick was free to spend the whole day's
  // budget again: 6,912 credits/day at a 15-minute cadence against an intended
  // 2,880, or 207,360 a month against a 100,000 allowance. See dailyLedger().
  const dailyCeiling = INPLAY ? plan.inplayCredits : plan.prematchCost;
  console.log(`[oddsApi] day ceiling: ${dailyCeiling} credit(s)`);

  // FREE catalogue call → resolve sport keys (a renamed key warns, never silently drops)
  const cat = await httpGetJson(`/v4/sports/?apiKey=${KEY}`);
  const { map, unmatched, unavailable, renamed, collisions } =
    mapSportKeys(cat.json, { includeCups: INCLUDE_CUPS });
  // Four different silences, named. `0 league(s) resolved` was the whole of
  // what this said while the matcher was broken, and it read like a quiet
  // catalogue rather than a table that could never match anything.
  if (unmatched.length) console.log(`[oddsApi] EXPECTED a sport key and did not find one: ${unmatched.join(', ')}`);
  if (unavailable.length) console.log(`[oddsApi] not offered by the feed at all: ${unavailable.join(', ')}`);
  for (const r of renamed) console.log(`[oddsApi] RENAMED — ${r}`);
  for (const c of collisions) console.log(`[oddsApi] COLLISION — ${c}`);
  const leagues = Object.entries(map);
  console.log(`[oddsApi] ${leagues.length} league(s) resolved`);
  if (!leagues.length) {
    console.log('[oddsApi] nothing resolved — the table and the catalogue disagree; ' +
                'run scripts/oddsApiCatalogue.js before touching lib/oddsApi.js');
  }

  const idx = await loadFixtureIndex(supabase);
  const nowMs = Date.now();
  const horizonMs = nowMs + HORIZON_HOURS * 3_600_000;

  const catQuota = quotaFromHeaders(cat.headers);
  let remaining = catQuota.remaining ?? quota.remaining ?? null;

  // The daily ledger is anchored on the API's own counter, read from the FREE
  // catalogue call above, so it is correct across restarts and concurrent runs.
  let usedNow = catQuota.used ?? quota.used ?? null;
  const today = new Date().toISOString().slice(0, 10);
  const ledger = dailyLedger({
    storedDay: quota.day, storedUsedAtDayStart: quota.usedAtDayStart, usedNow, today,
  });
  let spentToday = ledger.spentToday;
  console.log(`[oddsApi] spent today: ${spentToday ?? 'unknown'} of ${dailyCeiling} credit(s)`);

  const rows = [];
  let matched = 0, unmatchedEv = 0, polled = 0, skippedGuard = 0, stoppedOnDaily = false;

  for (const [corpusKey, sportKey] of leagues) {
    // One poll per league per run at most — the day's spread is the ceiling's job.
    if (!withinDailyBudget({ spentToday, cost, ceiling: dailyCeiling })) {
      stoppedOnDaily = true;
      break;
    }
    if (!canSpend({ remaining, cost, reserve: RESERVE })) { skippedGuard++; continue; }
    let res;
    try {
      res = await httpGetJson(
        `/v4/sports/${sportKey}/odds/?apiKey=${KEY}&regions=${REGIONS}` +
        `&markets=${MARKETS}&oddsFormat=decimal`);
    } catch (e) {
      console.log(`  warn ${corpusKey}: ${e.message}`);
      if (/quota/i.test(e.message)) break;
      continue;
    }
    polled++;
    const q = quotaFromHeaders(res.headers);
    if (q.remaining != null) remaining = q.remaining;
    // Prefer the counter; fall back to our own arithmetic so a response with no
    // headers still advances the ledger rather than reading as a free request.
    if (q.used != null) usedNow = q.used;
    else if (usedNow != null) usedNow += cost;
    if (spentToday != null) {
      spentToday = ledger.usedAtDayStart != null && usedNow != null
        ? Math.max(0, usedNow - ledger.usedAtDayStart)
        : spentToday + cost;
    }

    for (const ev of res.json ?? []) {
      const ko = new Date(ev.commence_time).getTime();
      if (!INPLAY && (ko < nowMs || ko > horizonMs)) continue;
      const matchId = resolveMatch(idx, ev);
      if (!matchId) { unmatchedEv++; continue; }
      matched++;
      for (const r of parseEvent(ev)) rows.push({ ...r, match_id: matchId });
    }
  }

  if (stoppedOnDaily) {
    console.log(`[oddsApi] DAY BUDGET REACHED: ${spentToday}/${dailyCeiling} credits spent ` +
                `today — ${leagues.length - polled} league(s) not polled this run. ` +
                'This is the pacer working, not a fault.');
  }
  console.log(`[oddsApi] polled=${polled} skipped_guard=${skippedGuard} ` +
              `events_matched=${matched} unmatched=${unmatchedEv} rows=${rows.length} ` +
              `spent_today=${spentToday ?? 'unknown'}/${dailyCeiling} ` +
              `remaining=${remaining ?? 'unknown'}`);

  await saveQuota(supabase, {
    remaining, used: usedNow,
    day: ledger.day, usedAtDayStart: ledger.usedAtDayStart, spent_today: spentToday,
    checked_at: new Date().toISOString(),
  });

  if (!rows.length) return;
  if (DRY) { console.log(JSON.stringify(rows.slice(0, 5), null, 2)); return; }
  const { error } = await supabase.from('odds').insert(rows);
  if (error) throw new Error(`oddsApi[insert]: ${error.message}`);
  console.log(`[oddsApi] inserted ${rows.length} odds row(s)`);
}

if (require.main === module) {
  main().catch(err => { console.error('[oddsApi] FATAL:', err.message); process.exit(1); });
}

module.exports = { resolveMatch, main };
