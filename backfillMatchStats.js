/**
 * backfillMatchStats.js — historical per-fixture statistics, every league.
 *
 * WHY THIS IS THE HIGHEST-VALUE DATA TASK IN THE 2026-08-05 PLAN
 * The corners and cards models are the strongest discriminators the audit
 * produced (actual over-3.5-cards runs 25.3% → 59.7% across model deciles, a
 * 34.4pp range against 14.5pp for goals; corners 39.4% → 60.1%). Both need
 * roughly 20 prior matches per team per venue before mx_team_form will let a
 * fixture be priced. Today that history exists for England and nowhere else —
 * not because the API withholds it, but because we have only ever stored what
 * fetchLiveStats.js happened to catch in-play. On 2026-08-05 that was 282 rows
 * covering 141 fixtures.
 *
 * The feed already returns Corner Kicks, Yellow Cards, Red Cards and REAL
 * expected_goals for every league we cover. This is the loop that goes and gets
 * the history, so the paper-trade clock starts everywhere at once instead of
 * accruing half a season per team.
 *
 * RUN backfillSeasonFixtures.js FIRST — this is not optional
 * match_stats keys on the API-Football fixture id, so a fixture is only
 * reachable here if `matches` holds it with a NUMERIC external_id. Rows seeded
 * from the football-data CSVs (stats_source='datahub_csv') and StatsBomb carry
 * prefixed ids the API knows nothing about, and they are the entire historical
 * corpus. So the sequence is:
 *
 *     node backfillSeasonFixtures.js --seasons 2024,2025   # ~40 calls/season
 *     node backfillMatchStats.js    --seasons 2024,2025    # ~1 call/fixture
 *
 * The preflight below counts what it can actually see and says so loudly when
 * a season window is empty, because "0 fixtures to fetch" and "this league has
 * no corner data" look identical in a log and mean opposite things.
 *
 * COST
 * One /fixtures/statistics call per fixture — there is no bulk form. Forty
 * leagues × one season ≈ 14k fixtures ≈ 14k calls, against the 75k/day Ultra
 * allowance shared with odds ingestion and the live loop. So the run is
 * budgeted (--max-calls), paced (--rpm), and fully resumable: it skips any
 * fixture that already has stats, so re-running only fetches what is left.
 *
 * WHAT IT WRITES
 * The raw statistics array per team side into match_stats (fixture_id,
 * team_side) — byte-identical in shape to what fetchLiveStats.js and
 * fetchMatchDetails.js write, so downstream has one contract to read and
 * migration 051's mx_refresh_team_match() picks it up with no changes.
 *
 * A fixture the API has no statistics for is recorded as an EMPTY array rather
 * than left absent, so it is not re-queried on every future run. That marker
 * costs one row and saves a call a day forever; --refetch-empty overrides it if
 * the API backfills its own history later.
 *
 * Usage:
 *   node backfillMatchStats.js                            # last two seasons
 *   node backfillMatchStats.js --seasons 2024,2025,2026
 *   node backfillMatchStats.js --leagues epl,e1           # corpus keys
 *   node backfillMatchStats.js --max-calls 5000 --rpm 240
 *   node backfillMatchStats.js --dry-run                  # plan only, no calls
 *   node backfillMatchStats.js --refetch-empty
 */
'use strict';

const { getClient }          = require('./lib/supabaseClient');
const { httpGet }            = require('./lib/httpClient');
const { trackedLeagues }     = require('./lib/trackedLeagues');
const { currentSeasonYear }  = require('./backfillSeasonFixtures');

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
const MAX_CALLS     = num('--max-calls', parseInt(process.env.MATCH_STATS_MAX_CALLS || '15000', 10));
const RPM           = num('--rpm',       parseInt(process.env.MATCH_STATS_RPM       || '240',   10));
const CONCURRENCY   = num('--concurrency', parseInt(process.env.MATCH_STATS_CONCURRENCY || '4', 10));
const PAGE          = 1000;   // Supabase read page size
const WRITE_CHUNK   = 500;    // rows per upsert

/**
 * The stat types the models actually consume. Everything the API sends is
 * stored verbatim; these are only what the coverage report counts, because
 * "we have stats for this league" and "we have the stats the cards model needs"
 * are different claims and the second is the one that gates a prediction.
 */
