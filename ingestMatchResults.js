'use strict';

/**
 * ingestMatchResults.js — keep `match_results` current as the season plays.
 *
 * WHAT WAS WRONG. `match_results` holds 77,438 settled English matches with the
 * closing prices they went off at, and it is the entire source of the edge
 * league table on `/leagues`. Nothing in this repo had ever written to it. It
 * was loaded once by hand — the last row was created on 16 Jul 2026 and the
 * latest result in it is 24 May 2026 — so on 20 Aug 2026, with 2026/27 already
 * under way, the newest season the product could show was the one that had
 * finished in May. Waiting would not have fixed it: there was no writer to wait
 * for.
 *
 * `ensemble/scrapers/refresh_football_data.py` looks like it does this job and
 * does not. It downloads the same CSVs into `ensemble/data/_current/` for the
 * λ model's training corpus and never touches the database. Two different
 * consumers of one feed; only one of them was being fed.
 *
 * ENGLAND ONLY, BECAUSE THAT IS WHAT THE TABLE HOLDS. E0, E1, E2, E3 and EC are
 * the only divisions `match_results` has ever contained, and `/leagues` says so
 * on the surface — "the English pyramid only", with the reason. Ingesting the
 * other seventeen divisions football-data publishes would quietly make that
 * sentence false and put divisions on the season picker that the page can only
 * render as raw codes. Widening the corpus is a product decision with its own
 * copy to write, not a side effect of fixing the writer.
 *
 * IDEMPOTENT BY CONSTRUCTION. football-data rewrites the whole current-season
 * file every time it updates, so every run re-reads matches already stored.
 * `match_results_unique (country, div, match_date, home_team, away_team)` is
 * the natural key and the upsert targets it, so a re-run refreshes rows rather
 * than duplicating them — which matters because the file gains columns as a
 * match settles: a row appears with prices and gains its result and stats later.
 *
 * IT NEVER DELETES. A short or truncated file does nothing at all rather than
 * removing what it does not mention. The failure mode of a bad fetch is a run
 * that reports zero, not a corpus that loses a season.
 *
 * `Number('')` IS 0, AND THAT IS THE BUG THIS FEED INVITES. Every one of these
 * files is mostly empty cells — a book that did not price a match leaves its
 * three columns blank — and coercing those to zero would store 0.00 as a quoted
 * price, which de-vigs to an infinite probability. `num()` returns null for
 * anything that is not a real number, and a null is omitted from the odds
 * object entirely rather than stored as a key with no value.
 */

const { httpGetText } = require('./lib/httpClient');
const { getClient } = require('./lib/supabaseClient');

const HOST = 'www.football-data.co.uk';

/**
 * The divisions this table holds, and the country each belongs to.
 * `country` is NOT NULL on the table and is half of its unique key.
 */
const DIVISIONS = [
  { div: 'E0', country: 'England' },
  { div: 'E1', country: 'England' },
  { div: 'E2', country: 'England' },
  { div: 'E3', country: 'England' },
  { div: 'EC', country: 'England' },
  // THE BIG FIVE, added 24 Aug 2026 to unblock /leagues. The top flight only,
  // and the second tiers (SP2, D2, I2, F2) are deliberately NOT taken: they
  // double the division rail for leagues most readers cannot sanity-check, and
  // a reader's own sense of who is good is the only external validation an
  // unpriced table gets. Nothing in the arithmetic ever sees a reputation.
  //
  // EQUAL SEASONS ARE LOAD-BEARING, not tidiness. `beyondChanceBar(n)` on
  // /leagues corrects for how many clubs are being tested, so a division with a
  // shorter record sitting beside a full one is judged on a different weight of
  // evidence under one shared threshold. Backfill every new division across the
  // same seasons England holds — `--seasons` exists for that.
  { div: 'SP1', country: 'Spain' },
  { div: 'D1',  country: 'Germany' },
  { div: 'I1',  country: 'Italy' },
  { div: 'F1',  country: 'France' },
  { div: 'N1',  country: 'Netherlands' },
];

/** Upsert batch. A division-season is 380–552 rows; a PostgREST body that
 *  grows without bound is how this project has taken silent outages before. */
const CHUNK = 250;

/** Below this a response is an error page or a stub, never a season file. */
const MIN_BYTES = 200;

