#!/usr/bin/env node
/**
 * scripts/auditUnmatchedEvents.js — why does an Odds API event not become a price?
 *
 * `ingestOddsApi.resolveMatch` answers one bit — matched or not — and that bit
 * has four completely different causes behind it. On a post-matchday sweep the
 * run log says "N unmatched" and nothing else, which reads as one problem and
 * is at least four:
 *
 *   NAME_MISMATCH    we and the feed spell the club differently. FIXABLE, by
 *                    an alias in lib/lambdaBoard's ALIAS table.
 *   TIME_GAP         the names matched and the kickoffs are further apart than
 *                    MATCH_WINDOW_MIN. Fixable by widening the window — or a
 *                    sign the fixture was rescheduled and we did not re-ingest.
 *   BEYOND_HORIZON   the event kicks off past HORIZON_HOURS. NOT A DEFECT: we
 *                    deliberately do not price next month, and counting it as
 *                    a miss makes the matcher look broken when it is thrifty.
 *   OUT_OF_SEASON    the feed offers a competition we track but which has no
 *                    upcoming fixture at all — UCL/UECL between rounds, a
 *                    summer league in winter. NOT A KEY ERROR, and the run log
 *                    calling it "EXPECTED a sport key and did not find one"
 *                    sends the next reader to lib/oddsApi.js for nothing.
 *
 * THE POINT IS THE SPLIT. Only the first two are work. Reporting all four as
 * one number is the same failure `/api/inplay`'s `source` block was written to
 * end: a silence that does not say which silence it is.
 *
 * IT IS DESIGNED TO COST NOTHING. `/v4/sports` (the catalogue) and
 * `/v4/sports/{key}/events` (fixtures without odds) are both free endpoints —
 * they return the quota headers without moving the counter. The summary prints
 * the observed spend against the daily ceiling so that claim is CHECKED on
 * every run rather than asserted here. If a future API change starts charging
 * for events, this run is what will say so.
 *
 *   node scripts/auditUnmatchedEvents.js            audit the next HORIZON_HOURS
 *   node scripts/auditUnmatchedEvents.js --json     machine-readable summary
 *   node scripts/auditUnmatchedEvents.js --limit=5  first N leagues only
 *
 * Required env: ODDS_API_KEY, SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY
 */
'use strict';

const { getClient } = require('../lib/supabaseClient');
const { clubKey } = require('../lib/lambdaBoard');
const { httpGetJson, mapSportKeys, quotaFromHeaders } = require('../lib/oddsApi');

const KEY   = process.env.ODDS_API_KEY;
const JSON_OUT = process.argv.includes('--json');
const LIMIT = (() => {
  const a = process.argv.find(x => x.startsWith('--limit='));
  return a ? parseInt(a.split('=')[1], 10) : Infinity;
})();

/** Mirrors ingestOddsApi.js. Kept in sync deliberately — see the test. */
const HORIZON_HOURS    = parseFloat(process.env.ODDS_API_HORIZON_HOURS || '72');
const MATCH_WINDOW_MIN = 90;
/** Daily credit ceiling this audit is costed against. */
const DAILY_CEILING    = parseInt(process.env.ODDS_API_DAILY_CEILING || '2880', 10);

// ---------------------------------------------------------------------------
// String distance — for NAMING a likely alias, never for making a match
//
// The matcher is EXACT on clubKey and this does not change that. A fuzzy
// matcher that silently accepted 0.8 similarity would print a live price under
// the wrong game, which is the failure lib/liveMarket's header is about. This
// only suggests what a human should add to the ALIAS table.
// ---------------------------------------------------------------------------

function levenshtein(a, b) {
  if (a === b) return 0;
  if (!a.length) return b.length;
  if (!b.length) return a.length;
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    for (let j = 1; j <= b.length; j++) {
      cur[j] = Math.min(
        prev[j] + 1,
        cur[j - 1] + 1,
        prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1),
      );
    }
    prev = cur;
  }
  return prev[b.length];
}

/** 0..1, 1 being identical. */
function similarity(a, b) {
  const x = String(a ?? ''), y = String(b ?? '');
  const longest = Math.max(x.length, y.length);
  return longest === 0 ? 1 : 1 - levenshtein(x, y) / longest;
}

/** The closest club key we hold, so the reader knows what alias to write. */
function nearestKey(needle, keys, floor = 0.6) {
  let best = null;
  for (const k of keys) {
    const s = similarity(needle, k);
    if (!best || s > best.similarity) best = { key: k, similarity: s };
  }
  return best && best.similarity >= floor ? best : null;
}

// ---------------------------------------------------------------------------
// Classification — PURE, so it is testable without the API or the database
// ---------------------------------------------------------------------------