const KEY_STATS = {
  corners: 'Corner Kicks',
  yellows: 'Yellow Cards',
  reds:    'Red Cards',
  sot:     'Shots on Goal',
  xg:      'expected_goals',
};

// ── Pure helpers (unit-tested in engine.matchstats.test.js) ──────────────────

/**
 * API-Football labels a season by its START year, and a season runs roughly
 * July → June. The window is deliberately generous at both ends: play-offs and
 * rescheduled fixtures routinely fall outside the nominal season, and a fixture
 * missed here is a permanent hole in a team's rolling form.
 */
function seasonWindow(startYear) {
  return { from: `${startYear}-07-01`, to: `${startYear + 1}-06-30` };
}

/** Merge season windows into one [from, to] span — one query, not N. */
function spanOf(seasons) {
  const windows = seasons.map(seasonWindow);
  return {
    from: windows.map(w => w.from).sort()[0],
    to:   windows.map(w => w.to).sort().at(-1),
  };
}

/**
 * Only fixtures with a numeric external_id can be joined to the API. The CSV
 * and StatsBomb seeds use prefixed ids, and asking the API about 'datahub_1234'
 * burns a call to be told nothing.
 */
function isApiFixtureId(externalId) {
  return typeof externalId === 'string' ? /^\d+$/.test(externalId)
       : Number.isInteger(externalId) && externalId > 0;
}

/**
 * API-Football answers some failures with HTTP 200 and an `errors` payload —
 * a season the plan does not cover comes back as an EMPTY response with an
 * error string, indistinguishable from "no statistics recorded" unless you
 * read it. Returns the error strings, or [] when the response is clean.
 */
function apiErrors(json) {
  const errs = json?.errors;
  if (!errs) return [];
  return (Array.isArray(errs) ? errs : Object.values(errs)).map(String).filter(Boolean);
}

/** Loose team-name comparison — the API's wording drifts ("Man City" / "Manchester City"). */
function normaliseName(s) {
  return String(s ?? '').toLowerCase().normalize('NFKD')
    .replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]+/g, '');
}

/**
 * Decide which block of a /fixtures/statistics response is home and which is
 * away.
 *
 * The API returns [home, away] and every other script in this repo takes that
 * on trust. Over a 30,000-fixture backfill that trust is worth checking, and it
 * is free to check: we know both team names from `matches`, and each block
 * carries `team.name`. So orient by name when the names agree, and fall back to
 * response order when they do not (a renamed club, a B-team, a name we never
 * normalised). The fallback is the old behaviour, so this can only improve on
 * it — but it reports which path it took, so a league where naming is
 * systematically broken shows up as a number rather than as quietly transposed
 * corner counts.
 *
 * @returns {{sides: {side:'home'|'away', stats: unknown[]}[], byName: boolean}|null}
 */
function orientSides(response, homeName, awayName) {
  const blocks = Array.isArray(response) ? response.filter(Boolean) : [];
  if (!blocks.length) return null;

  const h = normaliseName(homeName), a = normaliseName(awayName);
  if (blocks.length === 2 && h && a) {
    const n0 = normaliseName(blocks[0]?.team?.name);
    const n1 = normaliseName(blocks[1]?.team?.name);
    const hit = (x, y) => Boolean(x && y) && (x.includes(y) || y.includes(x));
    if (hit(n0, h) && hit(n1, a)) {
      return { sides: [{ side: 'home', stats: blocks[0].statistics ?? [] },
                        { side: 'away', stats: blocks[1].statistics ?? [] }], byName: true };
    }
    if (hit(n0, a) && hit(n1, h)) {
      return { sides: [{ side: 'away', stats: blocks[0].statistics ?? [] },
                        { side: 'home', stats: blocks[1].statistics ?? [] }], byName: true };
    }
  }

  const sides = [{ side: 'home', stats: blocks[0].statistics ?? [] }];
  if (blocks[1]) sides.push({ side: 'away', stats: blocks[1].statistics ?? [] });
  return { sides, byName: false };
}

/**
 * Which of the model-critical stats a fixture actually reported. A `type` that
 * is present with a null value counts as ABSENT: the cards model treating a
 * missing "Yellow Cards" entry as a 0-card game is the same error fetchTeamStats
 * had to guard against, and it roughly halves a league's card average.
 */
