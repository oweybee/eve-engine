#!/usr/bin/env node
/**
 * scripts/apiFootballCatalogue.js — what does API-Football actually return?
 *
 * WHY THIS EXISTS. Every statement in this repo about which markets the odds
 * payload carries is inference from the extractors, not observation of a
 * payload. `ingestOdds.js:fetchFixtureOdds` requests `/odds?fixture=X` with no
 * `&bet` filter and its own comment says one call returns every market for all
 * bookmakers at zero extra quota — then the extractors keep bet ids 1, 5 and 8
 * and pin totals to 2.5, discarding the rest unread. Nobody has ever printed
 * what "the rest" is.
 *
 * The local `.env` holds a placeholder for API_FOOTBALL_KEY (the real key is a
 * repo secret), and api-football.com's documentation sits behind a bot
 * challenge, so the only place the real catalogue can be observed is a runner.
 * This prints it. It is the twin of scripts/oddsApiCatalogue.js, which exists
 * for the same reason against the other provider.
 *
 * Phase 0 of CLAUDE_CODE_PROMPT_core_markets says it directly: do not name bet
 * ids from memory or from documentation. This is how you stop doing that.
 *
 * COST. /odds/bets and /odds/live/bets are reference endpoints and return the
 * whole catalogue for one request each. The fixture probe is one more per
 * fixture sampled (default 2). Call it 5 requests against a 75,000/day
 * allowance. The account headers are printed so the spend is visible rather
 * than assumed.
 *
 * READ-ONLY. It writes nothing to Supabase and takes no Supabase credentials.
 *
 * Usage: node scripts/apiFootballCatalogue.js [--fixtures N]
 */
'use strict';

const https = require('https');

const KEY  = process.env.API_FOOTBALL_KEY;
const HOST = 'v3.football.api-sports.io';

const argIdx    = process.argv.indexOf('--fixtures');
const N_FIXTURES = argIdx > -1 ? Math.max(1, parseInt(process.argv[argIdx + 1], 10) || 2) : 2;

/** Bet ids the live extractors currently consume, so the gap is visible inline. */
const TAKEN_PREMATCH = new Set([1, 5, 8]);

function httpGet(path) {
  return new Promise((resolve, reject) => {
    https.request(
      { method: 'GET', hostname: HOST, path, headers: { 'x-apisports-key': KEY } },
      res => {
        let body = '';
        res.on('data', c => { body += c; });
        res.on('end', () => {
          if (res.statusCode !== 200) {
            reject(new Error(`HTTP ${res.statusCode} on ${path}: ${body.slice(0, 300)}`));
            return;
          }
          let json;
          try { json = JSON.parse(body); }
          catch (e) { reject(new Error(`JSON parse on ${path}: ${e.message}`)); return; }
          resolve({ json, headers: res.headers });
        });
      },
    ).on('error', reject).end();
  });
}

/**
 * API-Football answers a quota or plan failure with HTTP 200, an `errors`
 * object and an empty `response`. That is the shape that let the feed go dark
 * for nine days in October 2026 while every CI run reported success, because
 * planDay.js reads `json.response ?? []` and never looks at `errors`. Nothing
 * in this script may repeat that mistake.
 */
function assertNoApiErrors(path, json) {
  const errs = json?.errors;
  const empty = errs == null
    || (Array.isArray(errs) && errs.length === 0)
    || (typeof errs === 'object' && Object.keys(errs).length === 0);
  if (!empty) throw new Error(`API error on ${path}: ${JSON.stringify(errs)}`);
}

async function get(path) {
  const { json, headers } = await httpGet(path);
  assertNoApiErrors(path, json);
  return { res: json.response ?? [], results: json.results, headers };
}

function printCatalogue(title, rows, takenIds) {
  console.log(`\n=== ${title} === ${rows.length} bet type(s)`);
  console.log('id | name | currently extracted');
  for (const b of rows.slice().sort((a, c) => Number(a.id) - Number(c.id))) {
    const taken = takenIds && takenIds.has(Number(b.id)) ? 'YES' : '';
    console.log(`${b.id} | ${b.name} | ${taken}`);
  }
}