/**
 * @param {{home_team:string, away_team:string, commence_time:string}} event
 * @param {Map<string, Array<{id:string, ko:number}>>} idx  clubKey pair -> fixtures
 * @param {{now:number, leagueHasUpcoming:boolean, homeKeys?:Set<string>}} ctx
 * @returns {{outcome:string, detail:string, gapMin?:number, suggestion?:string}}
 */
function classifyEvent(event, idx, ctx) {
  const now = ctx.now ?? Date.now();
  const ko  = new Date(event?.commence_time).getTime();
  const h   = clubKey(event?.home_team);
  const a   = clubKey(event?.away_team);
  const pair = `${h}|${a}`;
  const cands = idx.get(pair);

  if (cands?.length) {
    let best = null;
    for (const c of cands) {
      const gap = Math.abs(c.ko - ko);
      if (!best || gap < best.gap) best = { ...c, gap };
    }
    const gapMin = Math.round(best.gap / 60_000);
    if (best.gap <= MATCH_WINDOW_MIN * 60_000) {
      return { outcome: 'MATCHED', detail: `${event.home_team} v ${event.away_team}`, gapMin };
    }
    // The names are ours; only the clock disagrees. Almost always a rescheduled
    // fixture we have not re-ingested — which is why it is not a name problem.
    return {
      outcome: 'TIME_GAP', gapMin,
      detail: `${event.home_team} v ${event.away_team} — ${gapMin}m apart, window is ${MATCH_WINDOW_MIN}m`,
    };
  }

  // ORDER MATTERS BELOW. A competition between rounds and an event past our
  // horizon both LOOK like a name miss, because neither has a fixture to index
  // against. Ruling them out first is the whole reason this script exists.
  if (!ctx.leagueHasUpcoming) {
    return {
      outcome: 'OUT_OF_SEASON',
      detail: `${event.home_team} v ${event.away_team} — we hold no upcoming fixture in this competition`,
    };
  }
  if (Number.isFinite(ko) && ko > now + HORIZON_HOURS * 3_600_000) {
    const hrs = Math.round((ko - now) / 3_600_000);
    return {
      outcome: 'BEYOND_HORIZON',
      detail: `${event.home_team} v ${event.away_team} — kicks off in ${hrs}h, horizon is ${HORIZON_HOURS}h`,
    };
  }

  const near = ctx.homeKeys ? nearestKey(h, ctx.homeKeys) : null;
  return {
    outcome: 'NAME_MISMATCH',
    detail: `${event.home_team} v ${event.away_team} — no fixture keyed "${pair}"`,
    suggestion: near ? `closest key we hold: "${near.key}" (${(near.similarity * 100).toFixed(0)}%)` : undefined,
  };
}

const OUTCOMES = ['MATCHED', 'NAME_MISMATCH', 'TIME_GAP', 'BEYOND_HORIZON', 'OUT_OF_SEASON'];

/** Roll a list of classified events into the summary table. */
function summarise(rows) {
  const counts = Object.fromEntries(OUTCOMES.map(o => [o, 0]));
  for (const r of rows) counts[r.outcome] = (counts[r.outcome] ?? 0) + 1;
  const total = rows.length;
  const actionable = counts.NAME_MISMATCH + counts.TIME_GAP;
  return { total, counts, actionable, matchRate: total ? counts.MATCHED / total : null };
}

// ---------------------------------------------------------------------------
// I/O
// ---------------------------------------------------------------------------

/**
 * Index the fixtures an event COULD match, exactly as the ingest does.
 *
 * ── WHY THIS IS TWO READS AND WHY BOTH ARE PAGED (22 Aug 2026) ──────────────
 * The first cut was ONE read with `.limit(1000)` and no order and no paging.
 * PostgREST caps a response at 1000 rows whatever `.limit()` says, production
 * holds 8,885 upcoming fixtures, and only 133 of them are inside the 72h
 * horizon — so the audit indexed an arbitrary 11% slice and the 1.5% that can
 * actually match was mostly not in it. It reported `OUT_OF_SEASON 252` with
 * `epl` at 14 on a night the Premier League played, and FOUR leagues
 * contradicted themselves in one run (mexico_ligamx 9 MATCHED and 5
 * OUT_OF_SEASON), which is what truncation looks like from outside. The run
 * log said `1000 scheduled fixture(s) indexed` — exactly the cap — and nothing
 * treated that as a number worth reading.
 *
 * They are two questions and they need two windows:
 *
 *   MATCHING     only fixtures inside the horizon can match an event we polled,
 *                so the index is bounded to it (plus the match window as slack,
 *                so a fixture just outside still classifies as TIME_GAP rather
 *                than vanishing into a name miss).
 *   IN SEASON    "do we hold ANY upcoming fixture in this competition" is the
 *                question OUT_OF_SEASON asks, and bounding THAT to 72h would
 *                file every league whose next fixture is on Tuesday as out of
 *                season — the same error in the other direction.
 *
 * Both page and both dedupe by id rather than trusting page length: `.range()`
 * travels as a Range HEADER, so any layer that answers the URL and ignores
 * headers returns the same page for ever, and counting rows alone loops to the
 * cap. Same rule eve-frontend's `fetchSeasonPrices` records.
 */