function coverageOf(sides) {
  const present = new Set();
  for (const { stats } of sides ?? []) {
    for (const s of stats ?? []) {
      if (s?.value == null) continue;
      present.add(String(s.type));
    }
  }
  const out = {};
  for (const [key, type] of Object.entries(KEY_STATS)) out[key] = present.has(type);
  return out;
}

/** Rows for match_stats, in the shape fetchLiveStats already writes. */
function statRows(fixtureId, sides, at = new Date().toISOString()) {
  return (sides ?? []).map(({ side, stats }) => ({
    fixture_id: String(fixtureId),
    team_side:  side,
    stats:      stats ?? [],
    fetched_at: at,
  }));
}

// ── Pacing ──────────────────────────────────────────────────────────────────

const sleep = ms => new Promise(r => setTimeout(r, ms));

/**
 * A calls-per-minute limiter. API-Football's per-day allowance is the headline
 * limit but the per-minute one is what actually 429s a tight loop, and a 429
 * storm mid-backfill wastes the quota it is trying to protect.
 */
function rateLimiter(perMinute) {
  const times = [];
  return async function take() {
    for (;;) {
      const now = Date.now();
      while (times.length && now - times[0] >= 60_000) times.shift();
      if (times.length < perMinute) { times.push(now); return; }
      await sleep(60_000 - (now - times[0]) + 25);
    }
  };
}

// ── Data access ─────────────────────────────────────────────────────────────

/** Every page of a Supabase select, so a 30k-row window is not silently capped at 1,000. */
async function selectAll(query, describe) {
  const out = [];
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await query().range(from, from + PAGE - 1);
    if (error) throw new Error(`${describe}: ${error.message}`);
    out.push(...(data ?? []));
    if (!data || data.length < PAGE) return out;
  }
}

/** Finished fixtures in the window that the API can be asked about. */
async function candidateFixtures(supabase, span) {
  const rows = await selectAll(() => supabase
    .from('matches')
    .select('id, external_id, league_id, home_team_id, away_team_id, kickoff_at')
    .not('external_id', 'is', null)
    .not('goals_home', 'is', null)
    .gte('kickoff_at', `${span.from}T00:00:00Z`)
    .lte('kickoff_at', `${span.to}T23:59:59Z`)
    .order('kickoff_at', { ascending: false }), 'matchStats[candidates]');
  return rows.filter(r => isApiFixtureId(r.external_id));
}

/**
 * Fixture ids that already carry stats, so a re-run costs nothing for them.
 *
 * Selects the id and NOT the payload: at 30k fixtures the stats arrays are tens
 * of megabytes, and all we need to know is whether a row exists. An empty array
 * is our "we asked, the API had nothing" marker and counts as covered — that is
 * what stops the same barren fixture costing a call a day forever. --refetch-
 * empty pushes the exclusion into the query so those ids come back uncovered.
 */
async function alreadyCovered(supabase, fixtureIds, { refetchEmpty }) {
  const covered = new Set();
  const ids = [...fixtureIds];
  for (let i = 0; i < ids.length; i += WRITE_CHUNK) {
    const chunk = ids.slice(i, i + WRITE_CHUNK);
    let q = supabase.from('match_stats').select('fixture_id').in('fixture_id', chunk);
    if (refetchEmpty) q = q.not('stats', 'eq', '[]');
    const { data, error } = await q;
    if (error) throw new Error(`matchStats[covered]: ${error.message}`);
    for (const r of data ?? []) covered.add(String(r.fixture_id));
  }
  return covered;
}

async function nameMap(supabase, table, describe) {
  const rows = await selectAll(() => supabase.from(table).select('id, name'), describe);
  return new Map(rows.map(r => [r.id, r.name]));
}

async function leagueMap(supabase) {
  const rows = await selectAll(() => supabase.from('leagues').select('id, name, country'),
                               'matchStats[leagues]');
  return new Map(rows.map(r => [r.id, `${r.name} (${r.country ?? '—'})`]));
}

async function flushRows(supabase, rows) {
  for (let i = 0; i < rows.length; i += WRITE_CHUNK) {
    const { error } = await supabase
      .from('match_stats')
      .upsert(rows.slice(i, i + WRITE_CHUNK), { onConflict: 'fixture_id,team_side' });
    if (error) throw new Error(`matchStats[upsert @${i}]: ${error.message}`);
  }
}

// ── The run ─────────────────────────────────────────────────────────────────