/* ── seasons ──────────────────────────────────────────────────────────────── */

/**
 * football-data's season code for a date: Aug 2026 → '2627', Feb 2027 → '2627'.
 *
 * The rollover is JULY, not January. A season file is published from late July,
 * so anything from July onward belongs to the season that is starting; June and
 * earlier belong to the one that just finished.
 */
function seasonCode(date) {
  const y = date.getUTCFullYear();
  const startYear = date.getUTCMonth() >= 6 ? y : y - 1;
  const two = n => String(n % 100).padStart(2, '0');
  return `${two(startYear)}${two(startYear + 1)}`;
}

/** '2627' → '2026/27', the label `match_results.season` already uses. */
function seasonLabel(code) {
  if (!/^\d{4}$/.test(code)) throw new Error(`bad season code: ${code}`);
  const start = Number(code.slice(0, 2));
  // The corpus starts in 1993, so a two-digit year below 90 is 20xx.
  const century = start >= 90 ? 1900 : 2000;
  return `${century + start}/${code.slice(2)}`;
}

/* ── parsing ──────────────────────────────────────────────────────────────── */

/**
 * A number, or null.
 *
 * Deliberately NOT `Number(x)`. `Number('')` is 0 and these files are mostly
 * empty cells; a zero standing in for an absent price would be de-vigged as a
 * real one downstream.
 */
function num(v) {
  if (v == null) return null;
  const s = String(v).trim();
  if (s === '') return null;
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
}

/** An integer, or null. Same rule, for goals and cards. */
function int(v) {
  const n = num(v);
  return n == null ? null : Math.trunc(n);
}

/** A trimmed string, or null for an empty cell. */
function str(v) {
  if (v == null) return null;
  const s = String(v).trim();
  return s === '' ? null : s;
}

/**
 * `dd/mm/yyyy` or `dd/mm/yy` → `YYYY-MM-DD`.
 *
 * Parsed by hand rather than with `new Date(s)`, which reads 03/08/2026 as
 * 8 March in a US locale and would file a third of every season in the wrong
 * month without failing. Returns null on anything that is not a date, so a
 * trailing blank line is dropped rather than stored as an epoch.
 */
