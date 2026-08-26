/**
 * fetchLineups.js — the confirmed XI, on its own clock.
 *
 * IT IS A SEPARATE JOB BECAUSE IT IS THE ONLY THING HERE THAT EXPIRES. The
 * engine pipeline runs ~9 minutes and cannot go more often than ~15; a lineup
 * published 20 minutes before kickoff and captured on the next engine tick is
 * a coin flip. This job does one query and a handful of calls, so it fits
 * inside a 5-minute cron with room to spare.
 *
 * The precedent is `captureIndependentLines.js`, which was starved as step 6 of
 * a shared 15-minute job and became correct the moment it got its own runner.
 *
 * ── THE CADENCE COMES FROM THE LOOP, NOT FROM THE CRON ──────────────────────
 *
 * GITHUB DOES NOT HONOUR A HIGH-FREQUENCY SCHEDULE, and this repo has the
 * measurement. `engine.yml` declares an every-15-minutes cron; over its last 25 runs
 * GitHub delivered a MEDIAN GAP OF 34 MINUTES, minimum 17, never once 15.
 * An every-5-minutes cron is therefore a request, not a promise — and a
 * lineup published 20 minutes before kickoff, sampled every ~30 minutes, is
 * a coin flip again — the exact failure this job exists to end.
 *
 * So the job POLLS ITSELF. One GitHub tick keeps a process alive for
 * LOOP_MINUTES, running a pass every PASS_INTERVAL_SECONDS. The cron's only
 * remaining duty is to make sure a process is running at all; how often we
 * actually look is ours to decide. Actions minutes are free on a public repo,
 * which is what makes this affordable rather than clever.
 *
 * Budget: a fixture is asked once per PASS until the feed publishes — ~18
 * times across a 90-minute window at worst, and a captured fixture is never
 * asked again. Low thousands of calls a day against a 75,000 allowance.
 *
 *   node fetchLineups.js            poll for LOOP_MINUTES, a pass every 5 min
 *   node fetchLineups.js --once     a single pass, then exit
 *   node fetchLineups.js --report   print the lead-time distribution and exit
 *
 * `--report` is the answer to "do we have lineups an hour before kickoff?".
 * It reads what actually happened rather than what we intended.
 *
 * Required env: API_FOOTBALL_KEY, SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY
 */

'use strict';

const https             = require('https');
const { getClient }     = require('./lib/supabaseClient');
const { beginWatchdog } = require('./lib/watchdog');
const { captureLineups, summarise, DEFAULTS } = require('./lib/lineupCapture');
const apiQuota = require('./lib/apiFootballQuota');

const API_FOOTBALL_KEY  = process.env.API_FOOTBALL_KEY;
const API_FOOTBALL_HOST = 'v3.football.api-sports.io';
const REPORT            = process.argv.includes('--report');
const ONCE              = process.argv.includes('--once');

/**
 * How long one GitHub tick keeps this process alive. Under the step timeout.
 *
 * IT MUST EXCEED THE GAP BETWEEN TICKS, which is the whole trick. Measured on
 * this repo the delivered gap has a median of 34 minutes, so a 25-minute loop
 * left a systematic hole between runs — the schedule was still deciding
 * coverage, just less often. At 50 minutes a fresh tick almost always lands
 * while a loop is still running; GitHub holds it as the single pending run
 * and starts it the instant this one ends, so coverage closes up instead of
 * gapping. Raise this, not the cron, if holes reappear.
 */
const LOOP_MINUTES = parseFloat(process.env.LINEUP_LOOP_MINUTES || '50');

/** How often to look, inside that. THIS is the real cadence. */
const PASS_INTERVAL_SECONDS = parseFloat(process.env.LINEUP_PASS_INTERVAL_SECONDS || '300');

/**
 * Wall-clock budget. MUST stay under the workflow step's `timeout-minutes`:
 * being killed is not the same as stopping, and a killed run prints no summary
 * — which is exactly how a pipeline that had never captured a Premier League
 * XI on time went a season looking healthy.
 */
const BUDGET_SECONDS = parseFloat(process.env.LINEUP_BUDGET_SECONDS || '150');

let deadlineAt = null;

function httpGetOnce(path) {
  return new Promise((resolve, reject) => {
    https.request(
      { method: 'GET', hostname: API_FOOTBALL_HOST, path,
        headers: { 'x-apisports-key': API_FOOTBALL_KEY } },
      res => {
        let body = '';
        res.on('data', c => { body += c; });
        res.on('end', () => {
          // The vendor reports the day's counter on EVERY response and calling its
// /status endpoint spends one against the counter it reports, so the reading
// is taken from a call we were making anyway. Never throws; see lib/apiFootballQuota.
          apiQuota.report(res.headers);

          if (res.statusCode === 429) { reject(Object.assign(new Error('Rate limit hit'), { is429: true })); return; }
          if (res.statusCode !== 200) { reject(new Error(`HTTP ${res.statusCode}: ${body.slice(0, 200)}`)); return; }
          try { resolve(JSON.parse(body)); } catch (e) { reject(new Error(`JSON parse: ${e.message}`)); }
        });
      },
    ).on('error', reject).end();
  });
}

const sleep = ms => new Promise(r => setTimeout(r, ms));

/**
 * A 429 backoff longer than the budget it runs inside is a kill with extra
 * steps — and on THIS job it is worse than that: sleeping 60s inside a
 * 5-minute cadence spends the whole tick waiting, on the one job whose value
 * is that it comes round again soon. So the retry is short and gives up early;
 * the next tick is four minutes away.
 */
