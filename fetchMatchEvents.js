/**
 * fetchMatchEvents.js — goals and cards for finished matches, for /results.
 *
 * Asks `/fixtures?ids=` (20 a call, events included) for every COMPLETED match
 * in the window that has not been asked yet, writes `match_events`, and records
 * the ask in `match_event_fetches` so a goalless, cardless game is not asked
 * again for ever. A fixture the vendor does not yet report as finished is NOT
 * marked done, so it is asked again next run.
 *
 *   node fetchMatchEvents.js              last 2 days
 *   node fetchMatchEvents.js --days=14    a backfill
 *
 * Required env: API_FOOTBALL_KEY, SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY
 */

'use strict';

const https = require('https');
const { getClient } = require('./lib/supabaseClient');
const apiQuota = require('./lib/apiFootballQuota');
const { shapeFixture, chunk } = require('./lib/matchEvents');

const KEY  = process.env.API_FOOTBALL_KEY;
const HOST = 'v3.football.api-sports.io';
const DAYS = (() => {
  const arg = process.argv.find(a => a.startsWith('--days='));
  const n = arg ? parseInt(arg.slice(7), 10) : 2;
  return Number.isInteger(n) && n > 0 && n <= 30 ? n : 2;
})();
/** Stop asking well inside the workflow's 10-minute timeout. */
const BUDGET_MS = 6 * 60_000;

function get(path) {
  return new Promise((resolve, reject) => {
    https.request({ method: 'GET', hostname: HOST, path, headers: { 'x-apisports-key': KEY } }, res => {
      let body = '';
      res.on('data', c => { body += c; });
      res.on('end', () => {
        apiQuota.report(res.headers);
        if (res.statusCode !== 200) return reject(new Error(`HTTP ${res.statusCode}: ${body.slice(0, 200)}`));
        try { resolve(JSON.parse(body)); } catch (e) { reject(new Error(`JSON parse: ${e.message}`)); }
      });
    }).on('error', reject).end();
  });
}

async function pending(supabase) {
  const since = new Date(Date.now() - DAYS * 86_400_000).toISOString();
  const out = [];
  for (let from = 0; ; from += 1000) {
    const { data, error } = await supabase
      .from('matches').select('id, external_id')
      .eq('status', 'completed').not('external_id', 'is', null)
      .gte('kickoff_at', since).order('kickoff_at', { ascending: false })
      .range(from, from + 999);
    if (error) throw new Error(`matches: ${error.message}`);
    out.push(...(data ?? []));
    if (!data || data.length < 1000) break;
  }
  const done = new Set();
  for (const ids of chunk(out.map(m => String(m.external_id)), 200)) {
    const { data, error } = await supabase.from('match_event_fetches').select('fixture_id').in('fixture_id', ids);
    if (error) throw new Error(`match_event_fetches: ${error.message}`);
    for (const r of data ?? []) done.add(String(r.fixture_id));
  }
  return out.filter(m => !done.has(String(m.external_id)));
}

async function main() {
  if (!KEY) { console.log('[events] API_FOOTBALL_KEY not set — skipping'); return; }
  const supabase = getClient();
  const started = Date.now();
  const todo = await pending(supabase);
  console.log(`[events] ${todo.length} finished match(es) in the last ${DAYS} day(s) not yet asked`);

  const matchByExt = new Map(todo.map(m => [String(m.external_id), m.id]));
  let calls = 0, written = 0, marked = 0, notFinal = 0, failed = 0;

  for (const ids of chunk([...matchByExt.keys()])) {
    if (Date.now() - started > BUDGET_MS) { console.log('[events] budget reached — the next run continues'); break; }
    let json;
    try { json = await get(`/fixtures?ids=${ids.join('-')}`); calls++; }
    catch (err) { failed++; console.warn(`[events] call failed: ${err.message}`); continue; }

    for (const fx of json?.response ?? []) {
      const shaped = shapeFixture(fx, matchByExt.get(String(fx?.fixture?.id)) ?? null);
      if (!shaped) continue;
      if (!shaped.final) { notFinal++; continue; }

      if (shaped.rows.length) {
        const { error } = await supabase.from('match_events')
          .upsert(shaped.rows, { onConflict: 'fixture_id,seq' });
        if (error) { failed++; console.warn(`[events] write ${shaped.fixtureId}: ${error.message}`); continue; }
        written += shaped.rows.length;
      }
      const { error: mErr } = await supabase.from('match_event_fetches').upsert({
        fixture_id: shaped.fixtureId, match_id: shaped.rows[0]?.match_id ?? matchByExt.get(shaped.fixtureId) ?? null,
        status_short: shaped.statusShort, n_events: shaped.rows.length, fetched_at: new Date().toISOString(),
      }, { onConflict: 'fixture_id' });
      if (mErr) { failed++; console.warn(`[events] mark ${shaped.fixtureId}: ${mErr.message}`); continue; }
      marked++;
    }
  }

  console.log(`[events] ${calls} call(s) · ${marked} match(es) done · ${written} event row(s) · ` +
    `${notFinal} not final yet · ${failed} failure(s)`);
  await apiQuota.persistQuota(supabase);
  if (failed && !marked) process.exitCode = 1;
}

if (require.main === module) {
  main().catch(err => { console.error('[events] fatal:', err.message); process.exit(1); });
}