const PAGE = 1000;
const MAX_PAGES = 40;

async function pageAll(query, label) {
  const seen = new Set();
  const out = [];
  for (let p = 0; p < MAX_PAGES; p++) {
    const { data, error } = await query().range(p * PAGE, p * PAGE + PAGE - 1);
    if (error) throw new Error(`audit[${label}]: ${error.message}`);
    const rows = data ?? [];
    let fresh = 0;
    for (const r of rows) {
      if (seen.has(r.id)) continue;
      seen.add(r.id); out.push(r); fresh++;
    }
    if (rows.length < PAGE || fresh === 0) return { rows: out, truncated: false };
  }
  return { rows: out, truncated: true };
}

async function loadFixtureIndex(supabase) {
  const now = Date.now();
  const from = new Date(now).toISOString();
  // The window is slack on BOTH sides: an event inside the horizon may sit
  // against a fixture whose stored kickoff drifted, and that is a TIME_GAP.
  const to = new Date(now + HORIZON_HOURS * 3_600_000 + MATCH_WINDOW_MIN * 60_000).toISOString();

  const sel = `id, kickoff_at, league_id,
               home_team:teams!matches_home_team_id_fkey ( name ),
               away_team:teams!matches_away_team_id_fkey ( name )`;

  const inWindow = await pageAll(
    () => supabase.from('matches').select(sel)
      .eq('status', 'scheduled').gte('kickoff_at', from).lte('kickoff_at', to)
      .order('kickoff_at', { ascending: true }),
    'matches',
  );

  // Ids only — this is 8,885 rows of one column and it answers one boolean
  // per competition. Reading the joined shape here would be nine pages of
  // team names nobody looks at.
  const anyUpcoming = await pageAll(
    () => supabase.from('matches').select('id, league_id')
      .eq('status', 'scheduled').gte('kickoff_at', from)
      .order('id', { ascending: true }),
    'matches[season]',
  );

  const idx = new Map();
  const homeKeys = new Set();
  for (const m of inWindow.rows) {
    const h = clubKey(m.home_team?.name);
    const a = clubKey(m.away_team?.name);
    if (!h || !a) continue;
    homeKeys.add(h); homeKeys.add(a);
    const list = idx.get(`${h}|${a}`) ?? [];
    list.push({ id: m.id, ko: new Date(m.kickoff_at).getTime() });
    idx.set(`${h}|${a}`, list);
  }

  const leaguesWithUpcoming = new Set();
  for (const m of anyUpcoming.rows) if (m.league_id) leaguesWithUpcoming.add(m.league_id);

  return {
    idx, homeKeys, leaguesWithUpcoming,
    fixtures: inWindow.rows.length,
    upcoming: anyUpcoming.rows.length,
    // Never silent. A truncated index turns a real fixture into OUT_OF_SEASON,
    // which is the failure this whole rewrite is about.
    truncated: inWindow.truncated || anyUpcoming.truncated,
  };
}

/** Which of our league rows a resolved sport key belongs to, by (name, country). */
async function loadLeagueRows(supabase) {
  const { data } = await supabase.from('leagues').select('id, name, country');
  const byName = new Map();
  for (const l of data ?? []) byName.set(`${l.name}|${l.country}`, l.id);
  return byName;
}