async function httpGet(path, retries = 2, baseDelayMs = 5_000) {
  for (let attempt = 1; attempt <= retries; attempt++) {
    try { return await httpGetOnce(path); }
    catch (err) {
      const remaining = deadlineAt == null ? Infinity : deadlineAt - Date.now();
      const wanted = baseDelayMs * attempt;
      if (err.is429 && attempt < retries && wanted < remaining - 1_000) {
        console.warn(`[lineups] 429 — waiting ${wanted / 1000}s (next tick is minutes away anyway)`);
        await sleep(wanted);
        continue;
      }
      throw err;
    }
  }
}

async function fetchLineupsFor(fixtureId) {
  const json = await httpGet(`/fixtures/lineups?fixture=${fixtureId}`);
  return json.response ?? [];
}

/**
 * What the feed ACTUALLY gives us, measured rather than intended.
 *
 * Reports lead time for fixtures whose kickoff has passed, so a fixture still
 * awaiting its XI is not counted as a miss.
 */
async function report(supabase) {
  const since = new Date(Date.now() - 14 * 24 * 3_600_000).toISOString();
  const { data: matches, error } = await supabase
    .from('matches')
    .select('external_id, kickoff_at, league_id')
    .not('external_id', 'is', null)
    .gte('kickoff_at', since)
    .lte('kickoff_at', new Date().toISOString())
    .limit(1000);
  if (error) throw new Error(`report: ${error.message}`);

  const byId = new Map((matches ?? []).map(m => [String(m.external_id), m]));
  if (!byId.size) { console.log('[lineups] no kicked-off fixtures in the last 14 days'); return; }

  const ids = [...byId.keys()];
  const leads = [];
  let withLineup = 0;
  for (let i = 0; i < ids.length; i += 60) {
    const { data: rows } = await supabase
      .from('lineups').select('fixture_id, fetched_at')
      .in('fixture_id', ids.slice(i, i + 60));
    const firstSeen = new Map();
    for (const r of rows ?? []) {
      const t = new Date(r.fetched_at).getTime();
      const k = String(r.fixture_id);
      if (!firstSeen.has(k) || t < firstSeen.get(k)) firstSeen.set(k, t);
    }
    for (const [k, t] of firstSeen) {
      withLineup++;
      const ko = new Date(byId.get(k).kickoff_at).getTime();
      leads.push(Math.round((ko - t) / 60_000));   // >0 = captured before kickoff
    }
  }

  const n = byId.size;
  const pct = x => `${((x / n) * 100).toFixed(1)}%`;
  const atLeast = m => leads.filter(l => l >= m).length;
  leads.sort((a, b) => b - a);
  console.log(`[lineups] over ${n} fixture(s) kicked off in the last 14 days:`);
  console.log(`  with a lineup at all      ${withLineup} (${pct(withLineup)})`);
  console.log(`  captured before kickoff   ${atLeast(0)} (${pct(atLeast(0))})`);
  console.log(`  >= 30 min before kickoff  ${atLeast(30)} (${pct(atLeast(30))})`);
  console.log(`  >= 60 min before kickoff  ${atLeast(60)} (${pct(atLeast(60))})   <- "an hour before"`);
  if (leads.length) {
    const med = leads[Math.floor(leads.length / 2)];
    console.log(`  lead: max ${leads[0]}m · median ${med}m · min ${leads[leads.length - 1]}m`);
  }
}

async function main() {
  const supabase = getClient();

  if (REPORT) { await report(supabase); return; }

  if (!API_FOOTBALL_KEY) { console.log('[lineups] API_FOOTBALL_KEY not set — skipping'); return; }

  const started  = Date.now();
  const loopUntil = ONCE ? 0 : started + LOOP_MINUTES * 60_000;

  let census = null;
  let pass = 0;
  let totalFixtures = 0;
  const dog = beginWatchdog('fetchLineups.js', {
    onTerminate: () => console.error(
      census ? summarise(census) : '[lineups] killed before any capture'),
  });

  for (;;) {
    pass++;
    dog.stage(`pass ${pass}`);
    // Each pass gets its own budget, never one shared across the loop: a slow
    // pass must not eat the passes after it.
    deadlineAt = Math.min(Date.now() + BUDGET_SECONDS * 1000, loopUntil || Infinity);

    census = await captureLineups(supabase, fetchLineupsFor, {
      deadlineAt,
      onCapture: (m, lead) => console.log(`  captured ${m.external_id} — ${lead}m before kickoff`),
    });
    totalFixtures += census.fixtures;

    // A pass that found nothing to do is the ordinary case and must not fill
    // the log — say something only when there was work or news.
    if (census.fixtures || census.errors || census.notPublished) console.log(summarise(census));

    if (ONCE) break;
    const nextAt = started + pass * PASS_INTERVAL_SECONDS * 1000;
    if (nextAt >= loopUntil) break;
    await sleep(Math.max(0, nextAt - Date.now()));
  }

  console.log(
    `[lineups] ${pass} pass(es) over ${((Date.now() - started) / 1000 / 60).toFixed(1)}m, ` +
    `${totalFixtures} fixture(s) captured · window ${DEFAULTS.windowMinutes}m ` +
    `· pass interval ${PASS_INTERVAL_SECONDS}s`);
  dog.finish();
}

if (require.main === module) {
  main()
    .then(() => apiQuota.persistQuota(getClient()))
    .catch(err => { console.error('[lineups] fatal:', err.message); process.exit(1); });
}

module.exports = { fetchLineupsFor, BUDGET_SECONDS, LOOP_MINUTES, PASS_INTERVAL_SECONDS };