async function probeFixture(fixtureId, label) {
  const { res } = await get(`/odds?fixture=${fixtureId}`);
  console.log(`\n=== FIXTURE ${fixtureId} (${label}) === ${res.length} odds block(s)`);
  if (!res.length) {
    console.log('  no odds returned for this fixture');
    return;
  }

  // One block per fixture; bookmakers nested inside, each with its own bets.
  const perBet = new Map(); // id -> { name, books:Set, values:Set }
  for (const block of res) {
    for (const bk of block.bookmakers ?? []) {
      for (const bet of bk.bets ?? []) {
        const k = Number(bet.id);
        if (!perBet.has(k)) perBet.set(k, { name: bet.name, books: new Set(), values: new Set() });
        const e = perBet.get(k);
        e.books.add(bk.name);
        for (const v of bet.values ?? []) e.values.add(String(v.value));
      }
    }
  }

  console.log(`bookmakers on this fixture: ${
    [...new Set((res[0].bookmakers ?? []).map(b => b.name))].join(', ') || '(none)'}`);
  console.log('\nid | name | books quoting | distinct values | sample values | extracted');
  for (const [id, e] of [...perBet.entries()].sort((a, c) => a[0] - c[0])) {
    const sample = [...e.values].slice(0, 8).join(' / ');
    console.log(`${id} | ${e.name} | ${e.books.size} | ${e.values.size} | ${sample} | ${
      TAKEN_PREMATCH.has(id) ? 'YES' : 'no'}`);
  }

  // The specific question that sent anyone here: which goal lines arrive, given
  // ingestOdds pins TOTALS_TARGET_LINE to 2.5 and drops every other line in the
  // same payload.
  const goals = perBet.get(5);
  if (goals) {
    const lines = [...goals.values]
      .map(v => (String(v).match(/(-?\d+(?:\.\d+)?)/) || [])[1])
      .filter(Boolean);
    console.log(`\ngoal lines present in bet 5: ${[...new Set(lines)].sort((a, b) => a - b).join(', ')}`);
    console.log('ingestOdds.js keeps 2.5 and discards the rest.');
  }
}

async function main() {
  if (!KEY) { console.log('[catalogue] API_FOOTBALL_KEY not set — nothing to ask'); process.exit(1); }

  // Account first, so a quota problem is visible before anything is inferred
  // from a thin response.
  const status = await get('/status');
  const s = status.res ?? {};
  console.log('=== ACCOUNT ===');
  console.log(`plan            ${s?.subscription?.plan ?? '(absent)'}`);
  console.log(`active          ${s?.subscription?.active ?? '(absent)'}`);
  console.log(`ends            ${s?.subscription?.end ?? '(absent)'}`);
  console.log(`requests today  ${s?.requests?.current ?? '?'} of ${s?.requests?.limit_day ?? '?'}`);

  printCatalogue('PREMATCH BET CATALOGUE (/odds/bets)',
    (await get('/odds/bets')).res, TAKEN_PREMATCH);

  // The live catalogue is a different list, and the live feed names the same
  // market differently — the in-play tests carry 'Fulltime Result' (id 59)
  // where the prematch feed says 'Match Winner' (id 1). Print both or the
  // mapping stays folklore.
  try {
    printCatalogue('LIVE BET CATALOGUE (/odds/live/bets)', (await get('/odds/live/bets')).res, null);
  } catch (e) {
    console.log(`\n=== LIVE BET CATALOGUE === unavailable: ${e.message}`);
  }

  // Sample real fixtures rather than a hand-picked id, so the market depth
  // printed is the depth the board would actually get.
  const { res: fixtures } = await get('/fixtures?league=39&next=' + N_FIXTURES);
  if (!fixtures.length) console.log('\nno upcoming fixtures returned for league 39 — cannot probe depth');
  for (const f of fixtures) {
    const label = `${f?.teams?.home?.name} v ${f?.teams?.away?.name}, ${f?.fixture?.date}`;
    try { await probeFixture(f.fixture.id, label); }
    catch (e) { console.log(`\nfixture ${f.fixture.id} probe failed: ${e.message}`); }
  }

  const after = await get('/status');
  console.log(`\n=== SPEND === ${after.res?.requests?.current ?? '?'} of ${
    after.res?.requests?.limit_day ?? '?'} requests used today after this run`);
}

main().catch((e) => { console.error(`[catalogue] ${e.message}`); process.exit(1); });