async function main() {
  if (!KEY) { console.log('[audit] ODDS_API_KEY not set — nothing to ask'); process.exit(1); }
  const supabase = getClient();

  // Free catalogue call — also where the quota counter is read from.
  const cat = await httpGetJson(`/v4/sports/?apiKey=${KEY}&all=true`);
  const before = quotaFromHeaders(cat.headers);
  const { map } = mapSportKeys(cat.json, { includeCups: true });

  const { idx, homeKeys, leaguesWithUpcoming, fixtures, upcoming, truncated } =
    await loadFixtureIndex(supabase);
  const leagueIdByKey = await loadLeagueRows(supabase);

  // THE INGEST ASKS A DIFFERENT QUESTION OF THE CATALOGUE. It calls /v4/sports
  // WITHOUT `all=true`, which returns in-season competitions only; this script
  // and scripts/oddsApiCatalogue.js pass it, which returns every competition
  // the vendor lists. That is why one says 36 leagues resolve and the ingest
  // says 34. Reported rather than reconciled: a competition the ingest cannot
  // even see is not an unmatched event, and calling it one sends the next
  // reader to lib/oddsApi.js for nothing.
  const live = await httpGetJson(`/v4/sports/?apiKey=${KEY}`);
  const liveMap = mapSportKeys(live.json, { includeCups: true }).map;
  const notInSeason = Object.keys(map).filter(k => !liveMap[k]);

  const entries = Object.entries(map).slice(0, LIMIT);
  console.log(`[audit] ${entries.length} resolved league(s) · ${fixtures} fixture(s) inside the ` +
              `${HORIZON_HOURS}h horizon (of ${upcoming} upcoming) · window ${MATCH_WINDOW_MIN}m`);
  if (notInSeason.length) {
    console.log(`[audit] ${Object.keys(liveMap).length} of those are IN SEASON per the ingest's own ` +
                `catalogue call; not offered right now: ${notInSeason.join(', ')}`);
  }
  if (truncated) {
    console.log('[audit] ::error::the fixture read hit MAX_PAGES — the index is INCOMPLETE and ' +
                'every count below understates MATCHED. Do not quote this run.');
  }

  const now = Date.now();
  const rows = [];
  for (const [leagueKey, sportKey] of entries) {
    let events = [];
    try {
      // FREE endpoint: events carry no odds, so the counter must not move.
      const res = await httpGetJson(`/v4/sports/${sportKey}/events?apiKey=${KEY}`);
      events = Array.isArray(res.json) ? res.json : [];
    } catch (err) {
      console.warn(`  [warn] ${leagueKey} (${sportKey}): ${err.message}`);
      continue;
    }
    const leagueId = leagueIdByKey.get(leagueKey);
    const leagueHasUpcoming = leagueId ? leaguesWithUpcoming.has(leagueId) : false;
    for (const ev of events) {
      rows.push({ leagueKey, sportKey, ...classifyEvent(ev, idx, { now, leagueHasUpcoming, homeKeys }) });
    }
  }

  const after = quotaFromHeaders((await httpGetJson(`/v4/sports/?apiKey=${KEY}&all=true`)).headers);
  const spent = (after.used != null && before.used != null) ? after.used - before.used : null;
  const s = summarise(rows);

  if (JSON_OUT) {
    console.log(JSON.stringify({ ...s, spent, dailyCeiling: DAILY_CEILING, rows }, null, 2));
    return;
  }

  console.log('\n  OUTCOME           COUNT     SHARE');
  console.log('  ' + '-'.repeat(38));
  for (const o of OUTCOMES) {
    const n = s.counts[o];
    const pct = s.total ? ((n / s.total) * 100).toFixed(1) + '%' : '—';
    console.log(`  ${o.padEnd(16)} ${String(n).padStart(6)} ${pct.padStart(9)}`);
  }
  console.log('  ' + '-'.repeat(38));
  console.log(`  ${'TOTAL'.padEnd(16)} ${String(s.total).padStart(6)}`);

  console.log(`\n[audit] ACTIONABLE: ${s.actionable} ` +
              `(${s.counts.NAME_MISMATCH} name, ${s.counts.TIME_GAP} clock). ` +
              `${s.counts.BEYOND_HORIZON + s.counts.OUT_OF_SEASON} are deliberate, not defects.`);

  for (const o of ['NAME_MISMATCH', 'TIME_GAP']) {
    const sample = rows.filter(r => r.outcome === o).slice(0, 12);
    if (!sample.length) continue;
    console.log(`\n  ${o}:`);
    for (const r of sample) {
      console.log(`    ${r.leagueKey} — ${r.detail}${r.suggestion ? `\n        ${r.suggestion}` : ''}`);
    }
    const more = s.counts[o] - sample.length;
    if (more > 0) console.log(`    …and ${more} more`);
  }

  // The free-endpoint claim, CHECKED rather than asserted.
  console.log(`\n[audit] credits spent by this audit: ${spent ?? 'unknown'} of a ${DAILY_CEILING}/day ceiling` +
              (spent === 0 ? ' — free, as intended.' : spent > 0 ? ' — NOT FREE ANY MORE; the events endpoint now charges.' : ''));
  if (after.remaining != null) console.log(`[audit] remaining on the account: ${after.remaining}`);
}

if (require.main === module) {
  main().catch(err => { console.error('[audit] fatal:', err.message); process.exit(1); });
}

module.exports = {
  classifyEvent, summarise, similarity, nearestKey, levenshtein, pageAll,
  OUTCOMES, HORIZON_HOURS, MATCH_WINDOW_MIN, DAILY_CEILING, PAGE, MAX_PAGES,
};