function parseDate(value) {
  const s = str(value);
  if (!s) return null;
  const m = /^(\d{1,2})\/(\d{1,2})\/(\d{2}|\d{4})$/.exec(s);
  if (!m) return null;
  const day = Number(m[1]);
  const month = Number(m[2]);
  let year = Number(m[3]);
  if (m[3].length === 2) year += year >= 90 ? 1900 : 2000;
  if (day < 1 || day > 31 || month < 1 || month > 12) return null;
  const iso = `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
  return iso;
}

/**
 * Split one CSV line, honouring double-quoted fields.
 *
 * football-data rarely quotes anything, but a referee with a comma in the name
 * would silently shift every column after it — and the columns after Referee
 * are the prices.
 */
function splitLine(line) {
  const out = [];
  let cur = '';
  let quoted = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (quoted) {
      if (c === '"') {
        if (line[i + 1] === '"') { cur += '"'; i++; } else quoted = false;
      } else cur += c;
    } else if (c === '"') {
      quoted = true;
    } else if (c === ',') {
      out.push(cur); cur = '';
    } else cur += c;
  }
  out.push(cur);
  return out;
}

/** The fixed columns, by their football-data header name. Everything NOT in
 *  here is a price and goes to the `odds` object. */
const COLUMN = {
  Div: 'div', Date: null, Time: 'match_time',
  HomeTeam: 'home_team', AwayTeam: 'away_team',
  FTHG: 'fthg', FTAG: 'ftag', FTR: 'ftr',
  HTHG: 'hthg', HTAG: 'htag', HTR: 'htr',
  Referee: 'referee',
  HS: 'hs', AS: 'as_', HST: 'hst', AST: 'ast',
  HF: 'hf', AF: 'af', HC: 'hc', AC: 'ac',
  HY: 'hy', AY: 'ay', HR: 'hr', AR: 'ar',
};
/** A match cannot exist without these, and an error page has none of them. */
const REQUIRED_COLUMNS = ['Div', 'Date', 'HomeTeam', 'AwayTeam'];

const INT_COLUMNS = new Set([
  'fthg', 'ftag', 'hthg', 'htag', 'hs', 'as_', 'hst', 'ast',
  'hf', 'af', 'hc', 'ac', 'hy', 'ay', 'hr', 'ar',
]);

/**
 * A whole season file → rows shaped for `match_results`.
 *
 * Order-independent: columns are read by header name, because football-data has
 * reordered and added columns between seasons and will again.
 *
 * A row with no date or no teams is DROPPED — that is a trailing blank line,
 * not a match. A row with no RESULT is KEPT: the file lists a fixture as soon
 * as it is priced, and the row gains its result on a later run. The edge table
 * filters on `ftr` itself, so an unplayed row is invisible until it settles.
 */
function parseSeasonCsv(text, { div, country, season, sourceFile }) {
  // STRIP THE BYTE-ORDER MARK FIRST. Every file football-data serves begins
  // with EF BB BF, so the first header parses as "\uFEFFDiv" and the
  // required-column check below rejects the whole file — every division, every
  // run, with a message blaming the feed for not being a season file. Found by
  // parsing a real 2026/27 file rather than a fixture, which is the only way it
  // could have been found.
  const body = String(text ?? '').replace(/^\uFEFF/, '');
  const lines = body.split(/\r?\n/).filter(l => l.trim() !== '');
  if (lines.length === 0) return { rows: [], skipped: 0 };

  // THE GUARD IS "HAS THE COLUMNS", NOT "STARTS WITH Div". Requiring Div FIRST
  // would refuse a file whose columns were reordered — and this parser reads by
  // name precisely so a reorder is survivable, which football-data has done
  // before. Requiring the four columns a match cannot exist without still
  // refuses the thing the guard is actually for: an HTML error page served with
  // a 200, which has none of them.
  const header = splitLine(lines[0]).map(h => h.trim());
  const missing = REQUIRED_COLUMNS.filter(c => !header.includes(c));
  if (missing.length) {
    throw new Error(
      `not a football-data season file — missing ${missing.join(', ')} `
      + `(first column is "${header[0]}")`,
    );
  }

  // A valid header and no matches is a real state: the file is published before
  // the season's first kickoff. Nothing to store, nothing wrong.
  if (lines.length < 2) return { rows: [], skipped: 0 };

  const rows = [];
  let skipped = 0;

  for (let i = 1; i < lines.length; i++) {
    const cells = splitLine(lines[i]);
    const record = {};
    for (let c = 0; c < header.length; c++) {
      if (header[c] !== '') record[header[c]] = cells[c];
    }

    const matchDate = parseDate(record.Date);
    const home = str(record.HomeTeam);
    const away = str(record.AwayTeam);
    if (!matchDate || !home || !away) { skipped++; continue; }

    const row = {
      div: str(record.Div) ?? div,
      country,
      season,
      match_date: matchDate,
      home_team: home,
      away_team: away,
      source_file: sourceFile,
    };

    for (const [head, column] of Object.entries(COLUMN)) {
      if (!column || column === 'div') continue;
      const raw = record[head];
      row[column] = INT_COLUMNS.has(column) ? int(raw) : str(raw);
    }

    // Everything the fixed columns did not claim is a price.
    const odds = {};
    for (const head of Object.keys(record)) {
      if (head in COLUMN) continue;
      const n = num(record[head]);
      if (n != null) odds[head] = n;
    }
    row.odds = odds;

    rows.push(row);
  }

  return { rows, skipped };
}

/* ── writing ──────────────────────────────────────────────────────────────── */

async function upsertRows(rows) {
  const client = getClient();
  let written = 0;
  for (let i = 0; i < rows.length; i += CHUNK) {
    const batch = rows.slice(i, i + CHUNK);
    const { error } = await client
      .from('match_results')
      .upsert(batch, { onConflict: 'country,div,match_date,home_team,away_team' });
    // supabase-js RESOLVES with { error } rather than throwing, which is how
    // this project once shipped a payment path that reported success on every
    // failure. Check it, and stop the run rather than reporting a false count.
    if (error) throw new Error(`upsert failed at row ${i}: ${error.message}`);
    written += batch.length;
  }
  return written;
}

/**
 * Pull every `href` out of an Apache error page.
 *
 * mod_negotiation answers a MISSING file whose neighbours have a similar base
 * name with **300 Multiple Choices** and a list of what it did find — not a
 * 404. So a 300 here is not "the server is confused", it is "that exact name is
 * wrong and here are the near-misses", and the list is the diagnosis.
 */
function alternativesFrom(body) {
  const out = [];
  const re = /href="([^"]+)"/gi;
  let m;
  while ((m = re.exec(body)) !== null) out.push(m[1]);
  return out;
}

/**
 * Which of those near-misses is the season file we asked for.
 *
 * CASE IS THE WHOLE POINT. `E0.csv` and `E0.CSV` are one document to a reader
 * and two to a web server, and this is the one division of ten that differs —
 * so the rule has to be "the same name ignoring case", not a guess. It returns
 * null rather than picking when it cannot tell, because silently fetching a
 * DIFFERENT division's file would write one league's results under another's
 * name, and every row would look completely ordinary.
 */
function resolveAlternative(div, alternatives) {
  const basename = href => href.split('/').pop();
  const want = `${div}.csv`.toLowerCase();

  const exact = alternatives.find(h => basename(h).toLowerCase() === want);
  if (exact) return basename(exact);

  // Only when there is exactly ONE csv on offer — two means we are guessing.
  const csvs = alternatives.filter(h => basename(h).toLowerCase().endsWith('.csv'));
  return csvs.length === 1 ? basename(csvs[0]) : null;
}

async function fetchSeasonFile(code, div) {
  const get = path => httpGetText({
    host: HOST,
    path,
    headers: { 'User-Agent': 'maxedge-engine/1.0', Accept: 'text/csv,*/*' },
  });

  const path = `/mmz4281/${code}/${div}.csv`;
  try {
    return { text: await get(path), path };
  } catch (err) {
    if (err.status !== 300) throw err;

    // 24 Aug 2026: E0 — the Premier League, the single most-read division on
    // /leagues — 300ed on this path while E1, E2, E3 and EC all succeeded on
    // the identical pattern, so the whole 2026/27 top flight was missing from a
    // run that reported success. Resolve it from the server's own list rather
    // than hard-coding whatever spelling is right today.
    const options = alternativesFrom(err.body ?? err.message);
    const name = resolveAlternative(div, options);
    if (!name) {
      err.message =
        `HTTP 300 and no unambiguous alternative for ${div}.csv `
        + `(offered: ${options.join(', ') || 'nothing parseable'})`;
      throw err;
    }

    const retryPath = `/mmz4281/${code}/${name}`;
    console.log(`  ${div}  —  300 Multiple Choices, retrying as ${name}`);
    return { text: await get(retryPath), path: retryPath };
  }
}

/* ── the run ──────────────────────────────────────────────────────────────── */

async function run({ code, dryRun } = {}) {
  const seasonCodeToUse = code ?? seasonCode(new Date());
  const season = seasonLabel(seasonCodeToUse);
  console.log(`match_results ingest — season ${season} (${seasonCodeToUse})${dryRun ? ' — DRY RUN' : ''}`);

  let totalRows = 0;
  let totalWritten = 0;
  const problems = [];
  const notStarted = [];

  for (const { div, country } of DIVISIONS) {
    let text;
    let path;
    try {
      ({ text, path } = await fetchSeasonFile(seasonCodeToUse, div));
    } catch (err) {
      // A 404 IS NOT A FAILURE, and the difference decides whether this run is
      // red. The English divisions start on different weekends, so through July
      // and early August a season file genuinely does not exist yet — that is
      // "nothing to ingest", and it must not read the same as "the host is
      // unreachable". Three features in this codebase shipped silently dead
      // because nothing separated those two.
      const missing = err.status === 404;
      (missing ? notStarted : problems).push(
        missing ? `${div}: no season file published yet` : `${div}: fetch failed — ${err.message}`,
      );
      console.log(missing
        ? `  ${div}  —  no season file published yet`
        : `  ${div}  —  FETCH FAILED: ${err.message.slice(0, 90)}`);
      continue;
    }

    if (!text || text.length < MIN_BYTES) {
      problems.push(`${div}: response too small (${text ? text.length : 0} bytes)`);
      console.log(`  ${div}  —  file too small to be a season (${text ? text.length : 0} bytes)`);
      continue;
    }

    let parsed;
    try {
      parsed = parseSeasonCsv(text, { div, country, season, sourceFile: path });
    } catch (err) {
      problems.push(`${div}: parse failed — ${err.message}`);
      console.log(`  ${div}  —  parse failed: ${err.message}`);
      continue;
    }

    const { rows, skipped } = parsed;
    const played = rows.filter(r => r.ftr != null).length;
    totalRows += rows.length;

    if (dryRun) {
      console.log(`  ${div}  ${String(rows.length).padStart(4)} rows  ${played} played  ${skipped} skipped  (dry run)`);
      continue;
    }

    const written = await upsertRows(rows);
    totalWritten += written;
    console.log(`  ${div}  ${String(rows.length).padStart(4)} rows  ${played} played  ${skipped} skipped  → ${written} upserted`);
  }

  console.log(`\n${totalRows} rows parsed, ${totalWritten} upserted across ${DIVISIONS.length} divisions.`);

  if (notStarted.length) {
    console.log(`\n${notStarted.length} division(s) have not started yet:`);
    for (const p of notStarted) console.log(`  · ${p}`);
  }
  if (problems.length) {
    console.log(`\n${problems.length} division(s) FAILED:`);
    for (const p of problems) console.log(`  · ${p}`);
  }

  // A run where every division is simply unpublished is a correct run in July.
  // A run where every division ERRORED is an outage and must go red — a silent
  // zero here would leave the corpus frozen with nothing to notice it.
  if (problems.length && problems.length + notStarted.length === DIVISIONS.length) {
    throw new Error(
      `no division returned a usable season file (${problems.length} failed, `
      + `${notStarted.length} not yet published)`,
    );
  }
  return { season, totalRows, totalWritten, problems, notStarted };
}

/**
 * Run several seasons in one go.
 *
 * WHY THIS EXISTS. A new division is not usable on /leagues until it holds the
 * same seasons the others do — `beyondChanceBar(n)` corrects for how many clubs
 * are on the table, so an unequal record is judged on an unequal weight of
 * evidence under one shared bar. Adding five divisions therefore means loading
 * seven seasons of each, and eight hand-dispatched runs is how one gets missed.
 *
 * A season that fails ENTIRELY is recorded and the walk continues, because the
 * common cause is a division that did not exist that year rather than an
 * outage. It throws only when EVERY season failed — a silent zero across the
 * whole backfill would leave the corpus frozen with nothing to notice it.
 */
async function runSeasons({ codes, dryRun } = {}) {
  const list = (codes ?? []).filter(Boolean);
  if (list.length <= 1) return run({ code: list[0], dryRun });

  const done = [];
  const failed = [];
  for (const code of list) {
    try {
      done.push(await run({ code, dryRun }));
    } catch (err) {
      failed.push(`${seasonLabel(code)} (${code}): ${err.message}`);
      console.log(`\n  season ${code} FAILED — ${err.message}`);
    }
  }

  const rows = done.reduce((n, r) => n + r.totalRows, 0);
  const written = done.reduce((n, r) => n + r.totalWritten, 0);
  console.log(`\n═══ ${list.length} seasons: ${rows} rows parsed, ${written} upserted ═══`);
  if (failed.length) {
    console.log(`\n${failed.length} season(s) failed outright:`);
    for (const f of failed) console.log(`  · ${f}`);
  }
  if (!done.length) throw new Error(`every season failed (${list.length} attempted)`);
  return { seasons: done, failed, totalRows: rows, totalWritten: written };
}

module.exports = {
  run, runSeasons, parseSeasonCsv, seasonCode, seasonLabel, parseDate, splitLine,
  num, int, DIVISIONS, COLUMN, REQUIRED_COLUMNS,
  alternativesFrom, resolveAlternative,
};

if (require.main === module) {
  const args = process.argv.slice(2);
  const valueOf = flag => (args.find(a => a.startsWith(`${flag}=`)) ?? '').split('=')[1];
  const codes = (valueOf('--seasons') ?? valueOf('--season') ?? '')
    .split(',').map(c => c.trim()).filter(Boolean);

  runSeasons({ codes, dryRun: args.includes('--dry-run') })
    .then(() => process.exit(0))
    .catch(err => { console.error(`✗ ${err.message}`); process.exit(1); });
}