function fetchStatistics(fixtureId) {
  return httpGet({
    host: API_HOST,
    path: `/fixtures/statistics?fixture=${fixtureId}`,
    headers: { 'x-apisports-key': API_KEY },
  });
}

/** Per-league tallies, so the report can name which leagues earned a prediction. */
function tally(report, leagueId, field) {
  const r = report.get(leagueId) ?? {
    fetched: 0, empty: 0, failed: 0, byName: 0,
    corners: 0, yellows: 0, reds: 0, sot: 0, xg: 0,
  };
  r[field]++;
  report.set(leagueId, r);
}

async function main() {
  if (!API_KEY && !DRY) {
    console.log('[matchStats] API_FOOTBALL_KEY not set — aborting');
    process.exit(1);
  }

  const seasons = (flag('--seasons', flag('--season', '')) || '')
    .split(',').map(s => parseInt(s.trim(), 10)).filter(Number.isFinite);
  const resolved = seasons.length
    ? seasons
    : [currentSeasonYear(), currentSeasonYear() - 1];   // "the last two seasons"
  const span = spanOf(resolved);

  const onlyKeys = flag('--leagues', '').split(',').map(s => s.trim()).filter(Boolean);
  const wantedNames = onlyKeys.length
    ? new Set(trackedLeagues(process.env)
        .filter(l => onlyKeys.includes(l.corpusKey ?? l.name))
        .map(l => `${l.name} (${l.country})`))
    : null;

  console.log(`[matchStats] seasons ${resolved.sort().join(', ')} → ${span.from} .. ${span.to}`);

  const supabase = getClient();
  const [leagues, teams] = await Promise.all([leagueMap(supabase), nameMap(supabase, 'teams', 'matchStats[teams]')]);

  let candidates = await candidateFixtures(supabase, span);
  if (wantedNames) candidates = candidates.filter(m => wantedNames.has(leagues.get(m.league_id)));

  // ── Preflight. "Nothing to fetch" has two very different causes. ──────────
  if (!candidates.length) {
    console.log(`[matchStats] no finished fixtures with an API fixture id in this window.`);
    console.log(`[matchStats] Rows seeded from the CSV corpus and StatsBomb carry prefixed`);
    console.log(`             external_ids the API cannot resolve, so they are invisible here`);
    console.log(`             by design. Load real season calendars first:`);
    console.log(`               node backfillSeasonFixtures.js --seasons ${resolved.join(',')}`);
    return;
  }

  const covered = await alreadyCovered(supabase, candidates.map(m => String(m.external_id)),
                                       { refetchEmpty: REFETCH_EMPTY });
  const todo = candidates.filter(m => !covered.has(String(m.external_id)));

  console.log(`[matchStats] ${candidates.length} finished fixture(s) in window · ` +
              `${covered.size} already have stats · ${todo.length} to fetch`);
  console.log(`[matchStats] budget ${MAX_CALLS} call(s), ${RPM}/min, concurrency ${CONCURRENCY}` +
              (todo.length > MAX_CALLS
                ? ` — capped, ${todo.length - MAX_CALLS} left for the next run (resumable)`
                : ''));

  if (DRY) {
    const byLeague = new Map();
    for (const m of todo) byLeague.set(m.league_id, (byLeague.get(m.league_id) ?? 0) + 1);
    console.log(`\n[matchStats] would fetch, by league:`);
    for (const [id, n] of [...byLeague.entries()].sort((a, b) => b[1] - a[1])) {
      console.log(`   ${String(n).padStart(6)}  ${leagues.get(id) ?? `league ${id}`}`);
    }
    return;
  }

  const queue  = todo.slice(0, MAX_CALLS);
  const take   = rateLimiter(RPM);
  const report = new Map();
  let calls = 0, written = 0, empties = 0, failures = 0, stopped = null;
  let pending = [];
  let cursor = 0;

  async function worker() {
    for (;;) {
      if (stopped) return;
      const m = queue[cursor++];
      if (!m) return;

      await take();
      calls++;
      try {
        const json = await fetchStatistics(m.external_id);
        const errs = apiErrors(json);
        if (errs.length) throw new Error(`API error: ${errs.join('; ')}`);

        const oriented = orientSides(json.response,
                                     teams.get(m.home_team_id), teams.get(m.away_team_id));
        if (!oriented) {
          // No statistics for this fixture. Record the fact so we never ask again.
          pending.push(...statRows(m.external_id,
                                   [{ side: 'home', stats: [] }, { side: 'away', stats: [] }]));
          empties++;
          tally(report, m.league_id, 'empty');
        } else {
          pending.push(...statRows(m.external_id, oriented.sides));
          tally(report, m.league_id, 'fetched');
          if (oriented.byName) tally(report, m.league_id, 'byName');
          const cov = coverageOf(oriented.sides);
          for (const k of Object.keys(KEY_STATS)) if (cov[k]) tally(report, m.league_id, k);
        }
      } catch (e) {
        failures++;
        tally(report, m.league_id, 'failed');
        if (/quota|exceeded|429/i.test(e.message)) {
          console.log(`[matchStats] rate limited or out of quota — stopping cleanly. ` +
                      `Re-run to continue; nothing already fetched is refetched.`);
          stopped = 'quota';
          return;
        }
        if (failures <= 20) console.log(`  warn fixture ${m.external_id}: ${e.message}`);
      }

      if (pending.length >= WRITE_CHUNK * 2) {
        const batch = pending; pending = [];
        await flushRows(supabase, batch);
        written += batch.length;
        console.log(`[matchStats] ${cursor}/${queue.length} fetched · ${written} row(s) written`);
      }
    }
  }

  await Promise.all(Array.from({ length: Math.max(1, CONCURRENCY) }, worker));
  if (pending.length) { await flushRows(supabase, pending); written += pending.length; }

  // ── Report. Per league, which markets this run made predictable. ──────────
  console.log(`\n[matchStats] ${calls} call(s) → ${written} row(s) written · ` +
              `${empties} fixture(s) with no statistics · ${failures} failure(s)`);

  if (report.size) {
    console.log(`\n[matchStats] STAT COVERAGE BY LEAGUE (share of fetched fixtures that`);
    console.log(`             actually reported each metric — this is what decides whether`);
    console.log(`             mx_coverage can say READY rather than GOALS ONLY):\n`);
    console.log(`             fixtures  corners   cards      xG   league`);
    const pct = (n, d) => (d ? `${Math.round((100 * n) / d)}%` : '—').padStart(7);
    const rows = [...report.entries()].sort((a, b) => b[1].fetched - a[1].fetched);
    for (const [id, r] of rows) {
      if (!r.fetched) continue;
      console.log(`             ${String(r.fetched).padStart(8)}  ${pct(r.corners, r.fetched)}` +
                  `  ${pct(r.yellows, r.fetched)}  ${pct(r.xg, r.fetched)}   ` +
                  `${leagues.get(id) ?? `league ${id}`}`);
    }
    const transposed = rows.reduce((n, [, r]) => n + (r.fetched - r.byName), 0);
    if (transposed) {
      console.log(`\n[matchStats] ${transposed} fixture(s) could not be oriented by team name and`);
      console.log(`             fell back to the API's [home, away] ordering. That is the same`);
      console.log(`             assumption fetchLiveStats makes, so it is no worse — but a large`);
      console.log(`             number here means team naming has drifted in some league and the`);
      console.log(`             home/away split is worth spot-checking before trusting its form.`);
    }
  }

  const remaining = todo.length - queue.length + (stopped ? queue.length - cursor : 0);
  if (remaining > 0) {
    console.log(`\n[matchStats] ${remaining} fixture(s) still to do — re-run to continue.`);
  }
  console.log(`\n[matchStats] next: refresh the derived views so this lands in the models —`);
  console.log(`             select * from public.mx_refresh_team_match();`);
  console.log(`             refresh materialized view public.mx_team_form;`);
  console.log(`             refresh materialized view public.mx_referee_form;`);
  console.log(`             select * from public.mx_coverage;`);

  // A run where every single call failed produced nothing and must not leave a
  // green check over an empty table — that is exactly how the `page` regression
  // shipped in backfillSeasonFixtures. Partial failures stay warnings.
  if (calls > 0 && failures === calls && !stopped) {
    console.error(`\n[matchStats] FATAL: all ${calls} call(s) failed — nothing loaded.`);
    process.exit(1);
  }
}

if (require.main === module) {
  main().catch(err => { console.error('[matchStats] FATAL:', err.message); process.exit(1); });
}

module.exports = {
  seasonWindow, spanOf, isApiFixtureId, apiErrors, normaliseName,
  orientSides, coverageOf, statRows, rateLimiter, KEY_STATS,
};
